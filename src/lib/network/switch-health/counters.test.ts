import { describe, expect, it } from "vitest";
import { computeRates, correlate, counterDelta, pearson, portHealth, totalsOf, type RawPortCounters, type RawSnapshot } from "./counters";
import { bucketSeries, portWindows } from "./series";

const counters = (over: Partial<RawPortCounters> = {}): RawPortCounters => ({
  inErrors: "0", outErrors: "0", inDiscards: "0", outDiscards: "0", crcErrors: "0", inOctets: "0", outOctets: "0", ...over,
});

const snap = (at: number, uptimeTicks: number | null, c: Partial<RawPortCounters>, speedMbps: number | null = 1000): RawSnapshot => ({
  at, uptimeTicks, ports: [{ ifIndex: 2, name: "GE1/0/2", operUp: true, speedMbps, counters: counters(c) }],
});

describe("counterDelta", () => {
  it("subtrai leituras crescentes, inclusive acima de 2^53", () => {
    expect(counterDelta("10", "25", 32)).toBe(BigInt(15));
    expect(counterDelta("18446744073709551000", "18446744073709551600", 64)).toBe(BigInt(600));
  });
  it("trata a volta do Counter32", () => {
    expect(counterDelta("4294967290", "4", 32)).toBe(BigInt(10));
  });
  it("trata zeragem como desconhecido", () => {
    expect(counterDelta("1000000", "5", 32)).toBeNull(); // "volta" de quase 2^32 = reset counters
    expect(counterDelta("500", "10", 64)).toBeNull();
  });
  it("ignora valores ausentes ou não numéricos", () => {
    expect(counterDelta(null, "1", 32)).toBeNull();
    expect(counterDelta("1", "noSuchInstance", 32)).toBeNull();
  });
});

describe("computeRates", () => {
  it("primeira rodada só serve de base", () => {
    const [r] = computeRates(null, snap(60_000, 100, {}));
    expect(r.errorsPerMin).toBeNull();
    expect(r.inBps).toBeNull();
  });

  it("calcula erros, CRC e descartes por minuto, bps e utilização", () => {
    const a = snap(0, 1000, { inErrors: "100", outErrors: "0", crcErrors: "40", inDiscards: "5", inOctets: "0", outOctets: "0" });
    const b = snap(120_000, 13_000, { inErrors: "120", outErrors: "4", crcErrors: "50", inDiscards: "25", inOctets: String(1_500_000_000), outOctets: String(150_000_000) });
    const [r] = computeRates(a, b);
    expect(r.inErrors).toBe(20);
    expect(r.outErrors).toBe(4);
    expect(r.errorsPerMin).toBe(12); // 24 em 2 min
    expect(r.crcPerMin).toBe(5);
    expect(r.discardsPerMin).toBe(10);
    expect(r.inBps).toBe(100_000_000); // 1,5 GB * 8 / 120 s
    expect(r.utilPct).toBe(10);
  });

  it("descarta o intervalo quando a switch reiniciou", () => {
    const [r] = computeRates(snap(0, 900_000, { inErrors: "10" }), snap(60_000, 500, { inErrors: "12" }));
    expect(r.errorsPerMin).toBeNull();
  });

  it("aponta a pior porta no total", () => {
    const prev: RawSnapshot = { at: 0, uptimeTicks: 1, ports: [
      { ifIndex: 1, name: "GE1/0/1", operUp: true, speedMbps: 1000, counters: counters() },
      { ifIndex: 2, name: "GE1/0/2", operUp: true, speedMbps: 1000, counters: counters() },
    ] };
    const cur: RawSnapshot = { at: 60_000, uptimeTicks: 6001, ports: [
      { ifIndex: 1, name: "GE1/0/1", operUp: true, speedMbps: 1000, counters: counters({ inErrors: "3" }) },
      { ifIndex: 2, name: "GE1/0/2", operUp: true, speedMbps: 1000, counters: counters({ inErrors: "30" }) },
    ] };
    const totals = totalsOf(computeRates(prev, cur));
    expect(totals.errorsPerMin).toBe(33);
    expect(totals.worstPort).toBe("GE1/0/2");
    expect(totals.worstPortErrorsPerMin).toBe(30);
  });
});

