import { describe, expect, it } from "vitest";
import { compareAtlas, readAtlasResult } from "./atlas";
import { brtDay, dayBounds, summarizeDay } from "./route-daily";

describe("resumo diário da rota", () => {
  it("o dia é o de Brasília", () => {
    expect(brtDay(Date.parse("2026-11-16T02:59:00Z"))).toBe("2026-11-15");
    expect(brtDay(Date.parse("2026-11-16T03:00:00Z"))).toBe("2026-11-16");
    const { start, end } = dayBounds("2026-11-16");
    expect(new Date(start).toISOString()).toBe("2026-11-16T03:00:00.000Z");
    expect(end - start).toBe(24 * 60 * 60_000);
  });

  it("conta rotas internacionais, ignora as indefinidas e acha a saída mais comum", () => {
    const abroad = [
      { ttl: 1, ip: "200.230.1.1", asn: 4230, asName: "EMBRATEL", city: "Rio de Janeiro", country: "BR", role: "INTL_EDGE" },
      { ttl: 2, ip: "142.250.1.1", asn: 15169, asName: "GOOGLE", city: "Miami", country: "US", role: null },
    ];
    const t = (at: number, verdict: string, asPath: string | null, rtt: number | null) => ({ at, verdict, asPath, cableName: null, destCountry: null, destRttMs: rtt, hops: verdict === "INTERNATIONAL" ? abroad : [] });
    const day = summarizeDay([t(1, "INTERNATIONAL", "4230 15169", 110), t(2, "INTERNATIONAL", "4230 15169", 100), t(3, "DOMESTIC", "28573 15169", 10), t(4, "UNDETERMINED", null, null)]);
    expect(day).toMatchObject({ traces: 4, international: 2, domestic: 1, pathChanges: 1, topVerdict: "INTERNATIONAL", topAsPath: "4230 15169", avgDestRttMs: 73.3 });
    expect(day.topExit).toBe("Embratel (Rio de Janeiro) → Miami");
  });
});

describe("RIPE Atlas", () => {
  const result = (prb: number, rtt: number | null) => ({
    prb_id: prb,
    dst_addr: "142.250.1.1",
    result: [{ hop: 1, result: [{ from: "10.0.0.1", rtt: 1 }] }, { hop: 2, result: rtt === null ? [{ x: "*" }] : [{ from: "142.250.1.1", rtt }, { from: "142.250.1.1", rtt: rtt + 2 }] }],
  });

  it("lê o resultado de uma sonda: chegou, o menor RTT do último salto e os saltos", () => {
    expect(readAtlasResult(result(1, 12.34), 28573)).toEqual({ probe: 1, asn: 28573, reached: true, rttMs: 12.3, hops: 2 });
    expect(readAtlasResult(result(2, null), null)).toMatchObject({ reached: false, rttMs: null });
  });

  it("a maioria servida no Brasil e a sua rota indo para fora: a escolha é da operadora", () => {
    const routes = [readAtlasResult(result(1, 8), 28573), readAtlasResult(result(2, 12), 18881), readAtlasResult(result(3, 15), 26599), readAtlasResult(result(4, 120), 28573)];
    const c = compareAtlas("google.com", [101], routes, { rttMs: 107, verdict: "INTERNATIONAL", ispAsn: 28573 }, 0);
    expect(c).toMatchObject({ probes: 4, reached: 4, medianRttMs: 13.5, domesticShare: 0.75, sameIsp: { probes: 2, medianRttMs: 64 } });
    expect(c.summary).toContain("a escolha é da sua operadora");
  });

  it("sem sondas ou sem resposta, a frase diz isso", () => {
    expect(compareAtlas("x.com", [], [], { rttMs: null, verdict: null, ispAsn: null }, 0).summary).toContain("Nenhuma sonda");
    expect(compareAtlas("x.com", [1], [readAtlasResult(result(1, null), null)], { rttMs: null, verdict: null, ispAsn: null }, 0).summary).toContain("nenhuma chegou");
  });

  it("acima de 30 ms não conclui que as sondas saem do país", () => {
    const routes = [45, 48, 52].map((ms, i) => readAtlasResult(result(i + 1, ms), 18881));
    const c = compareAtlas("x.com", [1], routes, { rttMs: 110, verdict: "INTERNATIONAL", ispAsn: 28573 }, 0);
    expect(c.summary).toContain("não dá para dizer se elas saem do país");
    expect(c.summary).not.toContain("não tem borda");
  });
});
