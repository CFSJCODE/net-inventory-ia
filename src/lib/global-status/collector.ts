import type { Prisma, StatusService } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { DEFAULT_INTERVAL_SEC, STATUS_CATALOG, type CatalogEntry } from "./catalog";
import { parseStatuspageSummary, statuspageVersion, type SpSummary } from "./adapters/statuspage";
import { parseGcpIncidents } from "./adapters/gcp";
import { parseAzureRss } from "./adapters/azure-rss";
import { decodeAwsBody, parseAwsEvents } from "./adapters/aws";
import { iodaAlertsUrl, parseIodaAlerts, type IodaAlertsResponse } from "./adapters/ioda";
import { bgpSnapshot } from "./adapters/ripestat";
import { collectRoutes, ispLabel, resolveIsp } from "./internet-signals";
import { getGlobalStatusSettings } from "./settings";
import { notifyStatusChanges } from "./status-alerts";
import { CLEARED_TARGET_DATA, endpointChanged, probesEnabled, unsourcedServiceData } from "./probe-logic";
import { combineStatus, type OfficialSnapshot, type ServiceStatus } from "./types";
import { serialized } from "./write-queue";

/**
 * Coletor do status oficial dos serviços globais. Roda em segundo plano (instrumentation), no mesmo
 * padrão do monitor de ligações: um timer por processo e uma rodada por vez.
 *
 * Frequências (bem abaixo de qualquer limite dos provedores):
 * - Statuspage: `status.json` (≈200 bytes) a cada 2 min; `summary.json` só quando a página muda
 *   (`page.updated_at`) ou a cada 10 min.
 * - Google Cloud, Firebase, Azure e AWS: a cada 5 min, com ETag/Last-Modified (resposta 304 não baixa nada).
 * - IODA (Internet no Brasil e da sua operadora): a cada 10 min; os alertas têm minutos de atraso natural.
 * - RIPEstat (rotas BGP dos serviços): a cada hora; os dados do RIS mudam em horas.
 * Erro 429/5xx dobra o intervalo daquela fonte até 30 min; volta ao normal no primeiro sucesso.
 */

export const TICK_MS = 2 * 60_000;
const SUMMARY_MAX_AGE_MS = 10 * 60_000;
/** Intervalo mínimo das fontes que não são Statuspage (a Statuspage tem a consulta leve de 2 min). */
const SOURCE_INTERVAL_MS: Partial<Record<string, number>> = { GCP: 5 * 60_000, AZURE_RSS: 5 * 60_000, AWS: 5 * 60_000, IODA: 10 * 60_000, RIPESTAT: 60 * 60_000 };
const FORCED_ROUTES_MS = 10 * 60_000;
/** Marcador do catálogo no lugar do ASN: a operadora é descoberta pelo IP público do servidor. */
export const AUTO_ASN = "entityCode=auto";
const MAX_BACKOFF_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
/** Falhas seguidas até o card virar "Sem dados" (uma falha isolada mantém o último status). */
const FAILURES_TO_UNKNOWN = 3;
const USER_AGENT = "NetInventory-StatusMonitor/1.0 (+https://github.com/CFSJCODE/net-inventory-ia)";

interface SourceState {
  lastFetchAt: number;
  backoffMs: number;
  nextAllowedAt: number;
  failures: number;
}

const g = globalThis as typeof globalThis & {
  __globalStatusTimer?: NodeJS.Timeout;
  __globalStatusRun?: Promise<void>;
  __globalStatusSources?: Map<string, SourceState>;
};

function sourceState(slug: string): SourceState {
  g.__globalStatusSources ??= new Map();
  let s = g.__globalStatusSources.get(slug);
  if (!s) {
    s = { lastFetchAt: 0, backoffMs: 0, nextAllowedAt: 0, failures: 0 };
    g.__globalStatusSources.set(slug, s);
  }
  return s;
}

