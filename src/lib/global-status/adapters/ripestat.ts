import type { NormalizedComponent, OfficialSnapshot, ServiceStatus } from "../types";

/**
 * RIPEstat (RIPE NCC): dados abertos de roteamento, sem chave. Conferido em 15/11/2026:
 * - `network-info?resource=<ip>` → prefixo anunciado e ASN de origem do IP;
 * - `routing-status?resource=<prefixo>` → quantos coletores do RIPE RIS (≈244 roteadores no mundo)
 *   enxergam o prefixo: um prefixo que some das tabelas BGP deixa o serviço inalcançável para quem
 *   depende daquela rota, mesmo com o servidor de pé;
 * - `whats-my-ip` + `as-overview` → a operadora deste servidor (o ASN do IP público e o nome).
 * O parâmetro `sourceapp` identifica o painel, como o RIPE pede.
 */

export const RIPESTAT_BASE = "https://stat.ripe.net/data";
export const RIPESTAT_APP = "netinventory";

export function ripestatUrl(call: string, resource?: string): string {
  const params = new URLSearchParams({ sourceapp: RIPESTAT_APP });
  if (resource) params.set("resource", resource);
  return `${RIPESTAT_BASE}/${call}/data.json?${params}`;
}

interface Envelope<T> {
  status?: string;
  data?: T;
}

function dataOf<T>(body: Envelope<T>, call: string): T {
  if (!body || body.status !== "ok" || !body.data) throw new Error(`RIPEstat ${call}: resposta sem dados`);
  return body.data;
}

