"use server";

import { requirePermission, requireSession } from "@/lib/auth/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { STATUS_CATALOG } from "@/lib/global-status/catalog";
import { checkGlobalStatus, ensureCatalogSeeded } from "@/lib/global-status/collector";
import { AGENT_VANTAGE_PREFIX, SERVER_VANTAGE, agentIdOf, isStale, probesEnabled, servedMeasure, sortByCatalog } from "@/lib/global-status/probe-logic";
import { getLocalConnectivity, runProbesNow } from "@/lib/global-status/probe-runner";
import { defaultGateway } from "@/lib/global-status/probes";
import { buildPhaseSeries, buildSeries, latencySummary, mainLatencyTarget, tailPoints, uptimeFromTotals, uptimeOf, type PhaseSeries, type RollupPoint, type SparkSeries } from "@/lib/global-status/series";
import { traceHost } from "@/lib/global-status/traceroute";
import { parseEdge } from "@/lib/global-status/edge-pop";
import { loadRouteOverview, type RouteOverview } from "@/lib/global-status/route-overview";
import { pathHistory } from "@/lib/global-status/route-history";
import { monthlyRoutes } from "@/lib/global-status/route-daily";
import { atlasCompare, type AtlasComparison } from "@/lib/global-status/atlas";
import { interconnectionText, interconnections } from "@/lib/global-status/route-peering";
import { ROUTE_ORIGIN, readRouteToolState, routesEnabled, traceServiceNow, type RouteToolState } from "@/lib/global-status/route-runner";
import { CABLE_MAP_PAGE } from "@/lib/global-status/subsea-cables";
import { BUCKET_MS, bucketStart } from "@/lib/global-status/stats";
import { storedIsp } from "@/lib/global-status/internet-signals";
import { THROUGHPUT_KEEP_MS, summarizeThroughput, type ThroughputSummary } from "@/lib/global-status/throughput";
import { getGlobalStatusSettings, normalizeGlobalStatusSettings, saveGlobalStatusSettings, type GlobalStatusSettings } from "@/lib/global-status/settings";
import { serialized } from "@/lib/global-status/write-queue";
import { getEmailAlertConfig } from "@/lib/alerts/email-settings";
import { AUTO_GATEWAY, STATUS_SEVERITY, targetAddress, targetLabel, type LocalConnectivity, type ProbeKind, type ServiceStatus, type TargetStatus } from "@/lib/global-status/types";

export interface StatusComponentRow {
  name: string;
  groupName: string | null;
  status: ServiceStatus;
}

export interface StatusIncidentRow {
  id: string;
  /** OFFICIAL = publicado pela fonte (provedor ou IODA); DETECTED = visto pelas medições deste servidor; ROUTE = a rota até o serviço mudou. */
  origin: string;
  serviceSlug: string;
  serviceName: string;
  title: string;
  impact: string;
  state: string;
  url: string | null;
  affected: string | null;
  startedAt: string;
  resolvedAt: string | null;
}

export interface StatusServiceRow {
  slug: string;
  name: string;
  category: string;
  /** Status consolidado: o pior entre o oficial e o medido. */
  status: ServiceStatus;
  /** true = o provedor publica uma fonte oficial que o servidor consulta. */
  hasSource: boolean;
  /** Frase do provedor (ex.: "Serviço parcialmente degradado"). */
  officialStatus: string | null;
  /** Estado declarado pelo provedor; null sem fonte oficial ou antes da primeira consulta. */
  officialState: ServiceStatus | null;
  /** Estado medido daqui; null sem medições ainda. */
  measuredStatus: ServiceStatus | null;
  /** Motivo do estado medido quando não está normal (ex.: "HTTP: 3 falhas seguidas"). */
  measuredReason: string | null;
  /** true = as medições do serviço estão paradas pela conexão local (fora, ou recém-voltada e ele ainda não foi medido de novo). */
  measurementPaused: boolean;
  /** Latência de rede atual (handshake TCP ou ping), em ms. */
  latencyMs: number | null;
  /** Disponibilidade medida nas últimas 24 h, em % (o pior alvo do serviço); null sem amostras. */
  uptime24h: number | null;
  /** Latência das últimas 24 h do alvo principal, em passos de 15 min; null sem medições. */
  spark: SparkSeries | null;
  pageUrl: string | null;
  lastCheckAt: string | null;
  lastChangeAt: string | null;
  lastError: string | null;
  /** Componentes por status (a Cloudflare tem ~470, então o card mostra só a contagem e os com problema). */
  componentCounts: Record<ServiceStatus, number>;
  /** Até 6 componentes fora do normal, piores primeiro. */
  problemComponents: StatusComponentRow[];
  openIncidents: number;
}

/** Parcelas da última medição de um alvo. HTTP traz dns/connect/tls/ttfb; ICMP traz perda e jitter. */
export interface StatusTargetLast {
  at: string;
  ok: boolean;
  httpStatus: number | null;
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  totalMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  certDays: number | null;
}