class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} em ${new URL(url).host}`);
  }
}

/**
 * GET com validação condicional. `version` é o que a resposta anterior devolveu: "etag:<valor>" vira
 * If-None-Match e "lm:<data>" vira If-Modified-Since (o Google e o Azure só mandam Last-Modified).
 */
async function get(url: string, version?: string | null): Promise<Response> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json, application/rss+xml, text/xml;q=0.9, */*;q=0.5" };
  if (version?.startsWith("etag:")) headers["if-none-match"] = version.slice(5);
  else if (version?.startsWith("lm:")) headers["if-modified-since"] = version.slice(3);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
  if (res.status !== 304 && !res.ok) throw new HttpError(res.status, url);
  return res;
}

/** Resultado de uma consulta: um snapshot novo, ou "nada mudou" (só atualiza a hora da checagem). */
type FetchResult = { kind: "snapshot"; snapshot: OfficialSnapshot; version: string | null } | { kind: "unchanged" };

/**
 * O provedor ainda não tem estado declarado gravado: antes da primeira consulta (null) ou depois de
 * falhas seguidas ("UNKNOWN"). O que conta é o estado oficial, não o status do card, que agora junta
 * as medições próprias.
 */
const officialUnknown = (service: StatusService) => !service.officialState || service.officialState === "UNKNOWN";

async function fetchStatuspage(service: StatusService, state: SourceState, force: boolean): Promise<FetchResult> {
  const base = service.sourceUrl!.replace(/\/$/, "");
  const fresh = Date.now() - state.lastFetchAt < SUMMARY_MAX_AGE_MS;
  // Saindo de "Sem dados" sempre baixa o summary: a versão guardada pode ser igual e o status ficaria preso.
  if (!force && fresh && service.sourceVersion && !officialUnknown(service)) {
    const light = (await (await get(`${base}/api/v2/status.json`)).json()) as SpSummary;
    if (statuspageVersion(light) === service.sourceVersion) return { kind: "unchanged" };
  }
  const summary = (await (await get(`${base}/api/v2/summary.json`)).json()) as SpSummary;
  state.lastFetchAt = Date.now();
  return { kind: "snapshot", snapshot: parseStatuspageSummary(summary), version: statuspageVersion(summary) };
}

async function fetchWithEtag(
  service: StatusService,
  url: string,
  parse: (body: string) => OfficialSnapshot,
  decode: (res: Response) => Promise<string> = (res) => res.text(),
): Promise<FetchResult> {
  const res = await get(url, officialUnknown(service) ? null : service.sourceVersion);
  if (res.status === 304) return { kind: "unchanged" };
  const body = await decode(res);
  const etag = res.headers.get("etag");
  const modified = res.headers.get("last-modified");
  return { kind: "snapshot", snapshot: parse(body), version: etag ? `etag:${etag}` : modified ? `lm:${modified}` : null };
}

/**
 * Alertas do IODA de um país ou ASN. A entrada da operadora vem com "entityCode=auto" no catálogo: o
 * ASN é o da tela de configuração ou o descoberto pelo IP público (uma vez por dia).
 */
async function fetchIoda(service: StatusService): Promise<FetchResult> {
  let base = service.sourceUrl!;
  let entity = service.name;
  if (base.includes(AUTO_ASN)) {
    const isp = await resolveIsp((await getGlobalStatusSettings()).ispAsn);
    base = base.replace(AUTO_ASN, `entityCode=${isp.asn}`);
    entity = ispLabel(isp);
  }
  const body = (await (await get(iodaAlertsUrl(base, Date.now()))).json()) as IodaAlertsResponse;
  const code = /entityCode=([^&]+)/.exec(base)?.[1];
  const kind = /entityType=([^&]+)/.exec(base)?.[1];
  const pageUrl = code && kind ? `https://ioda.inetintel.cc.gatech.edu/${kind}/${code}` : service.pageUrl;
  const snapshot = parseIodaAlerts(body, { entity, pageUrl });
  // A operadora aparece no card pela frase: "AS28573 · CLARO S.A. · Sem alertas do IODA".
  if (entity !== service.name) snapshot.description = `${entity} · ${snapshot.description}`;
  return { kind: "snapshot", snapshot, version: null };
}

