import { describe, expect, it } from "vitest";
import { edgeFromHeaders, formatEdge, parseEdge } from "./edge-pop";
import { buildIxPrefixes, ixMatcher } from "./ix-prefixes";
import { cityFromHostname } from "./route-cities";
import type { EnrichedHop } from "./route-enrich";
import { inferRoute } from "./route-infer";
import { cdnName, exitPoint, interconnectionText, interconnections, shortAsName, summarizeTransit, type PeeringHop } from "./route-peering";
import { routerRole } from "./route-roles";
import { parseNeighbours } from "./upstreams";

function hop(ttl: number, ip: string | null, asn: number | null, asName: string | null, rdns: string | null = null, extra: Partial<PeeringHop> = {}): PeeringHop {
  const city = cityFromHostname(rdns);
  return { ttl, ip, asn, asName, city: city?.name ?? null, country: city?.country ?? null, role: routerRole(rdns), ...extra };
}

/** Rota até o Google como a de 2026-11-16: Claro → Embratel → peering com o Google no Rio. */
const GOOGLE: PeeringHop[] = [
  hop(1, "192.168.0.1", null, null),
  hop(2, "100.64.0.1", null, null),
  hop(3, "177.10.0.1", 28573, "CLARO S.A.", "nrjoac01-ae1.embratel.net.br"),
  hop(4, "200.230.20.5", 4230, "EMBRATEL", "peer-B54-agg03.rjo.embratel.net.br"),
  hop(5, "142.251.65.1", 15169, "GOOGLE"),
];
/** Rota internacional: a borda internacional da Embratel em Miami é o último que responde. */
const MIAMI: PeeringHop[] = [
  hop(1, "192.168.0.1", null, null),
  hop(3, "177.10.0.1", 28573, "CLARO S.A.", "nrjoac01-ae1.embratel.net.br"),
  hop(4, "200.230.40.1", 4230, "EMBRATEL", "ae1.spo.embratel.net.br"),
  hop(5, "200.230.250.17", 4230, "EMBRATEL", "ebt-B101-intl02.mianap.embratel.net.br"),
];

describe("borda do CDN pelos cabeçalhos (fase 8)", () => {
  it("lê Cloudflare, CloudFront, Fastly, Vercel, Akamai e Google", () => {
    expect(edgeFromHeaders({ "cf-ray": "8e2b1c3d4e5f6a7b-GRU" })).toEqual({ provider: "Cloudflare", pop: "GRU" });
    expect(edgeFromHeaders({ "x-amz-cf-pop": "GIG51-P2" })).toEqual({ provider: "CloudFront", pop: "GIG" });
    expect(edgeFromHeaders({ "x-served-by": "cache-iad-kjyo7100044-IAD, cache-gru-sbgr1930064-GRU" })).toEqual({ provider: "Fastly", pop: "GRU" });
    expect(edgeFromHeaders({ "x-vercel-id": "gru1::iad1::abcde-123" })).toEqual({ provider: "Vercel", pop: "GRU" });
    expect(edgeFromHeaders({ server: "AkamaiGHost" })).toEqual({ provider: "Akamai", pop: null });
    expect(edgeFromHeaders({ server: "gws" })).toEqual({ provider: "Google", pop: null });
    expect(edgeFromHeaders({ server: "nginx" })).toBeNull();
  });

  it("grava e lê de volta com a cidade", () => {
    expect(formatEdge({ provider: "Cloudflare", pop: "GRU" })).toBe("Cloudflare GRU");
    expect(parseEdge("Cloudflare GRU")).toEqual({ provider: "Cloudflare", pop: "GRU", city: "São Paulo", country: "BR" });
    expect(parseEdge("Akamai")).toEqual({ provider: "Akamai", pop: null, city: null, country: null });
    expect(parseEdge(null)).toBeNull();
  });
});

describe("veredito CDN_EDGE", () => {
  it("destino perto e num ASN de CDN é a borda do CDN, não um servidor no Brasil", () => {
    const hops = GOOGLE.map((h) => ({ ...h, rttMs: 10, altIps: [], registryCountry: "BR", rdns: null, city: null, role: null }) as unknown as EnrichedHop);
    const r = inferRoute({ hops, destRttMs: 11, destAsn: 15169, destAsName: "GOOGLE", destRegistryCountry: "US", isp: { asn: 28573, name: "Claro" }, cables: [] });
    expect(r.verdict).toBe("CDN_EDGE");
    expect(r.summary).toMatch(/borda da Google no Brasil/);
    const own = inferRoute({ hops, destRttMs: 11, destAsn: 64500, destAsName: "X", destRegistryCountry: "BR", isp: null, cables: [] });
    expect(own.verdict).toBe("DOMESTIC");
    expect(cdnName(13335)).toBe("Cloudflare");
  });
});