/** Um alvo de medição própria, para a seção "Medições daqui" do detalhe. */
export interface StatusTargetRow {
  key: string;
  kind: ProbeKind;
  /** Rótulo curto: "HTTP", "TCP 443", "Ping", "DNS", "Certificado TLS". */
  label: string;
  /** O que é medido: URL, host:porta, IP ou "example.com em 1.1.1.1". */
  address: string;
  status: TargetStatus;
  statusReason: string | null;
  lastCheckAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  intervalSec: number;
  /** Disponibilidade nas últimas 24 h, em %; null sem amostras. */
  uptime24h: number | null;
  /** Disponibilidade medida pelo servidor nos últimos 30 dias, em %; null sem amostras. */
  uptime30d: number | null;
  /** Mediana e p95 da latência nas últimas 24 h, em ms. */
  p50Ms: number | null;
  p95Ms: number | null;
  last: StatusTargetLast | null;
  /** Latência das últimas 24 h, em passos de 15 min; null sem medições. */
  spark: SparkSeries | null;
}

export interface GlobalStatusData {
  /** false = as medições deste servidor estão desligadas (`GLOBAL_STATUS_PROBES=off`): a página mostra só o status oficial. */
  probes: boolean;
  /**
   * Os serviços habilitados, inclusive os da categoria INTERNET (base da faixa "Sua Internet"). Com as
   * medições desligadas, só os que têm fonte oficial: dos outros não haveria nada a mostrar.
   */
  services: StatusServiceRow[];
  /** Incidentes e manutenções em aberto em todos os serviços, mais recentes primeiro. */
  incidents: StatusIncidentRow[];
  /** Conexão do próprio servidor: quando não está "ok", as medições dos serviços ficam pausadas. */
  connectivity: LocalConnectivity;
}

function incidentRow(i: { id: string; origin: string; title: string; impact: string; state: string; url: string | null; affected: string | null; startedAt: Date; resolvedAt: Date | null; service: { slug: string; name: string } }): StatusIncidentRow {
  return {
    id: i.id,
    origin: i.origin,
    serviceSlug: i.service.slug,
    serviceName: i.service.name,
    title: i.title,
    impact: i.impact,
    state: i.state,
    url: i.url,
    affected: i.affected,
    startedAt: i.startedAt.toISOString(),
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
  };
}

const emptyCounts = (): Record<ServiceStatus, number> => ({ OK: 0, DEGRADED: 0, DOWN: 0, MAINTENANCE: 0, UNKNOWN: 0 });

// ---------------------------------------------------------------- histórico das medições (24 h)

const DAY_MS = 24 * 60 * 60_000;
/**
 * As janelas mudam a cada 5 min e a página consulta a cada 30 s por aba aberta: o histórico de 24 h (até
 * 288 janelas por alvo) é lido do banco no máximo uma vez por minuto e reaproveitado entre as consultas.
 */
const HISTORY_CACHE_MS = 60_000;
/** Quanto das medições cruas entra como ponta viva quando as janelas ainda não foram gravadas. */
const TAIL_MAX_MS = 30 * 60_000;
/** Gráfico do card e do detalhe: 24 h em passos de 15 min (96 pontos). */
const SPARK_HOURS = 24;
const SPARK_STEP_MIN = 15;

interface ServiceMeasure {
  uptime24h: number | null;
  spark: SparkSeries | null;
}

interface History {
  /** Janelas de 5 min das últimas 24 h, mais a ponta viva, por alvo (id). */
  points: Map<string, RollupPoint[]>;
  /** Disponibilidade e gráfico de cada serviço (id), já calculados. */
  services: Map<string, ServiceMeasure>;
  /** Instante da leitura: fim da grade dos gráficos. */
  end: Date;
}

// Em globalThis, como o estado do coletor e do agendador: um hot reload não duplica o cache.
const g = globalThis as typeof globalThis & { __globalStatusHistory?: { at: number; data: Promise<History> } };

/** Gráfico de um alvo; null quando ele não tem nenhuma medição dentro da grade. */
function sparkOf(points: RollupPoint[], end: Date): SparkSeries | null {
  if (!points.length) return null;
  const series = buildSeries(points, { end, hours: SPARK_HOURS, stepMin: SPARK_STEP_MIN });
  return series.p50.some((value) => value !== null) || series.fail.some((count) => count > 0) ? series : null;
}

/**
 * Onde começa a ponta viva, o trecho mais novo do histórico, lido das medições cruas em vez das janelas
 * gravadas (o agendador grava cada janela cerca de 1 min depois de ela fechar). `buckets` são os inícios
 * das janelas gravadas nas últimas 24 h.
 *
 * - Começa logo depois da última janela fechada que já está gravada, e no máximo 30 min atrás.
 * - A janela em andamento e a anterior a ela são sempre da ponta viva. Uma janela gravada com data de
 *   agora ou do futuro só existe quando o relógio do sistema voltou: ela não marca até onde o histórico
 *   está resumido (os gráficos ficariam sem as medições novas até o relógio alcançar a hora antiga), e a
 *   da janela anterior ainda pode ser a de antes da volta, que o agendador regrava em até 2 min.
 */
function liveTailStart(buckets: readonly number[], now: number): number {
  const open = bucketStart(now);
  const newest = buckets.reduce((max, bucket) => (bucket < open && bucket > max ? bucket : max), 0);
  const afterNewest = newest ? newest + BUCKET_MS : 0;
  return Math.max(Math.min(afterNewest, open - BUCKET_MS), bucketStart(now - TAIL_MAX_MS));
}

