import { prisma } from "@/lib/prisma";
import { storedIsp } from "./internet-signals";
import { probesEnabled } from "./probe-logic";
import { getLocalConnectivity } from "./probe-runner";
import { asNameOf, enrichHops, isPrivateIp, originOf, type EnrichedHop } from "./route-enrich";
import { asPathOf, inferRoute, type RouteInference } from "./route-infer";
import { brazilCables } from "./subsea-cables";
import { traceAllModes, traceBest, traceHost, type TraceResult } from "./traceroute";
import { serialized } from "./write-queue";

/**
 * Rota até o destino de cada serviço (fase 5): traceroute a partir do servidor, ASN, rDNS e cidade de
 * cada salto, e a inferência de onde o serviço é servido (ver `route-infer.ts`). Gravada como
 * RouteTrace + RouteHop e mantida por 7 dias.
 *
 * Agenda: um serviço por vez, a cada minuto o que tem a rota mais antiga, até cada um ter uma rota de
 * menos de 30 min. Um traceroute leva de 5 s a 1 min; um por vez não pesa na VM de 1 vCPU e não
 * enche a rede. Pausa com a conexão do servidor fora (a rota seria só o gateway). `GLOBAL_STATUS_ROUTES=off`
 * desliga, e com as medições desligadas (`GLOBAL_STATUS_PROBES=off`) também não roda.
 *
 * Mudança de rota: quando o veredito, o país ou o cabo provável mudam de uma rota para a outra, um aviso
 * (incidente de origem ROUTE) aparece no ticker por 1 h. Mudanças só de saltos ou de ASNs no meio não
 * contam: o balanceamento das operadoras troca o caminho o tempo todo sem mudar onde o serviço está.
 */

export const ROUTE_ORIGIN = "ROUTE";
export const ROUTE_INTERVAL_MS = 30 * 60_000;
export const ROUTE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const ROUTE_EVENT_MS = 60 * 60_000;
const TICK_MS = 60_000;
const FIRST_TICK_DELAY_MS = 3 * 60_000;
/** Sem ferramenta de traceroute no servidor: tenta de novo depois de 6 h. */
const NO_TOOL_RETRY_MS = 6 * 60 * 60_000;

/** Estado da ferramenta de rota, para a tela Configurar (fase 7): AppSetting `globalStatus.routeTool`. */
export const ROUTE_TOOL_KEY = "globalStatus.routeTool";
export interface RouteToolState {
  /** Ferramenta da última rota ("traceroute (TCP 443)"), ou null sem nenhuma. */
  tool: string | null;
  /** Modo TCP: ok | denied (falta CAP_NET_RAW) | unavailable; null = ainda não foi preciso. */
  tcp: "ok" | "denied" | "unavailable" | null;
  /** Última rota gravada e último erro de ferramenta. */
  lastRouteAt: string | null;
  error: string | null;
  checkedAt: string;
}

export async function readRouteToolState(): Promise<RouteToolState | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: ROUTE_TOOL_KEY } }).catch(() => null);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as RouteToolState;
  } catch {
    return null;
  }
}

async function writeRouteToolState(trace: TraceResult, stored: boolean, nowMs: number): Promise<void> {
  const previous = await readRouteToolState();
  const next: RouteToolState = {
    tool: trace.tool ?? previous?.tool ?? null,
    // Um rastreio que não precisou do TCP não diz nada sobre ele: fica o que já se sabia.
    tcp: trace.tcp ?? previous?.tcp ?? null,
    lastRouteAt: stored ? new Date(nowMs).toISOString() : (previous?.lastRouteAt ?? null),
    error: trace.ok ? null : trace.error,
    checkedAt: new Date(nowMs).toISOString(),
  };
  const value = JSON.stringify(next);
  await serialized(() => prisma.appSetting.upsert({ where: { key: ROUTE_TOOL_KEY }, create: { key: ROUTE_TOOL_KEY, value }, update: { value } })).catch(() => undefined);
}

/** Rota que não chegou: o TTL do último roteador que respondeu (depois dele, só silêncio). */
export function lastVisibleTtl(trace: Pick<TraceResult, "ok" | "reached" | "hops">): number | null {
  if (!trace.ok || trace.reached) return null;
  return [...trace.hops].reverse().find((h) => h.ip !== null)?.ttl ?? null;
}

export function routesEnabled(env: Partial<Record<string, string>> = process.env): boolean {
  return probesEnabled(env.GLOBAL_STATUS_PROBES) && env.GLOBAL_STATUS_ROUTES?.trim().toLowerCase() !== "off";
}

interface RouteRunnerState {
  started: boolean;
  timer?: NodeJS.Timeout;
  running?: Promise<void>;
  noToolUntil: number;
  warnedNoTool: boolean;
}

const g = globalThis as typeof globalThis & { __globalStatusRoutes?: RouteRunnerState };
function state(): RouteRunnerState {
  g.__globalStatusRoutes ??= { started: false, noToolUntil: 0, warnedNoTool: false };
  return g.__globalStatusRoutes;
}