/** Prefixo e ASNs de origem de um IP; null quando o IP não está anunciado. */
export function parseNetworkInfo(body: Envelope<{ prefix?: string | null; asns?: (string | number)[] }>): { prefix: string; asns: number[] } | null {
  const data = dataOf(body, "network-info");
  const asns = (data.asns ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return data.prefix ? { prefix: data.prefix, asns } : null;
}

export interface Visibility {
  seeing: number;
  total: number;
}

/** Coletores RIS que enxergam o prefixo (IPv4 ou IPv6, o que o prefixo for). */
type RoutingStatusBody = Envelope<{
  visibility?: { v4?: { ris_peers_seeing?: number; total_ris_peers?: number }; v6?: { ris_peers_seeing?: number; total_ris_peers?: number } };
  less_specifics?: { prefix?: string; origin?: string | number }[];
}>;

export function parseRoutingStatus(body: RoutingStatusBody, prefix: string): Visibility {
  const data = dataOf(body, "routing-status");
  const family = prefix.includes(":") ? data.visibility?.v6 : data.visibility?.v4;
  return { seeing: Number(family?.ris_peers_seeing ?? 0), total: Number(family?.total_ris_peers ?? 0) };
}

/**
 * O bloco maior que cobre o prefixo, anunciado pelo mesmo ASN (o primeiro da lista do RIPEstat); null
 * sem nenhum. CDNs como a Meta anunciam o /24 de cada PoP só na região (no IX.br, para os vizinhos) e o
 * bloco grande para o mundo todo: o /24 visto por poucos coletores é o desenho normal, não queda.
 */
export function parseCoveringPrefix(body: RoutingStatusBody, asn: number | null): string | null {
  const data = dataOf(body, "routing-status");
  const covering = (data.less_specifics ?? []).find((l) => !!l.prefix && (asn === null || Number(l.origin) === asn));
  return covering?.prefix ?? null;
}

export function parseWhatsMyIp(body: Envelope<{ ip?: string }>): string {
  const ip = dataOf(body, "whats-my-ip").ip;
  if (!ip) throw new Error("RIPEstat whats-my-ip: sem IP");
  return ip;
}

export function parseAsOverview(body: Envelope<{ holder?: string | null }>): string | null {
  return dataOf(body, "as-overview").holder?.trim() || null;
}

/** Visto por ao menos 90% dos coletores = normal; abaixo de 50% = praticamente fora das tabelas. */
export const VISIBLE_OK = 0.9;
export const VISIBLE_DEGRADED = 0.5;

export function visibilityStatus(v: Visibility | null): ServiceStatus {
  if (!v || v.total <= 0) return "UNKNOWN";
  const ratio = v.seeing / v.total;
  return ratio >= VISIBLE_OK ? "OK" : ratio >= VISIBLE_DEGRADED ? "DEGRADED" : "DOWN";
}

/** A rota de um serviço, como a coleta descobriu. */
export interface ServiceRoute {
  slug: string;
  name: string;
  /** Grupo no detalhe (a categoria do serviço). */
  group: string;
  prefix: string | null;
  asn: number | null;
  visibility: Visibility | null;
  /**
   * O bloco maior do mesmo ASN que cobre o prefixo, consultado só quando o prefixo é pouco visto. Com o
   * bloco visível no mundo todo o prefixo é uma rota regional e o serviço segue alcançável.
   */
  covering?: { prefix: string; visibility: Visibility | null } | null;
  /** O que deu errado na descoberta (nome que não resolve, IP sem prefixo, RIPEstat fora). */
  error: string | null;
}

/** O estado da rota: o do prefixo, ou OK quando ele é regional e o bloco maior que o cobre é visto no mundo todo. */
export function routeStatus(route: Pick<ServiceRoute, "prefix" | "visibility" | "covering">): ServiceStatus {
  if (!route.prefix) return "UNKNOWN";
  const own = visibilityStatus(route.visibility);
  if (own === "OK" || own === "UNKNOWN") return own;
  return route.covering && visibilityStatus(route.covering.visibility) === "OK" ? "OK" : own;
}

/** Texto de uma rota: "140.82.112.0/20 · AS36459 · vista por 243 de 244 coletores". */
export function routeText(route: Pick<ServiceRoute, "prefix" | "asn" | "visibility" | "covering" | "error">): string {
  if (!route.prefix) return route.error ?? "sem prefixo anunciado";
  const parts = [route.prefix];
  if (route.asn) parts.push(`AS${route.asn}`);
  if (route.visibility && route.visibility.total > 0) parts.push(`vista por ${route.visibility.seeing} de ${route.visibility.total} coletores`);
  else parts.push(route.error ?? "sem dados de visibilidade");
  const cover = route.covering;
  if (cover && visibilityStatus(route.visibility) !== "OK") {
    parts.push(
      visibilityStatus(cover.visibility) === "OK" && cover.visibility
        ? `rota regional, coberta por ${cover.prefix} (vista por ${cover.visibility.seeing} de ${cover.visibility.total})`
        : `bloco maior ${cover.prefix} também pouco visto`,
    );
  }
  return parts.join(" · ");
}

/**
 * Snapshot do "serviço" de rotas BGP: um componente por serviço medido (o prefixo do endereço que o
 * servidor mede), no estado da visibilidade. O card fica degradado quando algum prefixo deixa de ser
 * visto pela maior parte dos coletores; nunca "fora", porque é um prefixo de cada serviço.
 */
export function bgpSnapshot(routes: readonly ServiceRoute[]): OfficialSnapshot {
  const components: NormalizedComponent[] = routes.map((r, position) => ({
    externalId: r.slug,
    name: `${r.name} · ${routeText(r)}`,
    groupName: r.group,
    status: routeStatus(r),
    position,
  }));
  const known = components.filter((c) => c.status !== "UNKNOWN");
  const visible = known.filter((c) => c.status === "OK").length;
  const status: ServiceStatus = !known.length ? "UNKNOWN" : visible === known.length ? "OK" : "DEGRADED";
  const description = known.length ? `${visible} de ${known.length} prefixos vistos no mundo todo` : "Sem dados de roteamento ainda";
  return { status, description, components, incidents: [] };
}