/** Lê as janelas e a ponta viva de todos os alvos habilitados: três consultas, nenhuma por alvo. */
async function loadHistory(now: number): Promise<History> {
  const end = new Date(now);
  const rows = await prisma.probeTarget.findMany({
    where: { enabled: true, service: { enabled: true } },
    select: { id: true, serviceId: true, key: true, kind: true, service: { select: { slug: true } } },
  });
  const targets = sortByCatalog(rows.map((t) => ({ id: t.id, serviceId: t.serviceId, key: t.key, kind: t.kind, serviceSlug: t.service.slug })), STATUS_CATALOG);
  const ids = targets.map((t) => t.id);
  const points = new Map<string, RollupPoint[]>(ids.map((id) => [id, []]));
  if (ids.length) {
    // Filtrar pelos alvos usa a chave (targetId, vantage, bucket) em vez de varrer os 30 dias de janelas.
    const rollups = await prisma.probeRollup.findMany({
      where: { targetId: { in: ids }, vantage: SERVER_VANTAGE, bucket: { gte: new Date(now - DAY_MS) } },
      select: { targetId: true, bucket: true, samples: true, failures: true, p50Ms: true, p95Ms: true },
    });
    const tailStart = liveTailStart(rollups.map((r) => r.bucket.getTime()), now);
    // No trecho da ponta viva valem as medições cruas: a janela gravada ali contaria as mesmas medições duas vezes.
    const stored = rollups.filter((r) => r.bucket.getTime() < tailStart || r.bucket.getTime() > now);
    for (const { targetId, ...point } of stored) points.get(targetId)?.push(point);
    const checks = await prisma.probeCheck.findMany({
      where: { targetId: { in: ids }, vantage: SERVER_VANTAGE, at: { gte: new Date(tailStart), lte: end } },
      select: { targetId: true, at: true, ok: true, latencyMs: true, lossPct: true },
    });
    for (const [targetId, tail] of tailPoints(checks)) points.get(targetId)?.push(...tail);
  }

  const byService = new Map<string, typeof targets>();
  for (const target of targets) {
    const list = byService.get(target.serviceId);
    if (list) list.push(target);
    else byService.set(target.serviceId, [target]);
  }
  const services = new Map<string, ServiceMeasure>();
  for (const [serviceId, list] of byService) {
    // A disponibilidade do serviço é a do pior alvo; o gráfico é o do alvo que mede a latência de rede.
    const uptimes = list.map((t) => uptimeOf(points.get(t.id) ?? [])).filter((value): value is number => value !== null);
    const main = mainLatencyTarget(list);
    services.set(serviceId, { uptime24h: uptimes.length ? Math.min(...uptimes) : null, spark: main ? sparkOf(points.get(main.id) ?? [], end) : null });
  }
  return { points, services, end };
}

/** Histórico das medições, lido do banco no máximo uma vez por minuto (consultas simultâneas dividem a mesma leitura). */
function getHistory(): Promise<History> {
  const now = Date.now();
  const cached = g.__globalStatusHistory;
  // Uma leitura "do futuro" (o relógio do sistema voltou) também está velha: sem isso o histórico ficaria parado até o relógio alcançar a hora antiga.
  if (cached && !isStale(cached.at, now, HISTORY_CACHE_MS)) return cached.data;
  const data: Promise<History> = loadHistory(now).catch((err) => {
    // Sem o histórico a página ainda mostra o status de cada serviço; os gráficos voltam na próxima consulta que der certo.
    if (g.__globalStatusHistory?.data === data) g.__globalStatusHistory = undefined;
    console.warn(`[global-status] histórico das medições indisponível: ${err instanceof Error ? err.message : String(err)}`);
    return { points: new Map(), services: new Map(), end: new Date(now) };
  });
  g.__globalStatusHistory = { at: now, data };
  return data;
}

/** Sem histórico: medições desligadas. */
const NO_HISTORY: Pick<History, "services"> = { services: new Map() };

