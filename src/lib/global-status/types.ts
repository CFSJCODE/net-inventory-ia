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

/**
 * Status do card: o pior entre o declarado pelo provedor e o medido daqui. "Sem dados" de um lado não
 * esconde o que o outro lado sabe (fonte oficial fora do ar + medição ok = OK).
 */
export function combineStatus(official: ServiceStatus | null | undefined, measured: ServiceStatus | null | undefined): ServiceStatus {
  const known = [official, measured].filter((s): s is ServiceStatus => !!s && s !== "UNKNOWN");
  return known.length ? worstStatus(known) : "UNKNOWN";
}

// ---------------------------------------------------------------- medições próprias (fase 2)

export type ProbeKind = "HTTP" | "TCP" | "ICMP" | "DNS" | "TLS";
/** Estado de um alvo de medição (não existe "manutenção" medida). */
export type TargetStatus = Exclude<ServiceStatus, "MAINTENANCE">;
/** Etapa em que uma medição falhou; "dns" costuma indicar problema de resolução de nomes no próprio servidor. */
export type ProbePhase = "dns" | "connect" | "tls" | "http";

/** Host especial: o gateway padrão deste servidor, descoberto na hora da medição. */
export const AUTO_GATEWAY = "auto:gateway";
/** Servidor DNS especial: os resolvedores configurados no sistema operacional. */
export const AUTO_SYSTEM_DNS = "auto:system";
/** Nome consultado nas medições de DNS quando o alvo não informa outro. */
export const DEFAULT_DNS_NAME = "example.com";

/** O que a sonda precisa saber de um alvo (subconjunto de ProbeTarget). */
export interface ProbeSpec {
  kind: ProbeKind;
  /** Host ou IP; "auto:gateway" = gateway padrão. Para DNS é o servidor consultado ("auto:system" = resolvedores do sistema). */
  host: string;
  /** HTTP: URL completa. DNS: nome consultado. */
  url?: string | null;
  port?: number | null;
}

/** Rótulo curto de um alvo: "HTTP", "TCP 443", "Ping", "DNS", "Certificado TLS". */
export function targetLabel(target: Pick<ProbeSpec, "kind" | "port">): string {
  switch (target.kind) {
    case "TCP":
      return target.port ? `TCP ${target.port}` : "TCP";
    case "ICMP":
      return "Ping";
    case "TLS":
      return "Certificado TLS";
    default:
      return target.kind;
  }
}

/**
 * O que o alvo mede, por extenso: a URL, "host:porta", o IP ou "example.com em 1.1.1.1".
 * `gateway` é o IP do gateway padrão quando já foi descoberto (alvos "auto:gateway").
 */
export function targetAddress(target: ProbeSpec, gateway?: string | null): string {
  const host = target.host === AUTO_GATEWAY ? gateway ?? "gateway padrão" : target.host;
  switch (target.kind) {
    case "HTTP":
      return target.url ?? host;
    case "DNS": {
      const name = target.url ?? DEFAULT_DNS_NAME;
      return target.host === AUTO_SYSTEM_DNS ? `${name} no DNS do sistema` : `${name} em ${host}`;
    }
    case "TCP":
    case "TLS":
      return `${host}:${target.port ?? 443}`;
    default:
      return host;
  }
}

/** Resultado de uma medição (vira uma linha de ProbeCheck). Tempos em milissegundos. */
export interface ProbeResult {
  ok: boolean;
  /** Métrica principal do tipo: HTTP = até o primeiro byte, TCP = handshake, ICMP = RTT médio, DNS = resolução, TLS = handshake TLS. */
  latencyMs: number | null;
  httpStatus?: number | null;
  dnsMs?: number | null;
  connectMs?: number | null;
  tlsMs?: number | null;
  /** Espera do servidor: do envio do pedido ao primeiro byte. */
  ttfbMs?: number | null;
  totalMs?: number | null;
  lossPct?: number | null;
  jitterMs?: number | null;
  /** Dias até o certificado vencer (negativo = vencido). */
  certDays?: number | null;
  /** Validade total do certificado, em dias; calibra o aviso de vencimento (não é gravado). */
  certLifetimeDays?: number | null;
  /** Frase curta em português quando ok = false. */
  error?: string | null;
  /** Etapa da falha (não é gravado; separa falha de DNS local de falha do serviço). */
  failedAt?: ProbePhase | null;
  /** A sonda não pôde rodar neste servidor (sem binário de ping, sem gateway): não conta como falha e não é gravada. */
  unsupported?: boolean;
}

/** Conexão do próprio servidor com a Internet, para não culpar os serviços por uma queda local. */
export interface LocalConnectivity {
  /** "ok" = alcança a Internet; "offline" = sem saída; "dns" = o DNS do servidor não resolve nomes. */
  state: "ok" | "offline" | "dns";
  /** Desde quando está assim (ISO 8601); null quando ok. */
  since: string | null;
  /** Frase para a faixa "Sua Internet" (ex.: "O gateway 192.168.0.1 não responde."); null quando ok. */
  reason: string | null;
}

export function toDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
