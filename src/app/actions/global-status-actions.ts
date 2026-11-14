"use server";

import { requirePermission, requireSession } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { checkGlobalStatus, seedStatusCatalog } from "@/lib/global-status/collector";
import { STATUS_SEVERITY, type ServiceStatus } from "@/lib/global-status/types";

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
  status: ServiceStatus;
  officialStatus: string | null;
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

export interface GlobalStatusData {
  services: StatusServiceRow[];
  /** Incidentes e manutenções em aberto em todos os serviços, mais recentes primeiro. */
  incidents: StatusIncidentRow[];
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
      officialStatus: s.officialStatus,
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
  };
}

export interface StatusServiceDetail {
  components: StatusComponentRow[];
  /** Abertos e os resolvidos dos últimos 30 dias, mais recentes primeiro. */
  incidents: StatusIncidentRow[];
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
  if (!service) return { components: [], incidents: [] };
  return {
    components: service.components.map((c) => ({ name: c.name, groupName: c.groupName, status: c.status as ServiceStatus })),
    incidents: service.incidents.map((i) => incidentRow({ ...i, service: { slug: service.slug, name: service.name } })),
  };
}

/** Consulta todas as fontes oficiais agora, ignorando intervalos e cache. */
export async function refreshGlobalStatusNow(): Promise<void> {
  await requirePermission("network.operate");
  await checkGlobalStatus(true);
}