export async function getGlobalStatus(): Promise<GlobalStatusData> {
  await requireSession();
  // Primeira abertura antes do monitor terminar a primeira rodada: os cards já aparecem como "Verificando".
  await ensureCatalogSeeded();
  const probes = probesEnabled(process.env.GLOBAL_STATUS_PROBES);

  const [services, counts, problems, open, history, connectivity] = await Promise.all([
    prisma.statusService.findMany({ where: probes ? { enabled: true } : { enabled: true, sourceType: { not: "NONE" } }, orderBy: { position: "asc" } }),
    prisma.statusComponent.groupBy({ by: ["serviceId", "status"], _count: { _all: true } }),
    prisma.statusComponent.findMany({ where: { status: { not: "OK" } }, orderBy: { position: "asc" } }),
    prisma.statusIncident.findMany({
      where: { resolvedAt: null, service: { enabled: true } },
      include: { service: { select: { slug: true, name: true } } },
      orderBy: { startedAt: "desc" },
    }),
    probes ? getHistory() : NO_HISTORY,
    getLocalConnectivity(),
  ]);

  const countsBy = new Map<string, Record<ServiceStatus, number>>();
  for (const c of counts) {
    const row = countsBy.get(c.serviceId) ?? emptyCounts();
    row[c.status as ServiceStatus] = (row[c.status as ServiceStatus] ?? 0) + c._count._all;
    countsBy.set(c.serviceId, row);
  }

  return {
    probes,
    services: services.map((s) => ({
      slug: s.slug,
      name: s.name,
      category: s.category,
      hasSource: s.sourceType !== "NONE",
      officialStatus: s.officialStatus,
      officialState: (s.officialState as ServiceStatus | null) ?? null,
      // Status do card, estado medido, motivo, pausa e latência: nada disso vai com as medições desligadas.
      ...servedMeasure(s, probes),
      uptime24h: history.services.get(s.id)?.uptime24h ?? null,
      spark: history.services.get(s.id)?.spark ?? null,
      pageUrl: s.pageUrl,
      lastCheckAt: s.lastCheckAt?.toISOString() ?? null,
      lastChangeAt: s.lastChangeAt?.toISOString() ?? null,
      lastError: s.lastError,
      componentCounts: countsBy.get(s.id) ?? emptyCounts(),
      problemComponents: problems
        .filter((c) => c.serviceId === s.id)
        .sort((a, b) => STATUS_SEVERITY[b.status as ServiceStatus] - STATUS_SEVERITY[a.status as ServiceStatus])
        .slice(0, 6)
        .map((c) => ({ name: c.name, groupName: c.groupName, status: c.status as ServiceStatus })),
      // Mudança de rota é aviso, não incidente do serviço: fica no ticker, fora da contagem do card.
      openIncidents: open.filter((i) => i.service.slug === s.slug && i.origin !== ROUTE_ORIGIN).length,
    })),
    incidents: open.map(incidentRow),
    connectivity,
  };
}

/** Um ponto de medição (o servidor ou um agente Windows) no alvo principal do serviço. */
export interface StatusVantageRow {
  /** "server" ou "agent:<id>". */
  id: string;
  /** "Servidor" ou o nome do PC cadastrado. */
  label: string;
  server: boolean;
  /** Latência das últimas 24 h, em passos de 15 min; null sem medições. */
  spark: SparkSeries | null;
  uptime24h: number | null;
  uptime30d: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Medição mais nova deste ponto (ISO 8601). */
  lastAt: string | null;
}

export interface StatusServiceDetail {
  components: StatusComponentRow[];
  /** Abertos e os resolvidos dos últimos 30 dias, mais recentes primeiro. */
  incidents: StatusIncidentRow[];
  /** Medições próprias do serviço, na ordem do catálogo. */
  targets: StatusTargetRow[];
  /** Alvo principal medido de cada ponto (servidor primeiro, depois os agentes com medições nas últimas 24 h). */
  vantages: { targetLabel: string; rows: StatusVantageRow[] } | null;
  /** Etapas do HTTP medido pelo servidor nas últimas 24 h, em passos de 30 min. */
  phases: PhaseSeries | null;
  /** true = o serviço tem um destino que o traceroute sob demanda aceita. */
  traceable: boolean;
  /** A rota mais nova gravada até o destino (fase 5), com a inferência de onde o serviço é servido. */
  route: StatusRouteDetail | null;
  /** Rota BGP do endereço medido, da última coleta do RIPEstat ("140.82.112.0/20 · AS36459 · vista por 243 de 244 coletores"). */
  bgp: { text: string; status: ServiceStatus } | null;
}

const EMPTY_DETAIL: StatusServiceDetail = { components: [], incidents: [], targets: [], vantages: null, phases: null, traceable: false, route: null, bgp: null };

export interface StatusRouteHopRow {
  ttl: number;
  ip: string | null;
  rttMs: number | null;
  asn: number | null;
  asName: string | null;
  rdns: string | null;
  city: string | null;
  country: string | null;
  /** Outros IPs no mesmo salto (ECMP). */
  altIps: string[];
  /** PEERING | IX | INTL_EDGE | CORE | AGGREGATION | ACCESS */
  role: string | null;
}

export interface StatusRouteDetail {
  at: string;
  host: string;
  destIp: string | null;
  tool: string | null;
  reached: boolean;
  destRttMs: number | null;
  /** DOMESTIC | OPERATOR_CACHE | INTERNATIONAL | UNDETERMINED */
  verdict: string;
  summary: string;
  destCountry: string | null;
  cableName: string | null;
  candidates: string[];
  /** HIGH | MEDIUM | LOW */
  confidence: string | null;
  error: string | null;
  /** Modo das sondas: udp | paris | tcp | union. */
  mode: string | null;
  /** Rota que não chegou: o TTL do último roteador que respondeu. */
  lastVisibleTtl: number | null;
  /** Onde a rota passa de uma rede para outra (fase 8): "Embratel → Google em Rio de Janeiro (peering direto)". */
  interconnections: string[];
  /** Borda do CDN que atendeu a última sonda HTTP do servidor (fase 8). */
  edge: { provider: string; pop: string | null; city: string | null } | null;
  /** Trechos de 7 dias com a mesma rota, do mais novo ao mais antigo (fase 9). */
  history: { from: string; to: string; asPath: string | null; place: string; traces: number }[];
  /** Resumo dos últimos 30 dias (fase 10, tabela RouteDaily); null até o primeiro dia fechado. */
  monthly: { days: number; abroadDays: number; pathChanges: number; exits: string[]; avgDestRttMs: number | null } | null;
  /** A rota mais nova vista de cada agente (fase 10): o mesmo serviço a partir de outra rede. */
  agents: { vantage: string; label: string; at: string; verdict: string; summary: string; reached: boolean; destRttMs: number | null; hops: number }[];
  hops: StatusRouteHopRow[];
  /** Página do mapa de cabos (atribuição dos dados dos cabos). */
  cableSource: string;
}

