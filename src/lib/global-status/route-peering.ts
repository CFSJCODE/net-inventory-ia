import type { RouterRole } from "./route-roles";

/**
 * CDN, peering e trânsito a partir das rotas gravadas (fase 8). Tudo puro: recebe saltos e devolve
 * fatos para a tela e para os alertas.
 */

/** ASNs de CDNs e grandes redes de conteúdo com borda no Brasil. */
export const CDN_ASNS: Record<number, string> = {
  13335: "Cloudflare",
  209242: "Cloudflare",
  15169: "Google",
  396982: "Google Cloud",
  36040: "YouTube",
  20940: "Akamai",
  16625: "Akamai",
  21342: "Akamai",
  32787: "Akamai",
  54113: "Fastly",
  16509: "Amazon CloudFront",
  14618: "Amazon",
  8075: "Microsoft",
  8068: "Microsoft",
  32934: "Meta",
  2906: "Netflix",
  40027: "Netflix",
  22822: "Edgio",
  60068: "CDN77",
  714: "Apple",
  6185: "Apple",
  13414: "X (Twitter)",
  396986: "Bytedance",
};

export function cdnName(asn: number | null | undefined): string | null {
  return asn ? (CDN_ASNS[asn] ?? null) : null;
}

export interface PeeringHop {
  ttl: number;
  ip: string | null;
  asn: number | null;
  asName: string | null;
  city: string | null;
  country: string | null;
  role: RouterRole | string | null;
}

/** Onde a rota passa de uma rede (ASN) para outra. */
export interface Interconnection {
  /** TTL do primeiro salto da rede nova; null quando a troca é só no destino (os saltos depois sumiram). */
  ttl: number | null;
  fromAsn: number;
  fromName: string | null;
  toAsn: number;
  toName: string | null;
  /** Cidade do salto de um dos lados, a mais próxima da troca. */
  city: string | null;
  /** IX = dentro do bloco de um ponto de troca; PEERING = nome de peering; HANDOFF = troca sem nome (trânsito ou peering privado). */
  kind: "IX" | "PEERING" | "HANDOFF";
}

