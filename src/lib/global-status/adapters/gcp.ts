import { toDate, worstStatus, type IncidentImpact, type NormalizedComponent, type NormalizedIncident, type OfficialSnapshot, type ServiceStatus } from "../types";

/**
 * Adaptador do Google Cloud (`status.cloud.google.com/incidents.json`). O Firebase publica o mesmo
 * formato em `status.firebase.google.com`, então o site e o nome vêm de quem chama.
 */

export interface GcpSite {
  /** Raiz do painel de status, sem barra no fim (os `uri` dos incidentes são relativos a ela). */
  url: string;
  /** Nome do produto, usado quando o incidente não traz descrição. */
  name: string;
}

const GOOGLE_CLOUD: GcpSite = { url: "https://status.cloud.google.com", name: "Google Cloud" };

interface GcpIncident {
  id: string;
  begin?: string;
  end?: string | null;
  external_desc?: string;
  status_impact?: string;
  severity?: string;
  uri?: string;
  most_recent_update?: { status?: string };
  affected_products?: { id: string; title: string }[];
}

/** Janela de incidentes resolvidos que ainda vale mostrar no histórico. */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

const SEVERITY: Record<string, IncidentImpact> = { low: "MINOR", medium: "MAJOR", high: "CRITICAL" };

function impactStatus(impact: string | undefined): ServiceStatus {
  return impact === "SERVICE_OUTAGE" ? "DOWN" : "DEGRADED";
}

/** Componentes = produtos afetados agora (o Google não publica a lista de produtos com status). */
function affectedProducts(active: GcpIncident[]): NormalizedComponent[] {
  const byProduct = new Map<string, NormalizedComponent>();
  for (const inc of active) {
    const status = impactStatus(inc.status_impact);
    for (const p of inc.affected_products ?? []) {
      const prev = byProduct.get(p.id);
      byProduct.set(p.id, {
        externalId: p.id,
        name: p.title,
        groupName: null,
        status: prev ? worstStatus([prev.status, status]) : status,
        position: prev?.position ?? byProduct.size,
      });
    }
  }
  return Array.from(byProduct.values());
}

/** Incidente normalizado, ou null quando é inválido ou foi resolvido há mais de 30 dias. */
function toIncident(inc: GcpIncident, now: Date, site: GcpSite): NormalizedIncident | null {
  const startedAt = toDate(inc.begin);
  if (!inc.id || !startedAt) return null;
  const resolvedAt = toDate(inc.end);
  if (resolvedAt && now.getTime() - resolvedAt.getTime() > RECENT_MS) return null;
  const products = (inc.affected_products ?? []).map((p) => p.title);
  const state = resolvedAt ? "resolved" : (inc.most_recent_update?.status ?? "investigating").toLowerCase();
  return {
    externalId: inc.id,
    title: (inc.external_desc ?? `Incidente no ${site.name}`).trim().split("\n")[0].slice(0, 300),
    impact: SEVERITY[inc.severity ?? ""] ?? "MINOR",
    state,
    url: inc.uri ? `${site.url}/${inc.uri}` : null,
    affected: products.length ? products.slice(0, 8).join(" · ") : null,
    startedAt,
    resolvedAt,
  };
}

export function parseGcpIncidents(data: GcpIncident[], now = new Date(), site: GcpSite = GOOGLE_CLOUD): OfficialSnapshot {
  const list = Array.isArray(data) ? data : [];
  const active = list.filter((i) => !i.end);
  const incidents = list.map((i) => toIncident(i, now, site)).filter((i): i is NormalizedIncident => i !== null);
  const status = active.length ? worstStatus(active.map((i) => impactStatus(i.status_impact))) : "OK";
  const description = active.length
    ? `${active.length} incidente${active.length > 1 ? "s" : ""} em andamento`
    : "Todos os serviços operando normalmente";
  return { status, description, components: affectedProducts(active), incidents };
}
