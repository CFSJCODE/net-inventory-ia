import type { Prisma, StatusService } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { DEFAULT_INTERVAL_SEC, STATUS_CATALOG } from "./catalog";
import { parseStatuspageSummary, statuspageVersion, type SpSummary } from "./adapters/statuspage";
import { parseGcpIncidents } from "./adapters/gcp";
import { parseAzureRss } from "./adapters/azure-rss";
import { combineStatus, type OfficialSnapshot, type ServiceStatus } from "./types";
import { serialized } from "./write-queue";

/**
 * Coletor do status oficial dos serviços globais. Roda em segundo plano (instrumentation), no mesmo
 * padrão do monitor de ligações: um timer por processo e uma rodada por vez.
 *
 * Frequências (bem abaixo de qualquer limite dos provedores):
 * - Statuspage: `status.json` (≈200 bytes) a cada 2 min; `summary.json` só quando a página muda
 *   (`page.updated_at`) ou a cada 10 min.
 * - Google Cloud e Azure: a cada 5 min, com ETag/Last-Modified (resposta 304 não baixa nada).
 * Erro 429/5xx dobra o intervalo daquela fonte até 30 min; volta ao normal no primeiro sucesso.
 */

export const TICK_MS = 2 * 60_000;
const SUMMARY_MAX_AGE_MS = 10 * 60_000;
const SLOW_SOURCE_MS = 5 * 60_000;
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

async function fetchWithEtag(service: StatusService, url: string, parse: (body: string) => OfficialSnapshot): Promise<FetchResult> {
  const res = await get(url, officialUnknown(service) ? null : service.sourceVersion);
  if (res.status === 304) return { kind: "unchanged" };
  const body = await res.text();
  const etag = res.headers.get("etag");
  const modified = res.headers.get("last-modified");
  return { kind: "snapshot", snapshot: parse(body), version: etag ? `etag:${etag}` : modified ? `lm:${modified}` : null };
}

async function fetchService(service: StatusService, state: SourceState, force: boolean): Promise<FetchResult | null> {
  const slow = service.sourceType === "GCP" || service.sourceType === "AZURE_RSS";
  if (!force && slow && Date.now() - state.lastFetchAt < SLOW_SOURCE_MS) return null;
  switch (service.sourceType) {
    case "STATUSPAGE":
      return fetchStatuspage(service, state, force);
    case "GCP": {
      state.lastFetchAt = Date.now();
      const base = service.sourceUrl!.replace(/\/$/, "");
      return fetchWithEtag(service, `${base}/incidents.json`, (body) => parseGcpIncidents(JSON.parse(body)));
    }
    case "AZURE_RSS":
      state.lastFetchAt = Date.now();
      return fetchWithEtag(service, service.sourceUrl!, parseAzureRss);
    default:
      return null;
  }
}

/**
 * Status do card: o pior entre o estado oficial e o medido pelas sondas próprias. O medido e o status
 * atual são lidos na hora de gravar, dentro da fila de escrita, porque as medições gravam em paralelo
 * com as consultas e a linha carregada no começo da rodada já pode estar velha.
 */
async function combinedStatus(db: Prisma.TransactionClient, serviceId: string, official: ServiceStatus): Promise<{ status: ServiceStatus; changed: boolean }> {
  const current = await db.statusService.findUnique({ where: { id: serviceId }, select: { measuredStatus: true, status: true } });
  const status = combineStatus(official, current?.measuredStatus as ServiceStatus | null | undefined);
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

/**
 * Cria/atualiza os serviços do catálogo (nome, categoria, fonte e ordem) e os alvos de medição de cada
 * um, sem mexer em "enabled". Alvo cuja chave saiu do catálogo é apagado (e as medições dele, em
 * cascata). Tudo numa transação só, dentro da fila de escrita: no SQLite cada transação é uma ida ao
 * disco, e são mais de cem gravações pequenas.
 */
export async function seedStatusCatalog(): Promise<void> {
  await serialized(() => prisma.$transaction(async (tx) => {
    for (const [position, entry] of STATUS_CATALOG.entries()) {
      const data = { name: entry.name, category: entry.category, sourceType: entry.sourceType, sourceUrl: entry.sourceUrl, pageUrl: entry.pageUrl, position };
      const service = await tx.statusService.upsert({ where: { slug: entry.slug }, create: { slug: entry.slug, ...data }, update: data, select: { id: true } });
      for (const target of entry.targets) {
        const fields = { kind: target.kind, host: target.host, url: target.url ?? null, port: target.port ?? null, intervalSec: target.intervalSec ?? DEFAULT_INTERVAL_SEC[target.kind] };
        await tx.probeTarget.upsert({
          where: { serviceId_key: { serviceId: service.id, key: target.key } },
          create: { serviceId: service.id, key: target.key, ...fields },
          update: fields,
        });
      }
      await tx.probeTarget.deleteMany({ where: { serviceId: service.id, key: { notIn: entry.targets.map((t) => t.key) } } });
    }
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
