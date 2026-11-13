/** Tipos normalizados do painel "Status global": cada fonte oficial é traduzida para estes. */

export type ServiceStatus = "OK" | "DEGRADED" | "DOWN" | "MAINTENANCE" | "UNKNOWN";
export type IncidentImpact = "MINOR" | "MAJOR" | "CRITICAL" | "MAINTENANCE";
export type ServiceCategory = "CLOUD" | "CDN" | "DEV" | "AI" | "SOCIAL" | "STREAMING" | "INTERNET";
export type SourceType = "STATUSPAGE" | "GCP" | "AZURE_RSS" | "NONE";

export interface NormalizedComponent {
  externalId: string;
  name: string;
  groupName: string | null;
  status: ServiceStatus;
  position: number;
}

export interface NormalizedIncident {
  externalId: string;
  title: string;
  impact: IncidentImpact;
  state: string;
  url: string | null;
  affected: string | null;
  startedAt: Date;
  resolvedAt: Date | null;
}

/** Resultado de uma consulta à fonte oficial de um serviço. */
export interface OfficialSnapshot {
  status: ServiceStatus;
  /** Frase do provedor, exibida no card. */
  description: string;
  /** null = a fonte não traz componentes (mantém os já gravados). */
  components: NormalizedComponent[] | null;
  /** Incidentes e manutenções que a fonte devolveu (abertos e, quando houver, recentes resolvidos). */
  incidents: NormalizedIncident[];
}

/** Gravidade para ordenar e consolidar: o pior estado vence. */
export const STATUS_SEVERITY: Record<ServiceStatus, number> = {
  OK: 0,
  UNKNOWN: 1,
  MAINTENANCE: 2,
  DEGRADED: 3,
  DOWN: 4,
};

export function worstStatus(statuses: ServiceStatus[]): ServiceStatus {
  return statuses.reduce<ServiceStatus>((worst, s) => (STATUS_SEVERITY[s] > STATUS_SEVERITY[worst] ? s : worst), "OK");
}

export function toDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
