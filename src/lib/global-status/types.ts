/** Tipos normalizados do painel "Status global": cada fonte oficial é traduzida para estes. */

export type ServiceStatus = "OK" | "DEGRADED" | "DOWN" | "MAINTENANCE" | "UNKNOWN";
export type IncidentImpact = "MINOR" | "MAJOR" | "CRITICAL" | "MAINTENANCE";
/** INTERNET = a conexão do próprio servidor (faixa "Sua Internet"); REGIONAL = visão de fora (IODA e rotas BGP, faixa "Internet no Brasil"). */
export type ServiceCategory = "CLOUD" | "CDN" | "DEV" | "AI" | "SOCIAL" | "STREAMING" | "INTERNET" | "REGIONAL";
/** IODA = alertas de queda de Internet por país ou ASN (Georgia Tech); RIPESTAT = visibilidade BGP dos prefixos dos serviços (RIPE RIS). */
export type SourceType = "STATUSPAGE" | "GCP" | "AZURE_RSS" | "AWS" | "NETFLIX" | "IODA" | "RIPESTAT" | "NONE";

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
 * Incidente externo sem impacto aqui: o provedor declara um problema (degradação, queda ou manutenção,
 * em geral numa região ou num produto que este servidor não usa), mas as medições daqui estão normais.
 * O card fica "Operando" e mostra o incidente à parte, sem contar como degradação da navegação.
 */
export function isExternalOnly(official: ServiceStatus | null | undefined, measured: ServiceStatus | null | undefined): boolean {
  return measured === "OK" && !!official && official !== "OK" && official !== "UNKNOWN";
}

/**
 * Status do card. Com medição daqui, ela decide: o card só piora quando a navegação deste servidor
 * piora, e um incidente oficial com a medição normal vira "incidente externo sem impacto"
 * (`isExternalOnly`). Sem medição (desligada, pausada pela conexão local ou "Sem dados"), vale o
 * oficial. Medição pior que o oficial sempre aparece (problema que o provedor ainda não declarou).
 */
export function combineStatus(official: ServiceStatus | null | undefined, measured: ServiceStatus | null | undefined): ServiceStatus {
  if (isExternalOnly(official, measured)) return "OK";
  const known = [official, measured].filter((s): s is ServiceStatus => !!s && s !== "UNKNOWN");
  return known.length ? worstStatus(known) : "UNKNOWN";
}

// ---------------------------------------------------------------- medições próprias (fase 2)

/**
 * DNS_MULTI (fase 6) = DNS composto: o nome do serviço consultado ao mesmo tempo no DNS do sistema, no
 * 8.8.8.8 e no 1.1.1.1, com latência, TTL e código de resposta de cada um. Só o servidor mede: o agente
 * Windows pede os tipos pela lista fixa HTTP/TCP/ICMP/DNS e não recebe este.
 */
export type ProbeKind = "HTTP" | "TCP" | "ICMP" | "DNS" | "TLS" | "DNS_MULTI";
/** Estado de um alvo de medição (não existe "manutenção" medida). */
export type TargetStatus = Exclude<ServiceStatus, "MAINTENANCE">;
/** Etapa em que uma medição falhou; "dns" costuma indicar problema de resolução de nomes no próprio servidor. */
export type ProbePhase = "dns" | "connect" | "tls" | "http";

/** Host especial: o gateway padrão deste servidor, descoberto na hora da medição. */
export const AUTO_GATEWAY = "auto:gateway";
/** Servidor DNS especial: os resolvedores configurados no sistema operacional. */
export const AUTO_SYSTEM_DNS = "auto:system";
/** Servidor DNS especial do DNS composto: sistema + resolvedores públicos de MULTI_DNS_RESOLVERS. */
export const AUTO_MULTI_DNS = "auto:multi";
/** Resolvedores públicos do DNS composto, além do DNS do sistema. */
export const MULTI_DNS_RESOLVERS = ["8.8.8.8", "1.1.1.1"] as const;
/** Nome do resolvedor "DNS do sistema" nas respostas do DNS composto. */
export const SYSTEM_RESOLVER = "system";

/**
 * Código da resposta DNS: NOERROR = respondeu com endereço; NODATA = o nome existe sem registro A;
 * NXDOMAIN = o nome não existe; SERVFAIL = o servidor falhou; REFUSED = recusou; TIMEOUT = não
 * respondeu no prazo; ERROR = outra falha.
 */
export type DnsRcode = "NOERROR" | "NODATA" | "NXDOMAIN" | "SERVFAIL" | "REFUSED" | "TIMEOUT" | "ERROR";

/** Resposta de um resolvedor numa medição do DNS composto (gravada em JSON em ProbeCheck.dnsAnswers). */
export interface DnsAnswer {
  /** "system", "8.8.8.8" ou "1.1.1.1". */
  resolver: string;
  ok: boolean;
  ms: number | null;
  rcode: DnsRcode;
  /** Menor TTL entre os registros A devolvidos (segundos); null sem resposta. */
  ttlSec: number | null;
  /** Até 4 endereços devolvidos. */
  addresses: string[];
}

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
    case "DNS_MULTI":
      return "DNS composto";
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
    case "DNS_MULTI":
      return `${target.url ?? DEFAULT_DNS_NAME} no DNS do sistema, ${MULTI_DNS_RESOLVERS.join(" e ")}`;
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
  /** DNS: código da resposta (no DNS composto, o do DNS do sistema). */
  rcode?: DnsRcode | null;
  /** DNS: menor TTL devolvido, em segundos. */
  ttlSec?: number | null;
  /** DNS composto: a resposta de cada resolvedor. */
  dnsAnswers?: DnsAnswer[] | null;
  /** HTTP: borda do CDN que atendeu ("Cloudflare GRU"), pelos cabeçalhos (fase 8). */
  edge?: string | null;
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