/** Nome curto do dono do ASN: "CLARO S.A." → "Claro", "EMBRATEL" → "Embratel". */
export function shortAsName(name: string | null | undefined, asn?: number | null): string {
  if (!name) return asn ? `AS${asn}` : "?";
  const clean = name.replace(/\b(S\.?A\.?|LTDA\.?|INC\.?|LLC|LTD\.?|CORP(ORATION)?|TELECOMUNICACOES|TELECOMUNICAÇÕES|COMUNICACAO|NETWORK(S)?|-ASN?\d*)\b/gi, "").replace(/[-,]+$/g, "").trim();
  const word = (clean.split(/[\s,-]+/).find(Boolean) ?? name).toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function interconnections(hops: readonly PeeringHop[], dest: { asn: number | null; asName: string | null } = { asn: null, asName: null }): Interconnection[] {
  const out: Interconnection[] = [];
  let prev: PeeringHop | null = null;
  // Um salto dentro do bloco de um IX é transparente (a LAN do IX não é uma rede da rota): marca a troca seguinte.
  type IxMark = { city: string | null };
  let ix = null as IxMark | null;
  for (const hop of hops) {
    if (!hop.ip) continue;
    if (hop.role === "IX") {
      const before: IxMark | null = ix;
      ix = { city: hop.city ?? before?.city ?? null };
      continue;
    }
    if (!hop.asn) continue;
    if (prev && prev.asn !== hop.asn) {
      // O roteador de peering é o da rede que entrega (o nome "peer-" fica no último salto antes da troca).
      const kind = ix ? "IX" : prev.role === "PEERING" ? "PEERING" : "HANDOFF";
      out.push({ ttl: hop.ttl, fromAsn: prev.asn!, fromName: prev.asName, toAsn: hop.asn, toName: hop.asName, city: ix?.city ?? prev.city ?? hop.city ?? null, kind });
      ix = null;
    }
    prev = hop;
  }
  const last = prev as PeeringHop | null;
  const pendingIx = ix as { city: string | null } | null;
  if (last && dest.asn && dest.asn !== last.asn) {
    out.push({ ttl: null, fromAsn: last.asn!, fromName: last.asName, toAsn: dest.asn, toName: dest.asName, city: pendingIx?.city ?? last.city, kind: pendingIx ? "IX" : last.role === "PEERING" ? "PEERING" : "HANDOFF" });
  }
  return out;
}

export function interconnectionText(c: Interconnection): string {
  const kind = c.kind === "IX" ? "no IX" : c.kind === "PEERING" ? "peering direto" : "troca de rede";
  return `${shortAsName(c.fromName, c.fromAsn)} → ${shortAsName(c.toName, c.toAsn)}${c.city ? ` em ${c.city}` : ""} (${kind})`;
}

/** Onde uma rota internacional sai do Brasil: a borda internacional pelo nome, ou o último salto no Brasil antes do primeiro de fora. */
export function exitPoint(hops: readonly PeeringHop[]): { operator: string; city: string | null; abroad: string | null } | null {
  const answered = hops.filter((h) => h.ip);
  const firstForeign = answered.findIndex((h) => h.country && h.country !== "BR");
  const intl = answered.find((h) => h.role === "INTL_EDGE");
  const exit = intl ?? (firstForeign > 0 ? answered[firstForeign - 1] : null) ?? (firstForeign === 0 ? answered[0] : null);
  if (!exit) return null;
  const abroad = intl && intl.country && intl.country !== "BR" ? intl.city : firstForeign >= 0 ? answered[firstForeign].city : null;
  const operator = shortAsName(exit.asName ?? answered.filter((h) => h.asn).pop()?.asName ?? null, exit.asn);
  return { operator, city: exit.country === "BR" ? exit.city : null, abroad };
}

export interface RouteForSummary {
  service: string;
  verdict: string;
  hops: readonly PeeringHop[];
  destAsn?: number | null;
  destAsName?: string | null;
}

export interface TransitSummary {
  /** Serviços com rota gravada. */
  total: number;
  domestic: number;
  cdnEdge: number;
  operatorCache: number;
  international: number;
  /** Saídas internacionais agrupadas ("Embratel → Miami"), da mais usada para a menos. */
  exits: { label: string; count: number; services: string[] }[];
  /** Pontos de interconexão vistos, agrupados. */
  peerings: { label: string; count: number }[];
  /** Serviços cuja rota passa por um IX (IX.br). */
  viaIx: string[];
  /** Fração das rotas internacionais pela saída mais usada (0–1); null sem rota internacional. */
  topExitShare: number | null;
}

export function exitLabel(exit: NonNullable<ReturnType<typeof exitPoint>>): string {
  return `${exit.operator}${exit.city ? ` (${exit.city})` : ""} → ${exit.abroad ?? "exterior"}`;
}

export function summarizeTransit(routes: readonly RouteForSummary[]): TransitSummary {
  const exits = new Map<string, string[]>();
  const peerings = new Map<string, number>();
  const viaIx: string[] = [];
  let domestic = 0;
  let cdnEdge = 0;
  let operatorCache = 0;
  let international = 0;
  for (const r of routes) {
    if (r.verdict === "DOMESTIC") domestic++;
    else if (r.verdict === "CDN_EDGE") cdnEdge++;
    else if (r.verdict === "OPERATOR_CACHE") operatorCache++;
    else if (r.verdict === "INTERNATIONAL") {
      international++;
      const exit = exitPoint(r.hops);
      const label = exit ? exitLabel(exit) : "saída não identificada";
      exits.set(label, [...(exits.get(label) ?? []), r.service]);
    }
    const links = interconnections(r.hops, { asn: r.destAsn ?? null, asName: r.destAsName ?? null });
    if (links.some((l) => l.kind === "IX") || r.hops.some((h) => h.role === "IX")) viaIx.push(r.service);
    for (const l of links) {
      if (l.kind === "HANDOFF" && l.ttl === null) continue;
      const label = interconnectionText(l);
      peerings.set(label, (peerings.get(label) ?? 0) + 1);
    }
  }
  const exitList = [...exits.entries()].map(([label, services]) => ({ label, count: services.length, services })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return {
    total: routes.length,
    domestic,
    cdnEdge,
    operatorCache,
    international,
    exits: exitList,
    peerings: [...peerings.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    viaIx,
    topExitShare: international ? exitList[0].count / international : null,
  };
}
