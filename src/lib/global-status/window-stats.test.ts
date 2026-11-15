import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW_SIZE, normalizeWindowSize, rollingWindowStats, windowStats, type WindowSample } from "./window-stats";

const ok = (ms: number, lossPct: number | null = null): WindowSample => ({ ok: true, latencyMs: ms, lossPct });
const fail: WindowSample = { ok: false, latencyMs: null };
const repeat = (n: number, sample: WindowSample) => Array.from({ length: n }, () => sample);

describe("windowStats", () => {
  it("p50/p95/p99 só das últimas N medições", () => {
    const old = repeat(50, ok(500));
    const recent = Array.from({ length: 20 }, (_, i) => ok(i + 1)); // 1..20
    const s = windowStats([...old, ...recent], { size: 20 });
    expect(s.samples).toBe(20);
    expect(s.p50Ms).toBeCloseTo(10.5);
    expect(s.p95Ms).toBeCloseTo(19.05);
    expect(s.p99Ms).toBeCloseTo(19.81);
    expect(s.jitterMs).toBe(1);
  });

  it("perda: 100 por medição sem resposta e a perda do ping nas demais", () => {
    const s = windowStats([ok(10, 20), ok(10, 0), fail, ok(10, 0)], { size: 4 });
    expect(s.lossPct).toBe(30);
    expect(s.answered).toBe(3);
  });

  it("degrada quando o p95 da janela passa de 1,5× a mediana das últimas 100", () => {
    const stable = repeat(80, ok(40));
    const slow = repeat(20, ok(90));
    const s = windowStats([...stable, ...slow], { size: 20 });
    expect(s.baselineMs).toBe(40);
    expect(s.p95Ms).toBe(90);
    expect(s.ratio).toBeCloseTo(2.25);
    expect(s.degraded).toBe(true);
  });

  it("não degrada com pico isolado (o p95 de 20 medições com uma lenta fica abaixo de 1,5× a base)", () => {
    const s = windowStats([...repeat(99, ok(40)), ok(400)], { size: 20 });
    expect(s.p95Ms).toBeCloseTo(58);
    expect(s.degraded).toBe(false);
  });

  it("alvo de 1 ms (gateway): 2 ms não é degradação, por causa do Δ mínimo de 10 ms", () => {
    const s = windowStats([...repeat(80, ok(1)), ...repeat(20, ok(2.5))], { size: 20 });
    expect(s.ratio!).toBeGreaterThan(1.5);
    expect(s.degraded).toBe(false);
  });

  it("sem base suficiente (menos de 30 pontos) não dispara", () => {
    expect(windowStats([...repeat(10, ok(40)), ...repeat(10, ok(400))], { size: 10 }).degraded).toBe(false);
  });

  it("série vazia", () => {
    expect(windowStats([])).toMatchObject({ samples: 0, p50Ms: null, lossPct: null, degraded: false });
  });
});

describe("rollingWindowStats", () => {
  it("cada ponto usa só o passado: o gatilho aparece quando a lentidão entra na janela", () => {
    const series = [...repeat(100, ok(40)), ...repeat(20, ok(120))];
    const rolling = rollingWindowStats(series, { size: 20 });
    expect(rolling).toHaveLength(120);
    expect(rolling[99].degraded).toBe(false);
    // Com N = 20, o p95 passa do limite quando 2 das 20 já são lentas.
    const firstDegraded = rolling.findIndex((s) => s.degraded);
    expect(firstDegraded).toBeGreaterThan(99);
    expect(firstDegraded).toBeLessThan(103);
    expect(rolling.at(-1)!.degraded).toBe(true);
  });

  it("dá o mesmo que windowStats no último ponto", () => {
    const series = Array.from({ length: 150 }, (_, i) => (i % 7 === 0 ? fail : ok(30 + (i % 5))));
    expect(rollingWindowStats(series).at(-1)).toEqual(windowStats(series));
  });
});

describe("normalizeWindowSize", () => {
  it("aceita de 5 a 200", () => {
    expect(normalizeWindowSize(5)).toBe(5);
    expect(normalizeWindowSize("50")).toBe(50);
    expect(normalizeWindowSize(4)).toBe(DEFAULT_WINDOW_SIZE);
    expect(normalizeWindowSize(201)).toBe(DEFAULT_WINDOW_SIZE);
    expect(normalizeWindowSize(2.5)).toBe(DEFAULT_WINDOW_SIZE);
    expect(normalizeWindowSize(undefined)).toBe(DEFAULT_WINDOW_SIZE);
  });
});