const VERDICT_WORD: Record<string, string> = { DOMESTIC: "no Brasil", OPERATOR_CACHE: "dentro da operadora", INTERNATIONAL: "fora do Brasil", UNDETERMINED: "indefinido" };

/** O que descreve onde o serviço está, para comparar duas rotas. */
function placeOf(t: { verdict: string; destCountry: string | null; cableId: string | null }): string {
  return `${t.verdict}|${t.destCountry ?? ""}|${t.cableId ?? ""}`;
}

function placeText(t: { verdict: string; cableName: string | null }): string {
  return t.cableName ? `${VERDICT_WORD[t.verdict] ?? t.verdict}, cabo ${t.cableName}` : (VERDICT_WORD[t.verdict] ?? t.verdict);
}

/** RTT até o destino: o último salto quando ele é o destino; senão o handshake TCP mais recente do serviço. */
export function destinationRtt(trace: TraceResult, latencyMs: number | null): number | null {
  const last = trace.hops[trace.hops.length - 1];
  if (trace.reached && last?.rttMs != null) return last.rttMs;
  return latencyMs ?? null;
}

interface ServiceForRoute {
  id: string;
  slug: string;
  name: string;
  host: string;
  latencyMs: number | null;
}

/** Rastreia, interpreta e grava a rota de um serviço. Devolve o id da rota gravada, ou null sem traceroute. */
export async function traceAndStore(service: ServiceForRoute, nowMs = Date.now(), opts: { allModes?: boolean } = {}): Promise<string | null> {
  const trace = opts.allModes ? await traceAllModes(service.host) : await traceBest(service.host);
  if (!trace.ok && trace.tool === null && /indisponível/.test(trace.error ?? "")) {
    await writeRouteToolState(trace, false, nowMs);
    return null;
  }

  const hops: EnrichedHop[] = trace.ok ? await enrichHops(trace.hops, nowMs) : [];
  const destIp = trace.address;
  const destOrigin = destIp && !isPrivateIp(destIp) ? await originOf(destIp, nowMs) : { asn: null, country: null };
  const destAsn = destOrigin.asn;
  const destAsName = destAsn ? await asNameOf(destAsn, nowMs) : null;
  const destRegistry = destOrigin.country;
  const [isp, cables] = await Promise.all([storedIsp(), brazilCables(nowMs)]);
  const destRttMs = destinationRtt(trace, service.latencyMs);
  const inference: RouteInference = trace.ok
    ? inferRoute({ hops, destRttMs, destAsn, destAsName, destRegistryCountry: destRegistry, isp: isp ? { asn: isp.asn, name: isp.name } : null, cables })
    : { verdict: "UNDETERMINED", summary: trace.error ? `Não foi possível rastrear: ${trace.error}.` : "Não foi possível rastrear.", destCountry: null, cable: null, candidates: [], confidence: null, exitTtl: null, entryTtl: null, stepMs: null };

  const now = new Date(nowMs);
  return serialized(() =>
    prisma.$transaction(async (tx) => {
      const previous = await tx.routeTrace.findFirst({ where: { serviceId: service.id, error: null }, orderBy: { at: "desc" }, select: { verdict: true, destCountry: true, cableId: true, cableName: true } });
      const created = await tx.routeTrace.create({
        data: {
          serviceId: service.id,
          at: now,
          host: service.host,
          destIp,
          tool: trace.tool,
          reached: trace.reached,
          destRttMs: destRttMs === null ? null : Math.round(destRttMs * 10) / 10,
          verdict: inference.verdict,
          summary: inference.summary,
          destCountry: inference.destCountry,
          cableId: inference.cable?.id ?? null,
          cableName: inference.cable?.name ?? null,
          candidates: inference.candidates.length ? inference.candidates.map((c) => c.name).join(" · ") : null,
          confidence: inference.confidence,
          asPath: asPathOf(hops, destAsn),
          error: trace.ok ? null : (trace.error ?? "falha no traceroute"),
          mode: trace.mode,
          lastVisibleTtl: lastVisibleTtl(trace),
        },
      });
      if (hops.length) {
        await tx.routeHop.createMany({
          data: hops.map((h) => ({
            traceId: created.id,
            ttl: h.ttl,
            ip: h.ip,
            rttMs: h.rttMs,
            asn: h.asn,
            asName: h.asName,
            rdns: h.rdns,
            city: h.city?.name ?? null,
            country: h.city?.country ?? null,
            altIps: h.altIps.length ? JSON.stringify(h.altIps) : null,
            role: h.role,
          })),
        });
      }
      // Mudança de onde o serviço está: aviso no ticker (um por serviço; um aviso aberto é atualizado).
      const next = { verdict: inference.verdict, destCountry: inference.destCountry, cableId: inference.cable?.id ?? null, cableName: inference.cable?.name ?? null };
      if (trace.ok && previous && inference.verdict !== "UNDETERMINED" && previous.verdict !== "UNDETERMINED" && placeOf(previous) !== placeOf(next)) {
        const title = `Rota mudou: ${placeText(previous)} → ${placeText(next)}`;
        const open = await tx.statusIncident.findFirst({ where: { serviceId: service.id, origin: ROUTE_ORIGIN, resolvedAt: null } });
        if (open) await tx.statusIncident.update({ where: { id: open.id }, data: { title, affected: inference.summary, startedAt: now } });
        else
          await tx.statusIncident.create({
            data: { serviceId: service.id, origin: ROUTE_ORIGIN, externalId: `r-${nowMs}`, title, impact: "MINOR", state: "monitoring", url: null, affected: inference.summary, startedAt: now },
          });
      }
      return created.id;
    }),
  ).then(async (id) => {
    await writeRouteToolState(trace, true, nowMs);
    return id;
  });
}