function parseIpList(json: string | null): string[] {
  if (!json) return [];
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A rota mais nova de cada agente até o serviço, já analisada pelo servidor (as pendentes ficam de fora). */
async function loadAgentRoutes(serviceId: string): Promise<StatusRouteDetail["agents"]> {
  const latest = await prisma.routeTrace.groupBy({
    by: ["vantage"],
    where: { serviceId, vantage: { startsWith: AGENT_VANTAGE_PREFIX }, verdict: { not: "PENDING" }, at: { gte: new Date(Date.now() - 2 * DAY_MS) } },
    _max: { at: true },
  });
  if (!latest.length) return [];
  const traces = await prisma.routeTrace.findMany({
    where: { serviceId, OR: latest.map((l) => ({ vantage: l.vantage, at: l._max.at ?? new Date(0) })) },
    include: { _count: { select: { hops: true } } },
  });
  const labels = await agentLabels(traces.map((t) => agentIdOf(t.vantage)).filter((id): id is string => !!id));
  return traces
    .map((t) => ({
      vantage: t.vantage,
      label: labels.get(agentIdOf(t.vantage) ?? "") ?? `Agente ${agentIdOf(t.vantage)?.slice(0, 8) ?? ""}`.trim(),
      at: t.at.toISOString(),
      verdict: t.verdict,
      summary: t.summary,
      reached: t.reached,
      destRttMs: t.destRttMs,
      hops: t._count.hops,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function loadRoute(serviceId: string): Promise<StatusRouteDetail | null> {
  const t = await prisma.routeTrace.findFirst({ where: { serviceId, vantage: "server" }, orderBy: { at: "desc" }, include: { hops: { orderBy: { ttl: "asc" } } } });
  if (!t) return null;
  const lastEdge = await prisma.probeCheck.findFirst({ where: { vantage: "server", edge: { not: null }, target: { serviceId, kind: "HTTP" } }, orderBy: { at: "desc" }, select: { edge: true } });
  const edge = parseEdge(lastEdge?.edge);
  const destAsn = Number(t.asPath?.split(" ").pop()) || null;
  const week = await prisma.routeTrace.findMany({
    where: { serviceId, vantage: "server", error: null, at: { gte: new Date(Date.now() - 7 * 24 * 3_600_000) } },
    select: { at: true, asPath: true, verdict: true, cableName: true, destCountry: true },
  });
  const history = pathHistory(week.map((w) => ({ ...w, at: w.at.getTime() })))
    .slice(0, 8)
    .map((h) => ({ ...h, from: new Date(h.from).toISOString(), to: new Date(h.to).toISOString() }));
  const [monthly, agents] = await Promise.all([monthlyRoutes(serviceId).catch(() => null), loadAgentRoutes(serviceId)]);
  return {
    at: t.at.toISOString(),
    host: t.host,
    destIp: t.destIp,
    tool: t.tool,
    reached: t.reached,
    destRttMs: t.destRttMs,
    verdict: t.verdict,
    summary: t.summary,
    destCountry: t.destCountry,
    cableName: t.cableName,
    candidates: t.candidates ? t.candidates.split(" · ").filter((c) => c && c !== t.cableName) : [],
    confidence: t.confidence,
    error: t.error,
    mode: t.mode,
    lastVisibleTtl: t.lastVisibleTtl,
    interconnections: interconnections(t.hops, { asn: destAsn, asName: null }).map(interconnectionText),
    edge: edge && { provider: edge.provider, pop: edge.pop, city: edge.city },
    history,
    monthly,
    agents,
    hops: t.hops.map((h) => ({ ttl: h.ttl, ip: h.ip, rttMs: h.rttMs, asn: h.asn, asName: h.asName, rdns: h.rdns, city: h.city, country: h.country, altIps: parseIpList(h.altIps), role: h.role })),
    cableSource: CABLE_MAP_PAGE,
  };
}
/** Serviço da faixa "Internet no Brasil" cujos componentes são as rotas BGP dos outros serviços. */
const BGP_SERVICE_SLUG = "rotas-bgp";
const PHASE_STEP_MIN = 30;

/** Nome dos agentes pelo id, da tabela Agents do host .NET (só existe no banco canônico; fora dele, nomes genéricos). */
async function agentLabels(ids: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (!ids.length) return labels;
  try {
    const rows = await prisma.$queryRawUnsafe<{ Id: string; Label: string }[]>(
      `SELECT "Id", "Label" FROM "Agents" WHERE lower("Id") IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    );
    for (const row of rows) labels.set(String(row.Id).toLowerCase(), String(row.Label));
  } catch {
    // Sem a tabela do host .NET (instalação só com o motor): fica o nome genérico.
  }
  return labels;
}

/** Alvo principal medido por ponto: o servidor (do histórico já carregado) e os agentes, cada um com a sua ponta viva. */
async function loadVantages(main: { id: string }, serverPoints: RollupPoint[], end: Date): Promise<StatusVantageRow[]> {
  const now = end.getTime();
  const [agentRollups, totals, lastServer] = await Promise.all([
    prisma.probeRollup.findMany({
      where: { targetId: main.id, vantage: { startsWith: AGENT_VANTAGE_PREFIX }, bucket: { gte: new Date(now - DAY_MS) } },
      select: { vantage: true, bucket: true, samples: true, failures: true, p50Ms: true, p95Ms: true },
    }),
    prisma.probeRollup.groupBy({ by: ["vantage"], where: { targetId: main.id, bucket: { gte: new Date(now - 30 * DAY_MS) } }, _sum: { samples: true, failures: true } }),
    prisma.probeCheck.findFirst({ where: { targetId: main.id, vantage: SERVER_VANTAGE }, orderBy: { at: "desc" }, select: { at: true } }),
  ]);
  const recentAgents = await prisma.probeCheck.groupBy({
    by: ["vantage"],
    where: { targetId: main.id, vantage: { startsWith: AGENT_VANTAGE_PREFIX }, at: { gte: new Date(now - DAY_MS) } },
    _max: { at: true },
  });
  const byVantage = new Map<string, RollupPoint[]>();
  for (const { vantage, ...point } of agentRollups) {
    const list = byVantage.get(vantage);
    if (list) list.push(point);
    else byVantage.set(vantage, [point]);
  }
  const lastAt = new Map(recentAgents.map((r) => [r.vantage, r._max.at]));
  const vantages = [...new Set([...byVantage.keys(), ...lastAt.keys()])].filter((v) => agentIdOf(v) !== null).sort();
  const labels = await agentLabels(vantages.map((v) => agentIdOf(v)!));
  const total = new Map(totals.map((r) => [r.vantage, r._sum]));

  const rows: StatusVantageRow[] = [
    {
      id: SERVER_VANTAGE,
      label: "Servidor",
      server: true,
      spark: sparkOf(serverPoints, end),
      uptime24h: uptimeOf(serverPoints),
      uptime30d: uptimeFromTotals(total.get(SERVER_VANTAGE)?.samples, total.get(SERVER_VANTAGE)?.failures),
      ...latencySummary(serverPoints),
      lastAt: lastServer?.at.toISOString() ?? null,
    },
  ];
  for (const vantage of vantages) {
    const stored = byVantage.get(vantage) ?? [];
    const tailStart = liveTailStart(stored.map((p) => p.bucket.getTime()), now);
    const checks = await prisma.probeCheck.findMany({
      where: { targetId: main.id, vantage, at: { gte: new Date(tailStart), lte: end } },
      select: { targetId: true, at: true, ok: true, latencyMs: true, lossPct: true },
    });
    const points = [...stored.filter((p) => p.bucket.getTime() < tailStart || p.bucket.getTime() > now), ...(tailPoints(checks).get(main.id) ?? [])];
    const id = agentIdOf(vantage)!;
    const sum = total.get(vantage);
    rows.push({
      id: vantage,
      label: labels.get(id) ?? `PC ${id.slice(0, 8)}`,
      server: false,
      spark: sparkOf(points, end),
      uptime24h: uptimeOf(points),
      uptime30d: uptimeFromTotals(sum?.samples, sum?.failures),
      ...latencySummary(points),
      lastAt: lastAt.get(vantage)?.toISOString() ?? null,
    });
  }
  return rows;
}

type DetailTarget = Prisma.ProbeTargetGetPayload<object>;
type LastCheck = Prisma.ProbeCheckGetPayload<object> | null;

/** Uma linha de alvo do detalhe, com o histórico de 24 h, a última medição e a disponibilidade de 30 dias. */
function targetRow(t: DetailTarget, ctx: { points: RollupPoint[]; historyEnd: Date | null; last: LastCheck; gateway: string | null; uptime30d: number | null }): StatusTargetRow {
  const spec = { kind: t.kind as ProbeKind, host: t.host, url: t.url, port: t.port };
  const { points, last } = ctx;
  return {
    key: t.key,
    kind: spec.kind,
    label: targetLabel(spec),
    address: targetAddress(spec, ctx.gateway),
    status: t.status as TargetStatus,
    statusReason: t.statusReason,
    lastCheckAt: t.lastCheckAt?.toISOString() ?? null,
    lastLatencyMs: t.lastLatencyMs,
    lastError: t.lastError,
    intervalSec: t.intervalSec,
    uptime24h: uptimeOf(points),
    uptime30d: ctx.uptime30d,
    ...latencySummary(points),
    last: last && {
      at: last.at.toISOString(),
      ok: last.ok,
      httpStatus: last.httpStatus,
      dnsMs: last.dnsMs,
      connectMs: last.connectMs,
      tlsMs: last.tlsMs,
      ttfbMs: last.ttfbMs,
      totalMs: last.totalMs,
      lossPct: last.lossPct,
      jitterMs: last.jitterMs,
      certDays: last.certDays,
    },
    spark: ctx.historyEnd ? sparkOf(points, ctx.historyEnd) : null,
  };
}

export async function getGlobalStatusDetail(slug: string): Promise<StatusServiceDetail> {
  await requireSession();
  if (typeof slug !== "string" || !slug) return EMPTY_DETAIL;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const service = await prisma.statusService.findUnique({
    where: { slug },
    include: {
      components: { orderBy: [{ groupName: "asc" }, { position: "asc" }] },
      incidents: {
        where: { OR: [{ resolvedAt: null }, { resolvedAt: { gte: since } }] },
        orderBy: { startedAt: "desc" },
        take: 50,
      },
      targets: { where: { enabled: true } },
    },
  });
  if (!service) return EMPTY_DETAIL;

  // Com as medições desligadas não há alvos a listar: o que está gravado neles é de antes.
  const measuring = probesEnabled(process.env.GLOBAL_STATUS_PROBES);
  const targets = measuring ? sortByCatalog(service.targets.map((t) => ({ ...t, serviceSlug: service.slug })), STATUS_CATALOG) : [];
  const [history, gateway, lasts] = await Promise.all([
    targets.length ? getHistory() : null,
    // Só o alvo "gateway padrão" precisa do IP descoberto (a descoberta tem cache próprio e nunca lança).
    targets.some((t) => t.host === AUTO_GATEWAY) ? defaultGateway() : null,
    // A medição mais nova de cada alvo: um serviço tem dois alvos, e cada busca usa o índice (targetId, at).
    Promise.all(targets.map((t) => prisma.probeCheck.findFirst({ where: { targetId: t.id, vantage: SERVER_VANTAGE }, orderBy: { at: "desc" } }))),
  ]);
  const end = history?.end ?? new Date();
  const main = mainLatencyTarget(targets);
  const http = targets.find((t) => t.kind === "HTTP");
  const [vantages, phaseChecks, totals30d] = await Promise.all([
    main ? loadVantages(main, history?.points.get(main.id) ?? [], end) : null,
    http
      ? prisma.probeCheck.findMany({
          where: { targetId: http.id, vantage: SERVER_VANTAGE, at: { gte: new Date(end.getTime() - DAY_MS) } },
          select: { at: true, ok: true, dnsMs: true, connectMs: true, tlsMs: true, ttfbMs: true },
        })
      : null,
    targets.length
      ? prisma.probeRollup.groupBy({
          by: ["targetId"],
          where: { targetId: { in: targets.map((t) => t.id) }, vantage: SERVER_VANTAGE, bucket: { gte: new Date(end.getTime() - 30 * DAY_MS) } },
          _sum: { samples: true, failures: true },
        })
      : [],
  ]);
  const uptime30d = new Map(totals30d.map((r) => [r.targetId, uptimeFromTotals(r._sum.samples, r._sum.failures)]));
  const [route, trace] = await Promise.all([
    prisma.statusComponent.findFirst({ where: { externalId: service.slug, service: { slug: BGP_SERVICE_SLUG } }, select: { name: true, status: true } }),
    measuring && routesEnabled() ? loadRoute(service.id) : null,
  ]);

  return {
    components: service.components.map((c) => ({ name: c.name, groupName: c.groupName, status: c.status as ServiceStatus })),
    incidents: service.incidents.map((i) => incidentRow({ ...i, service: { slug: service.slug, name: service.name } })),
    targets: targets.map((t, index) => targetRow(t, { points: history?.points.get(t.id) ?? [], historyEnd: history?.end ?? null, last: lasts[index], gateway, uptime30d: uptime30d.get(t.id) ?? null })),
    vantages: main && vantages ? { targetLabel: targetLabel({ kind: main.kind as ProbeKind, port: main.port }), rows: vantages } : null,
    phases: phaseChecks ? buildPhaseSeries(phaseChecks, { end, hours: SPARK_HOURS, stepMin: PHASE_STEP_MIN }) : null,
    traceable: measuring && routesEnabled() && traceHost(targets) !== null,
    route: trace,
    // O nome do componente é "<serviço> · <rota>": no detalhe do próprio serviço fica só a rota.
    bgp: route ? { text: route.name.startsWith(`${service.name} · `) ? route.name.slice(service.name.length + 3) : route.name, status: route.status as ServiceStatus } : null,
  };
}

/** Rotas e trânsito de todos os serviços (fases 8 e 9): seção "Rotas e trânsito" da página. */
export async function getRouteOverview(): Promise<RouteOverview | null> {
  await requireSession();
  if (!probesEnabled(process.env.GLOBAL_STATUS_PROBES) || !routesEnabled()) return null;
  return loadRouteOverview();
}

/** Segunda opinião do RIPE Atlas (fase 10): sondas públicas no Brasil até o mesmo destino. Sob demanda, em cache por 6 h. */
/** Banda da rede local (iperf3) por agente, dos testes dos últimos 30 dias. Vazia sem testes ou sem a tabela. */
export async function getThroughput(): Promise<ThroughputSummary[]> {
  await requireSession();
  const now = Date.now();
  const rows = await prisma.throughputTest
    .findMany({ where: { at: { gte: new Date(now - THROUGHPUT_KEEP_MS) } }, orderBy: { at: "desc" }, take: 2000 })
    .catch(() => []);
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => agentIdOf(r.vantage)).filter((id): id is string => !!id))];
  const names = await agentLabels(ids);
  const labels = new Map<string, string>();
  for (const r of rows) {
    const id = agentIdOf(r.vantage);
    if (id && names.has(id)) labels.set(r.vantage, names.get(id)!);
  }
  return summarizeThroughput(rows, labels, now);
}

export async function compareRouteWithAtlas(slug: string): Promise<AtlasComparison | null> {
  await requireSession();
  if (typeof slug !== "string" || !slug || !routesEnabled()) return null;
  const service = await prisma.statusService.findUnique({ where: { slug }, select: { id: true } });
  if (!service) return null;
  const t = await prisma.routeTrace.findFirst({ where: { serviceId: service.id, vantage: "server", error: null }, orderBy: { at: "desc" }, select: { host: true, destRttMs: true, verdict: true, asPath: true } });
  if (!t) return null;
  const ispAsn = Number(t.asPath?.split(" ")[0]) || null;
  return atlasCompare(t.host, { rttMs: t.destRttMs, verdict: t.verdict, ispAsn });
}

/** Rastreia a rota até o serviço agora ("Rastrear rota"), grava e devolve a rota interpretada. */
export async function traceServiceRoute(slug: string): Promise<StatusRouteDetail | null> {
  await requirePermission("network.operate");
  if (typeof slug !== "string" || !slug || !routesEnabled()) return null;
  const id = await traceServiceNow(slug);
  if (!id) return null;
  const trace = await prisma.routeTrace.findUnique({ where: { id }, select: { serviceId: true } });
  return trace ? loadRoute(trace.serviceId) : null;
}

/** Consulta todas as fontes oficiais e mede todos os alvos agora, ignorando intervalos, agenda e cache. */
export async function refreshGlobalStatusNow(): Promise<void> {
  await requirePermission("network.operate");
  try {
    await Promise.all([checkGlobalStatus(true), runProbesNow()]);
  } finally {
    // As medições novas entram na próxima consulta da página, sem esperar o minuto do cache.
    g.__globalStatusHistory = undefined;
  }
}

/** O que a tela de configuração do Status global mostra e edita. */
export interface GlobalStatusConfig {
  settings: GlobalStatusSettings;
  /** A operadora descoberta pelo IP público do servidor (ou a informada), da última consulta. */
  isp: { asn: number; name: string | null } | null;
  /** O e-mail sai pela configuração de Alertas → Configurar e-mails: chave do Resend e destinatário. */
  email: { ready: boolean; to: string | null };
  services: { slug: string; name: string; category: string; enabled: boolean }[];
  /** Ferramenta da rota até os serviços (fase 7): traceroute, modo TCP e a última rota gravada. */
  routeTool: RouteToolState | null;
  routesEnabled: boolean;
}

async function loadConfig(): Promise<GlobalStatusConfig> {
  await ensureCatalogSeeded();
  const [settings, isp, email, services, routeTool] = await Promise.all([
    getGlobalStatusSettings(),
    storedIsp(),
    getEmailAlertConfig(),
    prisma.statusService.findMany({ orderBy: { position: "asc" }, select: { slug: true, name: true, category: true, enabled: true } }),
    readRouteToolState(),
  ]);
  return {
    settings,
    isp: isp && { asn: isp.asn, name: isp.name },
    email: { ready: !!email.apiKey && !!email.to.trim(), to: email.to.trim() || null },
    services,
    routeTool,
    routesEnabled: routesEnabled(),
  };
}

export async function getGlobalStatusConfig(): Promise<GlobalStatusConfig> {
  await requirePermission("settings.manage");
  return loadConfig();
}

/** Grava a configuração e quais serviços são acompanhados (os desligados somem da página e param de ser consultados e medidos). */
export async function saveGlobalStatusConfig(input: { settings: GlobalStatusSettings; enabled: Record<string, boolean> }): Promise<GlobalStatusConfig> {
  await requirePermission("settings.manage");
  const settings = normalizeGlobalStatusSettings(input?.settings);
  const enabled = input?.enabled && typeof input.enabled === "object" ? input.enabled : {};
  const known = new Set(STATUS_CATALOG.map((e) => e.slug));
  const on = Object.keys(enabled).filter((slug) => known.has(slug) && enabled[slug] === true);
  const off = Object.keys(enabled).filter((slug) => known.has(slug) && enabled[slug] === false);
  await serialized(() =>
    prisma.$transaction([
      prisma.statusService.updateMany({ where: { slug: { in: on } }, data: { enabled: true } }),
      prisma.statusService.updateMany({ where: { slug: { in: off } }, data: { enabled: false } }),
    ]),
  );
  await saveGlobalStatusSettings(settings);
  // A página e o histórico refletem os serviços novos já na próxima consulta.
  g.__globalStatusHistory = undefined;
  return loadConfig();
}