describe("portHealth", () => {
  const t = { errorsPerMin: 10, discardsPerMin: 100 };
  it("classifica pelos limites", () => {
    expect(portHealth({ errorsPerMin: null, crcPerMin: null, discardsPerMin: null }, t)).toBe("unknown");
    expect(portHealth({ errorsPerMin: 0, crcPerMin: 0, discardsPerMin: 0 }, t)).toBe("ok");
    expect(portHealth({ errorsPerMin: 1, crcPerMin: 1, discardsPerMin: 0 }, t)).toBe("warning");
    expect(portHealth({ errorsPerMin: 0, crcPerMin: 0, discardsPerMin: 150 }, t)).toBe("warning");
    expect(portHealth({ errorsPerMin: 12, crcPerMin: 12, discardsPerMin: 0 }, t)).toBe("critical");
  });
});

describe("correlação", () => {
  it("pearson de séries proporcionais é 1 e de série constante é null", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(pearson(xs, xs.map((x) => 2 * x + 1))).toBe(1);
    expect(pearson(xs, xs.map(() => 3))).toBeNull();
    expect(pearson([1, 2], [1, 2])).toBeNull();
  });

  it("erros acompanhando a latência dão correlação forte", () => {
    const points = Array.from({ length: 20 }, (_, i) => ({ errorsPerMin: i % 4 === 0 ? 50 : 0, latencyMs: i % 4 === 0 ? 40 : 2 }));
    const c = correlate(points);
    expect(c.verdict).toBe("strong");
    expect(c.latencyWithErrorsMs).toBe(40);
    expect(c.latencyWithoutErrorsMs).toBe(2);
    expect(c.minutesWithErrors).toBe(5);
  });

  it("erros subindo com a latência caindo é relação inversa, não forte", () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ errorsPerMin: i, latencyMs: 10 - i }));
    expect(correlate(points)).toMatchObject({ r: -1, verdict: "inverse" });
  });

  it("sem erro nenhum não há relação; poucos pontos é insuficiente", () => {
    expect(correlate(Array.from({ length: 15 }, (_, i) => ({ errorsPerMin: 0, latencyMs: i }))).verdict).toBe("none");
    expect(correlate([{ errorsPerMin: 1, latencyMs: 1 }]).verdict).toBe("insufficient");
  });
});

describe("série e portas", () => {
  it("agrupa em passos com a média das taxas", () => {
    const base = { intervalSec: 60, crcPerMin: 0, discardsPerMin: 0, inBps: 0, outBps: 0, gatewayLatencyMs: null };
    const rows = [
      { ...base, at: new Date(0), errorsPerMin: 60, latencyMs: 10 },
      { ...base, at: new Date(60_000), errorsPerMin: 0, latencyMs: 2 },
    ];
    const { stepMs, points } = bucketSeries(rows, 0, 240 * 60_000 * 2, 240);
    expect(stepMs).toBe(120_000);
    expect(points).toHaveLength(1);
    expect(points[0].errorsPerMin).toBe(30);
    expect(points[0].latencyMs).toBe(6);
  });

  it("pondera as taxas pela duração de cada rodada", () => {
    const base = { crcPerMin: null, discardsPerMin: null, inBps: null, outBps: null, gatewayLatencyMs: null, latencyMs: null };
    const rows = [
      { ...base, at: new Date(0), intervalSec: 60, errorsPerMin: 60 },
      { ...base, at: new Date(60_000), intervalSec: 900, errorsPerMin: 0 },
    ];
    const { points } = bucketSeries(rows, 0, 3_600_000 * 4, 1);
    expect(points[0].errorsPerMin).toBe(3.75); // 60 erros em 16 min
  });

  it("soma por porta e ordena as piores primeiro", () => {
    const row = { inDiscards: 0, outDiscards: 0, crcErrors: 0, utilPct: 5 };
    const w = portWindows([
      { ...row, ifIndex: 1, name: "GE1/0/1", inErrors: 0, outErrors: 0, errorsPerMin: 0 },
      { ...row, ifIndex: 2, name: "GE1/0/2", inErrors: 7, outErrors: 1, errorsPerMin: 8 },
      { ...row, ifIndex: 2, name: "GE1/0/2", inErrors: 2, outErrors: 0, errorsPerMin: 2, utilPct: 15 },
    ]);
    expect(w[0]).toMatchObject({ name: "GE1/0/2", inErrors: 9, outErrors: 1, peakErrorsPerMin: 8, samplesWithErrors: 2, avgUtilPct: 10 });
    expect(w[1].name).toBe("GE1/0/1");
  });
});
