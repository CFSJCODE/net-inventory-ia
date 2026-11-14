"use server";

import { requirePermission, requireSession } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { checkGlobalStatus, seedStatusCatalog } from "@/lib/global-status/collector";
import { getLocalConnectivity } from "@/lib/global-status/probe-runner";
import type { SparkSeries } from "@/lib/global-status/series";
import { STATUS_SEVERITY, type LocalConnectivity, type ProbeKind, type ServiceStatus, type TargetStatus } from "@/lib/global-status/types";

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

export async function getGlobalStatus(): Promise<GlobalStatusData> {
  await requireSession();
  // Primeira abertura antes do monitor terminar a primeira rodada: os cards já aparecem como "Verificando".
  if ((await prisma.statusService.count()) === 0) await seedStatusCatalog();

  const [services, counts, problems, open] = await Promise.all([
    prisma.statusService.findMany({ where: { enabled: true }, orderBy: { position: "asc" } }),
    prisma.statusComponent.groupBy({ by: ["serviceId", "status"], _count: { _all: true } }),
    prisma.statusComponent.findMany({ where: { status: { not: "OK" } }, orderBy: { position: "asc" } }),
    prisma.statusIncident.findMany({
      where: { resolvedAt: null, service: { enabled: true } },
      include: { service: { select: { slug: true, name: true } } },
      orderBy: { startedAt: "desc" },
    }),
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
      uptime24h: null,
      spark: null,
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
    },
  });
  if (!service) return { components: [], incidents: [], targets: [] };
  return {
    components: service.components.map((c) => ({ name: c.name, groupName: c.groupName, status: c.status as ServiceStatus })),
    incidents: service.incidents.map((i) => incidentRow({ ...i, service: { slug: service.slug, name: service.name } })),
    targets: [],
  };
}

/** Consulta todas as fontes oficiais agora, ignorando intervalos e cache. */
export async function refreshGlobalStatusNow(): Promise<void> {
  await requirePermission("network.operate");
  await checkGlobalStatus(true);
}
