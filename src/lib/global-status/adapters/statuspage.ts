import { toDate, type IncidentImpact, type NormalizedComponent, type NormalizedIncident, type OfficialSnapshot, type ServiceStatus } from "../types";

/**
 * Adaptador do formato Atlassian Statuspage (`/api/v2/summary.json`), usado por Cloudflare, Akamai,
 * GitHub, Discord, Reddit, Twitch e, em formato compatível, pela OpenAI (incident.io).
 */

interface SpComponent {
  id: string;
  name: string;
  status: string;
  position?: number;
  group?: boolean;
  group_id?: string | null;
}

interface SpIncident {
  id: string;
  name: string;
  status: string;
  impact?: string;
  shortlink?: string | null;
  created_at?: string;
  started_at?: string;
  scheduled_for?: string | null;
  resolved_at?: string | null;
  components?: { name: string }[];
}

export interface SpSummary {
  page?: { updated_at?: string };
  status?: { indicator?: string; description?: string };
  components?: SpComponent[];
  incidents?: SpIncident[];
  scheduled_maintenances?: SpIncident[];
}

const COMPONENT_STATUS: Record<string, ServiceStatus> = {
  operational: "OK",
  degraded_performance: "DEGRADED",
  partial_outage: "DEGRADED",
  major_outage: "DOWN",
  under_maintenance: "MAINTENANCE",
};

const INDICATOR_STATUS: Record<string, ServiceStatus> = {
  none: "OK",
  minor: "DEGRADED",
  major: "DOWN",
  critical: "DOWN",
  maintenance: "MAINTENANCE",
};

const IMPACT: Record<string, IncidentImpact> = {
  none: "MINOR",
  minor: "MINOR",
  major: "MAJOR",
  critical: "CRITICAL",
  maintenance: "MAINTENANCE",
};

/** Frases padrão da Statuspage em português; textos próprios do provedor ficam como vieram. */
const DESCRIPTION_PT: Record<string, string> = {
  "all systems operational": "Todos os sistemas operando",
  "partially degraded service": "Serviço parcialmente degradado",
  "partial system degradation": "Degradação parcial do sistema",
  "minor service outage": "Interrupção parcial do serviço",
  "partial system outage": "Interrupção parcial do sistema",
  "major service outage": "Interrupção grave do serviço",
  "major system outage": "Interrupção grave do sistema",
  "service under maintenance": "Serviço em manutenção",
};

export function componentStatus(raw: string | undefined): ServiceStatus {
  return (raw && COMPONENT_STATUS[raw]) || "UNKNOWN";
}

function incident(raw: SpIncident, maintenance: boolean): NormalizedIncident | null {
  const startedAt = toDate(raw.started_at) ?? toDate(raw.scheduled_for) ?? toDate(raw.created_at);
  if (!raw.id || !raw.name || !startedAt) return null;
  const names = (raw.components ?? []).map((c) => c.name).filter(Boolean);
  return {
    externalId: raw.id,
    title: raw.name,
    impact: maintenance ? "MAINTENANCE" : IMPACT[raw.impact ?? "minor"] ?? "MINOR",
    state: raw.status,
    url: raw.shortlink ?? null,
    affected: names.length ? names.slice(0, 8).join(" · ") : null,
    startedAt,
    resolvedAt: toDate(raw.resolved_at),
  };
}

/** Manutenção acontecendo agora (em andamento ou em verificação final). */
function isActiveMaintenance(m: SpIncident): boolean {
  return m.status === "in_progress" || m.status === "verifying";
}

/** Traduz o summary.json para o formato normalizado. */
export function parseStatuspageSummary(data: SpSummary): OfficialSnapshot {
  const all = data.components ?? [];
  const groups = new Map(all.filter((c) => c.group).map((c) => [c.id, c.name]));
  // Os grupos são agregados dos filhos: grava só os componentes reais, com o nome do grupo ao lado.
  const components: NormalizedComponent[] = all
    .filter((c) => !c.group && c.id && c.name)
    .map((c, i) => ({
      externalId: c.id,
      name: c.name,
      groupName: (c.group_id && groups.get(c.group_id)) || null,
      status: componentStatus(c.status),
      position: c.position ?? i,
    }));

  const open = (data.incidents ?? []).map((i) => incident(i, false));
  // Só manutenção acontecendo agora: as agendadas (a Cloudflare tem dezenas por semana) lotariam o ticker.
  const maint = (data.scheduled_maintenances ?? [])
    .filter(isActiveMaintenance)
    .map((m) => incident(m, true));
  const incidents = [...open, ...maint].filter((i): i is NormalizedIncident => i !== null);

  let status = INDICATOR_STATUS[data.status?.indicator ?? ""] ?? "UNKNOWN";
  if (status === "OK" && (data.scheduled_maintenances ?? []).some(isActiveMaintenance)) status = "MAINTENANCE";

  const raw = data.status?.description ?? "";
  return { status, description: DESCRIPTION_PT[raw.toLowerCase()] ?? raw, components, incidents };
}

/** Versão da página: muda quando o provedor altera qualquer coisa (evita reprocessar o mesmo summary). */
export function statuspageVersion(data: SpSummary): string | null {
  return data.page?.updated_at ?? null;
}