async function fetchService(service: StatusService, state: SourceState, force: boolean): Promise<FetchResult | null> {
  // "Atualizar agora" não refaz as rotas BGP de todos os serviços a cada clique: elas mudam em horas.
  const interval = force ? (service.sourceType === "RIPESTAT" ? FORCED_ROUTES_MS : 0) : SOURCE_INTERVAL_MS[service.sourceType];
  if (interval && Date.now() - state.lastFetchAt < interval) return null;
  switch (service.sourceType) {
    case "STATUSPAGE":
      return fetchStatuspage(service, state, force);
    case "GCP": {
      state.lastFetchAt = Date.now();
      const base = service.sourceUrl!.replace(/\/$/, "");
      return fetchWithEtag(service, `${base}/incidents.json`, (body) => parseGcpIncidents(JSON.parse(body), new Date(), { url: base, name: service.name }));
    }
    case "AZURE_RSS":
      state.lastFetchAt = Date.now();
      return fetchWithEtag(service, service.sourceUrl!, parseAzureRss);
    case "AWS":
      state.lastFetchAt = Date.now();
      // O JSON da AWS vem em UTF-16: res.text() leria como UTF-8 e quebraria o parse.
      return fetchWithEtag(service, service.sourceUrl!, (body) => parseAwsEvents(JSON.parse(body)), async (res) => decodeAwsBody(await res.arrayBuffer()));
    case "IODA":
      state.lastFetchAt = Date.now();
      return fetchIoda(service);
    case "RIPESTAT":
      state.lastFetchAt = Date.now();
      return { kind: "snapshot", snapshot: bgpSnapshot(await collectRoutes()), version: null };
    default:
      return null;
  }
}

/**
 * Status do card: o pior entre o estado oficial e o medido pelas sondas próprias. O medido e o status
 * atual são lidos na hora de gravar, dentro da fila de escrita, porque as medições gravam em paralelo
 * com as consultas e a linha carregada no começo da rodada já pode estar velha. Com as medições
 * desligadas o medido não entra: o que estiver gravado é de antes, e ninguém mais o atualiza.
 */
async function combinedStatus(db: Prisma.TransactionClient, serviceId: string, official: ServiceStatus): Promise<{ status: ServiceStatus; changed: boolean }> {
  const current = await db.statusService.findUnique({ where: { id: serviceId }, select: { measuredStatus: true, status: true } });
  const measured = probesEnabled(process.env.GLOBAL_STATUS_PROBES) ? (current?.measuredStatus as ServiceStatus | null | undefined) : null;
  const status = combineStatus(official, measured);
  return { status, changed: status !== current?.status };
}

/** Grava um snapshot: estado oficial e status do serviço, componentes (só o que mudou) e incidentes. */
async function persist(service: StatusService, snapshot: OfficialSnapshot, version: string | null): Promise<void> {
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const { status, changed } = await combinedStatus(tx, service.id, snapshot.status);
    await tx.statusService.update({
      where: { id: service.id },
      data: {
        officialState: snapshot.status,
        status,
        officialStatus: snapshot.description || null,
        lastError: null,
        lastCheckAt: now,
        sourceVersion: version,
        ...(changed ? { lastChangeAt: now } : {}),
      },
    });

    if (snapshot.components) {
      const existing = new Map(
        (await tx.statusComponent.findMany({ where: { serviceId: service.id } })).map((c) => [c.externalId, c]),
      );
      const created: typeof snapshot.components = [];
      for (const c of snapshot.components) {
        const prev = existing.get(c.externalId);
        existing.delete(c.externalId);
        if (!prev) {
          created.push(c);
          continue;
        }
        if (prev.status === c.status && prev.name === c.name && prev.groupName === c.groupName && prev.position === c.position) continue;
        await tx.statusComponent.update({
          where: { id: prev.id },
          data: { name: c.name, groupName: c.groupName, status: c.status, position: c.position, updatedAt: now },
        });
      }
      // Primeira gravação da Cloudflare são ~470 componentes: um insert só.
      if (created.length) {
        await tx.statusComponent.createMany({ data: created.map((c) => ({ serviceId: service.id, ...c, updatedAt: now })) });
      }
      if (existing.size) {
        await tx.statusComponent.deleteMany({ where: { id: { in: Array.from(existing.values(), (c) => c.id) } } });
      }
    }

    const seen = new Set<string>();
    for (const inc of snapshot.incidents) {
      seen.add(inc.externalId);
      await tx.statusIncident.upsert({
        where: { serviceId_origin_externalId: { serviceId: service.id, origin: "OFFICIAL", externalId: inc.externalId } },
        create: { serviceId: service.id, origin: "OFFICIAL", ...inc },
        update: { title: inc.title, impact: inc.impact, state: inc.state, url: inc.url, affected: inc.affected, resolvedAt: inc.resolvedAt },
      });
    }
    // O que estava aberto e sumiu da fonte foi encerrado pelo provedor.
    await tx.statusIncident.updateMany({
      where: { serviceId: service.id, origin: "OFFICIAL", resolvedAt: null, externalId: { notIn: Array.from(seen) } },
      data: { resolvedAt: now, state: "resolved" },
    });
  }, { timeout: 30_000 });
}

