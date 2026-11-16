import { prisma } from "@/lib/prisma";
import { readIxPrefixes } from "./ix-prefixes";
import { parseEdge } from "./edge-pop";
import { storedIsp } from "./internet-signals";
import { exitLabel, exitPoint, shortAsName, summarizeTransit, type TransitSummary } from "./route-peering";
import { readUpstreams, type Upstream } from "./upstreams";

/**
 * Visão de rotas e trânsito da página de status (fases 8 e 9): a rota mais nova de cada serviço (até 7
 * dias), onde cada um é servido, por onde sai do país, os pontos de peering, o IX.br, os upstreams da
 * operadora e a borda do CDN que atendeu as sondas HTTP.
 */
export interface RouteOverview {
  summary: TransitSummary;
  /** Serviços agrupados pelo lugar que os atende: o PoP do CDN, a saída internacional ou "no Brasil". */
  places: { label: string; kind: "EDGE" | "EXIT" | "DOMESTIC" | "OPERATOR"; services: { slug: string; name: string }[] }[];
  isp: { asn: number; name: string | null } | null;
  upstreams: Upstream[];
  /** Blocos de IX conhecidos (PeeringDB): 0 = a lista ainda não chegou e o IX.br não pode ser medido. */
  ixPrefixCount: number;
  ixError: string | null;
  /** Saída internacional concentrada: mais de 80% das rotas internacionais por um só lugar (com 3 ou mais). */
  singleExit: { label: string; share: number; count: number } | null;
}

const WEEK_MS = 7 * 24 * 60 * 60_000;
export const SINGLE_EXIT_SHARE = 0.8;
const EDGE_FRESH_MS = 60 * 60_000;

export async function loadRouteOverview(nowMs = Date.now()): Promise<RouteOverview> {
  const services = await prisma.statusService.findMany({ where: { enabled: true, category: { notIn: ["INTERNET", "REGIONAL"] } }, orderBy: { position: "asc" }, select: { id: true, slug: true, name: true } });
  const traces = await prisma.routeTrace.findMany({
    where: { at: { gte: new Date(nowMs - WEEK_MS) }, error: null, vantage: "server" },
    orderBy: { at: "desc" },
    include: { hops: { orderBy: { ttl: "asc" } } },
  });
  const latest = new Map<string, (typeof traces)[number]>();
  for (const t of traces) if (!latest.has(t.serviceId)) latest.set(t.serviceId, t);

  // A borda mais recente das sondas HTTP do servidor, por serviço (na última hora).
  const edges = await prisma.probeCheck.findMany({
    where: { vantage: "server", edge: { not: null }, at: { gte: new Date(nowMs - EDGE_FRESH_MS) }, target: { kind: "HTTP" } },
    orderBy: { at: "desc" },
    select: { edge: true, target: { select: { serviceId: true } } },
  });
  const edgeBy = new Map<string, string>();
  for (const e of edges) if (e.edge && !edgeBy.has(e.target.serviceId)) edgeBy.set(e.target.serviceId, e.edge);

  const routes = services.flatMap((s) => {
    const t = latest.get(s.id);
    return t ? [{ service: s.name, slug: s.slug, verdict: t.verdict, hops: t.hops, destAsn: null, destAsName: null }] : [];
  });
  const summary = summarizeTransit(routes);

  const places = new Map<string, RouteOverview["places"][number]>();
  const add = (label: string, kind: RouteOverview["places"][number]["kind"], s: { slug: string; name: string }) => {
    const p = places.get(label) ?? { label, kind, services: [] };
    p.services.push(s);
    places.set(label, p);
  };
  for (const s of services) {
    const edge = parseEdge(edgeBy.get(s.id));
    const t = latest.get(s.id);
    if (edge?.pop) add(`${edge.provider} em ${edge.city ?? edge.pop}`, "EDGE", s);
    else if (t?.verdict === "INTERNATIONAL") {
      const exit = exitPoint(t.hops);
      add(exit ? exitLabel(exit) : "Fora do Brasil, saída não identificada", "EXIT", s);
    } else if (t?.verdict === "OPERATOR_CACHE") add("Cache dentro da operadora", "OPERATOR", s);
    else if (t?.verdict === "DOMESTIC" || t?.verdict === "CDN_EDGE") {
      const city = [...t.hops].reverse().find((h) => h.city && h.country === "BR")?.city;
      add(edge ? `${edge.provider} no Brasil` : city ? `No Brasil, perto de ${city}` : "No Brasil", "DOMESTIC", s);
    }
  }
  const order = { EXIT: 0, EDGE: 1, OPERATOR: 2, DOMESTIC: 3 } as const;

  const [isp, upstreams, ix] = await Promise.all([storedIsp(), readUpstreams(), readIxPrefixes()]);
  const top = summary.exits[0];
  const singleExit = top && summary.international >= 3 && summary.topExitShare !== null && summary.topExitShare > SINGLE_EXIT_SHARE ? { label: top.label, share: summary.topExitShare, count: top.count } : null;
  return {
    summary,
    places: [...places.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.services.length - a.services.length),
    isp: isp ? { asn: isp.asn, name: isp.name } : null,
    upstreams: upstreams && isp && upstreams.asn === isp.asn ? upstreams.upstreams : [],
    ixPrefixCount: ix?.prefixes.length ?? 0,
    ixError: ix?.error ?? null,
    singleExit,
  };
}

export { shortAsName };
