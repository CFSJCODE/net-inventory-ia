"use server";

import { requirePermission, requireSession } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { STATUS_CATALOG } from "@/lib/global-status/catalog";
import { checkGlobalStatus, ensureCatalogSeeded } from "@/lib/global-status/collector";
import { SERVER_VANTAGE, sortByCatalog } from "@/lib/global-status/probe-logic";
import { getLocalConnectivity, runProbesNow } from "@/lib/global-status/probe-runner";
import { defaultGateway } from "@/lib/global-status/probes";
import { buildSeries, latencySummary, mainLatencyTarget, tailPoints, uptimeOf, type RollupPoint, type SparkSeries } from "@/lib/global-status/series";
import { BUCKET_MS, bucketStart } from "@/lib/global-status/stats";
import { AUTO_GATEWAY, STATUS_SEVERITY, targetAddress, targetLabel, type LocalConnectivity, type ProbeKind, type ServiceStatus, type TargetStatus } from "@/lib/global-status/types";

export interface StatusComponentRow {
  name: string;
  groupName: string | null;
  status: ServiceStatus;
}

export interface StatusIncidentRow {
  id: string;
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
  /** Mediana e p95 da latência nas últimas 24 h, em ms. */
  p50Ms: number | null;
  p95Ms: number | null;
  last: StatusTargetLast | null;
  /** Latência das últimas 24 h, em passos de 15 min; null sem medições. */
  spark: SparkSeries | null;
}

export interface GlobalStatusData {
  /** Todos os serviços habilitados, inclusive os da categoria INTERNET (base da faixa "Sua Internet"). */
  services: StatusServiceRow[];
  /** Incidentes e manutenções em aberto em todos os serviços, mais recentes primeiro. */
  incidents: StatusIncidentRow[];
  /** Conexão do próprio servidor: quando não está "ok", as medições dos serviços ficam pausadas. */
  connectivity: LocalConnectivity;
}

function incidentRow(i: { id: string; title: string; impact: string; state: string; url: string | null; affected: string | null; startedAt: Date; resolvedAt: Date | null; service: { slug: string; name: string } }): StatusIncidentRow {
  return {
    id: i.id,
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
    let newest = 0;
    for (const { targetId, ...point } of rollups) {
      points.get(targetId)?.push(point);
      newest = Math.max(newest, point.bucket.getTime());
    }
    // Ponta viva: o que foi medido depois da última janela gravada (o agendador grava cada janela cerca de 1 min depois de ela fechar).
    const tailStart = Math.max(newest ? newest + BUCKET_MS : 0, bucketStart(now - TAIL_MAX_MS));
    const checks = await prisma.probeCheck.findMany({
      where: { targetId: { in: ids }, vantage: SERVER_VANTAGE, at: { gte: new Date(tailStart) } },
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
  if (cached && now - cached.at < HISTORY_CACHE_MS) return cached.data;
  const data: Promise<History> = loadHistory(now).catch((err) => {
    // Sem o histórico a página ainda mostra o status de cada serviço; os gráficos voltam na próxima consulta que der certo.
    if (g.__globalStatusHistory?.data === data) g.__globalStatusHistory = undefined;
    console.warn(`[global-status] histórico das medições indisponível: ${err instanceof Error ? err.message : String(err)}`);
    return { points: new Map(), services: new Map(), end: new Date(now) };
  });
  g.__globalStatusHistory = { at: now, data };
  return data;
}

export async function getGlobalStatus(): Promise<GlobalStatusData> {
  await requireSession();
  // Primeira abertura antes do monitor terminar a primeira rodada: os cards já aparecem como "Verificando".
  await ensureCatalogSeeded();

  const [services, counts, problems, open, history] = await Promise.all([
    prisma.statusService.findMany({ where: { enabled: true }, orderBy: { position: "asc" } }),
    prisma.statusComponent.groupBy({ by: ["serviceId", "status"], _count: { _all: true } }),
    prisma.statusComponent.findMany({ where: { status: { not: "OK" } }, orderBy: { position: "asc" } }),
    prisma.statusIncident.findMany({
      where: { resolvedAt: null, service: { enabled: true } },
      include: { service: { select: { slug: true, name: true } } },
      orderBy: { startedAt: "desc" },
    }),
    getHistory(),
  ]);

  const countsBy = new Map<string, Record<ServiceStatus, number>>();
  for (const c of counts) {
    const row = countsBy.get(c.serviceId) ?? emptyCounts();
    row[c.status as ServiceStatus] = (row[c.status as ServiceStatus] ?? 0) + c._count._all;
    countsBy.set(c.serviceId, row);
  }

  return {
    services: services.map((s) => ({
      slug: s.slug,
      name: s.name,
      category: s.category,
      status: s.status as ServiceStatus,
      hasSource: s.sourceType !== "NONE",
      officialStatus: s.officialStatus,
      officialState: (s.officialState as ServiceStatus | null) ?? null,
      measuredStatus: (s.measuredStatus as ServiceStatus | null) ?? null,
      measuredReason: s.measuredReason,
      latencyMs: s.latencyMs,
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
      openIncidents: open.filter((i) => i.service.slug === s.slug).length,
    })),
    incidents: open.map(incidentRow),
    connectivity: getLocalConnectivity(),
  };
}

export interface StatusServiceDetail {
  components: StatusComponentRow[];
  /** Abertos e os resolvidos dos últimos 30 dias, mais recentes primeiro. */
  incidents: StatusIncidentRow[];
  /** Medições próprias do serviço, na ordem do catálogo. */
  targets: StatusTargetRow[];
}

export async function getGlobalStatusDetail(slug: string): Promise<StatusServiceDetail> {
  await requireSession();
  if (typeof slug !== "string" || !slug) return { components: [], incidents: [], targets: [] };
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
  if (!service) return { components: [], incidents: [], targets: [] };

  const targets = sortByCatalog(service.targets.map((t) => ({ ...t, serviceSlug: service.slug })), STATUS_CATALOG);
  const [history, gateway, lasts] = await Promise.all([
    getHistory(),
    // Só o alvo "gateway padrão" precisa do IP descoberto (a descoberta tem cache próprio e nunca lança).
    targets.some((t) => t.host === AUTO_GATEWAY) ? defaultGateway() : null,
    // A medição mais nova de cada alvo: um serviço tem dois alvos, e cada busca usa o índice (targetId, at).
    Promise.all(targets.map((t) => prisma.probeCheck.findFirst({ where: { targetId: t.id, vantage: SERVER_VANTAGE }, orderBy: { at: "desc" } }))),
  ]);

  return {
    components: service.components.map((c) => ({ name: c.name, groupName: c.groupName, status: c.status as ServiceStatus })),
    incidents: service.incidents.map((i) => incidentRow({ ...i, service: { slug: service.slug, name: service.name } })),
    targets: targets.map((t, index): StatusTargetRow => {
      const spec = { kind: t.kind as ProbeKind, host: t.host, url: t.url, port: t.port };
      const points = history.points.get(t.id) ?? [];
      const last = lasts[index];
      return {
        key: t.key,
        kind: spec.kind,
        label: targetLabel(spec),
        address: targetAddress(spec, gateway),
        status: t.status as TargetStatus,
        statusReason: t.statusReason,
        lastCheckAt: t.lastCheckAt?.toISOString() ?? null,
        lastLatencyMs: t.lastLatencyMs,
        lastError: t.lastError,
        intervalSec: t.intervalSec,
        uptime24h: uptimeOf(points),
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
        spark: sparkOf(points, history.end),
      };
    }),
  };
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