/** Serviços medidos com destino rastreável (os mesmos da rota BGP), com a data da rota mais nova. */
async function candidates(): Promise<(ServiceForRoute & { lastAt: number })[]> {
  const services = await prisma.statusService.findMany({
    where: { enabled: true, category: { notIn: ["INTERNET", "REGIONAL"] } },
    orderBy: { position: "asc" },
    select: { id: true, slug: true, name: true, latencyMs: true, targets: { where: { enabled: true }, select: { kind: true, host: true, url: true } } },
  });
  const latest = await prisma.routeTrace.groupBy({ by: ["serviceId"], _max: { at: true } });
  const lastAt = new Map(latest.map((r) => [r.serviceId, r._max.at?.getTime() ?? 0]));
  return services.flatMap((s) => {
    const host = traceHost(s.targets);
    return host ? [{ id: s.id, slug: s.slug, name: s.name, host, latencyMs: s.latencyMs, lastAt: lastAt.get(s.id) ?? 0 }] : [];
  });
}

/** O próximo serviço a rastrear: o de rota mais antiga, se passou do intervalo. Pura. */
export function nextDue<T extends { lastAt: number }>(list: readonly T[], nowMs: number): T | null {
  let best: T | null = null;
  for (const s of list) if (nowMs - s.lastAt >= ROUTE_INTERVAL_MS && (!best || s.lastAt < best.lastAt)) best = s;
  return best;
}

/** Encerra os avisos de mudança de rota com mais de 1 h e apaga as rotas com mais de 7 dias. */
export async function cleanupRoutes(nowMs = Date.now()): Promise<void> {
  await serialized(async () => {
    await prisma.statusIncident.updateMany({ where: { origin: ROUTE_ORIGIN, resolvedAt: null, startedAt: { lt: new Date(nowMs - ROUTE_EVENT_MS) } }, data: { resolvedAt: new Date(nowMs), state: "resolved" } });
    await prisma.routeTrace.deleteMany({ where: { at: { lt: new Date(nowMs - ROUTE_RETENTION_MS) } } });
  });
}

/** Uma rodada do agendador: limpa o que venceu e rastreia o próximo serviço, se houver. */
export async function runRouteTick(nowMs = Date.now()): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = (async () => {
    await cleanupRoutes(nowMs);
    if (nowMs < s.noToolUntil) return;
    if ((await getLocalConnectivity()).state !== "ok") return;
    const due = nextDue(await candidates(), nowMs);
    if (!due) return;
    const id = await traceAndStore(due, nowMs);
    if (id === null) {
      s.noToolUntil = nowMs + NO_TOOL_RETRY_MS;
      if (!s.warnedNoTool) console.warn("[global-status] sem traceroute no servidor: a rota até os serviços fica sem dados (sudo apt install traceroute)");
      s.warnedNoTool = true;
    }
  })()
    .catch((err) => console.warn(`[global-status] rota: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => {
      s.running = undefined;
    });
  return s.running;
}

/** Rastreia agora um serviço pelo slug ("Rastrear rota" no detalhe), em todos os modos. Devolve o id da rota gravada. */
export async function traceServiceNow(slug: string): Promise<string | null> {
  const list = await candidates();
  const service = list.find((s) => s.slug === slug);
  // Sob demanda: os três modos seguidos (Paris, UDP clássico e TCP 443) e a união deles.
  return service ? traceAndStore(service, Date.now(), { allModes: true }) : null;
}

/** Inicia o agendador (uma vez por processo, via instrumentation). */
export function startRouteRunner(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  if (!routesEnabled()) {
    console.log("[global-status] rota até os serviços desligada (GLOBAL_STATUS_ROUTES=off ou medições desligadas)");
    return;
  }
  s.timer = setTimeout(() => {
    void runRouteTick();
    s.timer = setInterval(() => void runRouteTick(), TICK_MS);
    s.timer.unref();
  }, FIRST_TICK_DELAY_MS);
  s.timer.unref();
}