/** Grava a falha de uma consulta; com `unknown`, a fonte oficial passa a "Sem dados" e o status do card fica só com o medido. */
async function persistFailure(serviceId: string, message: string, unknown: boolean): Promise<void> {
  const data: Prisma.StatusServiceUpdateInput = { lastError: message.slice(0, 300) };
  if (unknown) {
    const { status, changed } = await combinedStatus(prisma, serviceId, "UNKNOWN");
    data.officialState = "UNKNOWN";
    data.status = status;
    if (changed) data.lastChangeAt = new Date();
  }
  await prisma.statusService.update({ where: { id: serviceId }, data });
}

async function checkService(service: StatusService, force: boolean): Promise<void> {
  const state = sourceState(service.slug);
  if (!force && Date.now() < state.nextAllowedAt) return;
  try {
    const result = await fetchService(service, state, force);
    if (!result) return;
    if (result.kind === "unchanged") {
      await serialized(() => prisma.statusService.update({ where: { id: service.id }, data: { lastCheckAt: new Date(), lastError: null } }));
    } else {
      await serialized(() => persist(service, result.snapshot, result.version));
    }
    state.failures = 0;
    state.backoffMs = 0;
    state.nextAllowedAt = 0;
  } catch (err) {
    state.failures++;
    const message = err instanceof Error ? (err.name === "TimeoutError" ? "Tempo esgotado ao consultar a fonte oficial" : err.message) : String(err);
    // Limite de requisições ou falha do lado deles: espera mais antes de tentar de novo.
    if (err instanceof HttpError && (err.status === 429 || err.status >= 500)) {
      state.backoffMs = Math.min(MAX_BACKOFF_MS, state.backoffMs ? state.backoffMs * 2 : TICK_MS * 2);
      state.nextAllowedAt = Date.now() + state.backoffMs;
    }
    await serialized(() => persistFailure(service.id, message, state.failures >= FAILURES_TO_UNKNOWN)).catch(() => {});
    console.warn(`[global-status] ${service.slug}: ${message}`);
  }
}

/** O que a gravação do catálogo precisa saber de cada serviço já gravado, com os alvos dele. */
const STORED_SERVICE = {
  id: true,
  slug: true,
  sourceType: true,
  officialState: true,
  measuredStatus: true,
  status: true,
  targets: { select: { id: true, key: true, kind: true, host: true, url: true, port: true } },
} satisfies Prisma.StatusServiceSelect;

type StoredService = Prisma.StatusServiceGetPayload<{ select: typeof STORED_SERVICE }>;

/**
 * Grava os alvos de um serviço do catálogo. O alvo que manteve a chave mas trocou de endereço perde as
 * medições e o estado, que eram do endereço antigo; a chave que saiu do catálogo é apagada, com o
 * histórico em cascata.
 */
async function seedTargets(tx: Prisma.TransactionClient, serviceId: string, entry: CatalogEntry, stored: StoredService["targets"]): Promise<void> {
  const known = new Map(stored.map((t) => [t.key, t]));
  for (const target of entry.targets) {
    const fields = { kind: target.kind, host: target.host, url: target.url ?? null, port: target.port ?? null, intervalSec: target.intervalSec ?? DEFAULT_INTERVAL_SEC[target.kind] };
    const old = known.get(target.key);
    const moved = old !== undefined && endpointChanged(old, fields);
    if (moved) {
      await tx.probeCheck.deleteMany({ where: { targetId: old.id } });
      await tx.probeRollup.deleteMany({ where: { targetId: old.id } });
    }
    await tx.probeTarget.upsert({
      where: { serviceId_key: { serviceId, key: target.key } },
      create: { serviceId, key: target.key, ...fields },
      update: moved ? { ...fields, ...CLEARED_TARGET_DATA, lastCheckAt: null } : fields,
    });
  }
  await tx.probeTarget.deleteMany({ where: { serviceId, key: { notIn: entry.targets.map((t) => t.key) } } });
}

/**
 * Grava um serviço do catálogo e os alvos dele. O serviço que deixou de ter fonte oficial perde o que a
 * fonte antiga declarou: o estado, a frase, os componentes e os incidentes.
 */