describe("interconexões", () => {
  it("acha o peering Embratel ↔ Google no Rio", () => {
    const links = interconnections(GOOGLE);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ fromAsn: 28573, toAsn: 4230, kind: "HANDOFF" });
    expect(links[1]).toMatchObject({ fromAsn: 4230, toAsn: 15169, kind: "PEERING", city: "Rio de Janeiro" });
    expect(interconnectionText(links[1])).toBe("Embratel → Google em Rio de Janeiro (peering direto)");
  });

  it("um salto no bloco do IX marca a troca como IX", () => {
    const viaIx = [GOOGLE[2], hop(4, "187.16.216.10", null, null, null, { role: "IX", city: "São Paulo" }), GOOGLE[4]];
    expect(interconnections(viaIx)).toEqual([expect.objectContaining({ fromAsn: 28573, toAsn: 15169, kind: "IX", city: "São Paulo" })]);
  });

  it("a troca só no destino aparece sem TTL", () => {
    expect(interconnections(MIAMI, { asn: 3, asName: "MIT" }).at(-1)).toMatchObject({ ttl: null, fromAsn: 4230, toAsn: 3 });
  });
});

describe("saída internacional e trânsito", () => {
  it("a borda internacional da Embratel é a saída, para Miami", () => {
    expect(exitPoint(MIAMI)).toEqual({ operator: "Embratel", city: null, abroad: "Miami" });
  });

  it("resume as rotas: saídas, IX e concentração", () => {
    const s = summarizeTransit([
      { service: "Google", verdict: "CDN_EDGE", hops: GOOGLE },
      { service: "MIT", verdict: "INTERNATIONAL", hops: MIAMI },
      { service: "GitHub", verdict: "INTERNATIONAL", hops: MIAMI },
      { service: "Brasil", verdict: "DOMESTIC", hops: GOOGLE.slice(0, 3) },
    ]);
    expect(s).toMatchObject({ total: 4, cdnEdge: 1, domestic: 1, international: 2, topExitShare: 1, viaIx: [] });
    expect(s.exits).toEqual([{ label: "Embratel → Miami", count: 2, services: ["MIT", "GitHub"] }]);
    expect(s.peerings[0]).toEqual({ label: "Claro → Embratel em Rio de Janeiro (troca de rede)", count: 3 });
  });

  it("nome curto do dono", () => {
    expect(shortAsName("CLARO S.A.")).toBe("Claro");
    expect(shortAsName("EMBRATEL-EMPRESA BRASILEIRA DE TELECOMUNICACOES SA")).toBe("Embratel");
    expect(shortAsName(null, 4230)).toBe("AS4230");
  });
});

describe("blocos do IX.br (PeeringDB)", () => {
  it("junta ix, ixlan e ixpfx e reconhece o IP", () => {
    const entries = buildIxPrefixes(
      [{ id: 171, name: "IX.br (PTT.br) São Paulo" }],
      [{ id: 171, ix_id: 171 }],
      [
        { prefix: "187.16.216.0/21", ixlan_id: 171 },
        { prefix: "2001:12f8::/64", ixlan_id: 171 },
        { prefix: "lixo", ixlan_id: 171 },
        { prefix: "10.0.0.0/8", ixlan_id: 999 },
      ],
    );
    expect(entries).toHaveLength(2);
    const m = ixMatcher(entries);
    expect(m.match("187.16.217.1")).toBe("IX.br (PTT.br) São Paulo");
    expect(m.match("8.8.8.8")).toBeNull();
    expect(m.match(null)).toBeNull();
  });
});

describe("upstreams pelo BGP", () => {
  it("fica com os vizinhos à esquerda, do mais visto ao menos", () => {
    expect(
      parseNeighbours({
        neighbours: [
          { asn: 4230, type: "left", power: 120 },
          { asn: 64512, type: "right", power: 300 },
          { asn: 3356, type: "left", power: 40 },
          { asn: 1, type: "uncertain" },
        ],
      }),
    ).toEqual([
      { asn: 4230, power: 120 },
      { asn: 3356, power: 40 },
    ]);
  });
});