async function seedService(tx: Prisma.TransactionClient, entry: CatalogEntry, position: number, before: StoredService | undefined, now: Date): Promise<void> {
  const data = { name: entry.name, category: entry.category, sourceType: entry.sourceType, sourceUrl: entry.sourceUrl, pageUrl: entry.pageUrl, position };
  const lostSource = entry.sourceType === "NONE" && before !== undefined && (before.sourceType !== "NONE" || before.officialState !== null);
  const update = lostSource ? { ...data, ...unsourcedServiceData(before, now) } : data;
  const service = await tx.statusService.upsert({ where: { slug: entry.slug }, create: { slug: entry.slug, ...data }, update, select: { id: true } });
  if (lostSource) {
    // Componentes e incidentes vieram da fonte que não existe mais.
    await tx.statusComponent.deleteMany({ where: { serviceId: service.id } });
    await tx.statusIncident.deleteMany({ where: { serviceId: service.id, origin: "OFFICIAL" } });
  }
  await seedTargets(tx, service.id, entry, before?.targets ?? []);
}

/**
 * Cria/atualiza os serviços do catálogo (nome, categoria, fonte e ordem) e os alvos de medição de cada
 * um, sem mexer em "enabled". O que saiu do catálogo é apagado, com o histórico em cascata: o alvo cuja
 * chave saiu e o serviço cujo identificador saiu (senão ele seguiria sendo consultado e medido para
 * sempre).
 *
 * Tudo numa transação só, dentro da fila de escrita: no SQLite cada transação é uma ida ao disco, e são
 * mais de cem gravações pequenas.
 */
export async function seedStatusCatalog(): Promise<void> {
  await serialized(() => prisma.$transaction(async (tx) => {
    const now = new Date();
    const stored = await tx.statusService.findMany({ select: STORED_SERVICE });
    const bySlug = new Map(stored.map((s) => [s.slug, s]));
    for (const [position, entry] of STATUS_CATALOG.entries()) await seedService(tx, entry, position, bySlug.get(entry.slug), now);

    const slugs = new Set(STATUS_CATALOG.map((entry) => entry.slug));
    const removed = stored.filter((s) => !slugs.has(s.slug)).map((s) => s.id);
    if (removed.length) await tx.statusService.deleteMany({ where: { id: { in: removed } } });
    // Roda ao subir, junto com os outros monitores: espera mais por uma conexão livre antes de desistir.
  }, { maxWait: 10_000, timeout: 30_000 }));
}

/**
 * Garante o catálogo gravado antes de qualquer leitura ou medição. O coletor, as medições e a primeira
 * abertura da página pedem ao mesmo tempo: todos esperam a mesma gravação (uma por processo).
 */
export function ensureCatalogSeeded(): Promise<void> {
  const state = globalThis as typeof globalThis & { __globalStatusSeed?: Promise<void> };
  state.__globalStatusSeed ??= seedStatusCatalog().catch((err) => {
    state.__globalStatusSeed = undefined;
    throw err;
  });
  return state.__globalStatusSeed;
}

/** Uma rodada de consulta a todas as fontes. `force` ignora intervalos, cache de versão e backoff. */
export function checkGlobalStatus(force = false): Promise<void> {
  if (g.__globalStatusRun) return g.__globalStatusRun;
  g.__globalStatusRun = (async () => {
    await ensureCatalogSeeded();
    const services = await prisma.statusService.findMany({ where: { enabled: true, sourceType: { not: "NONE" } } });
    await Promise.all(services.map((s) => checkService(s, force)));
    // Depois das consultas e no mesmo ritmo delas: o e-mail opcional de mudanças de status.
    await notifyStatusChanges().catch((err) => console.warn("[global-status] alerta por e-mail:", err instanceof Error ? err.message : err));
  })()
    .catch((err) => console.error("[global-status] falha na rodada:", err))
    .finally(() => {
      g.__globalStatusRun = undefined;
    });
  return g.__globalStatusRun;
}

/** Inicia a coleta periódica (uma vez por processo, via instrumentation). */
export function startGlobalStatusMonitor(): void {
  if (g.__globalStatusTimer) return;
  g.__globalStatusTimer = setInterval(() => void checkGlobalStatus(), TICK_MS);
  void checkGlobalStatus(true);
  console.log(`[global-status] consultando o status oficial dos serviços a cada ${TICK_MS / 60_000} min`);
}
