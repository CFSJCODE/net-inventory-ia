import { describe, expect, it } from "vitest";
import { AGENT_ROLLUP_WINDOWS, SERVER_VANTAGE, agentIdOf, agentRollupWindows, buildRollups, closedWindows } from "./probe-logic";
import { buildPhaseSeries, uptimeFromTotals } from "./series";
import { BUCKET_MS } from "./stats";

const AGENT = "agent:3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

describe("buildRollups com pontos de medição", () => {
  it("separa as janelas do servidor e do agente no mesmo alvo", () => {
    const checks = [
      { targetId: "t1", at: new Date(T0 + 10_000), ok: true, latencyMs: 10, lossPct: null },
      { targetId: "t1", vantage: AGENT, at: new Date(T0 + 20_000), ok: true, latencyMs: 30, lossPct: null },
      { targetId: "t1", vantage: AGENT, at: new Date(T0 + 80_000), ok: false, latencyMs: null, lossPct: null },
    ];
    const rows = buildRollups(checks, [T0]);
    const server = rows.find((r) => r.vantage === SERVER_VANTAGE);
    const agent = rows.find((r) => r.vantage === AGENT);
    expect(rows).toHaveLength(2);
    expect(server).toMatchObject({ targetId: "t1", samples: 1, failures: 0, p50Ms: 10 });
    expect(agent).toMatchObject({ targetId: "t1", samples: 2, failures: 1, p50Ms: 30 });
  });
});

describe("agentRollupWindows", () => {
  it("são as últimas janelas fechadas, com a mesma folga do resumo do servidor", () => {
    for (const now of [T0 + 30_000, T0 + 2 * 60_000, T0 + 4 * 60_000 + 59_000]) {
      const windows = agentRollupWindows(now);
      expect(windows).toHaveLength(AGENT_ROLLUP_WINDOWS);
      const closed = closedWindows(windows[0], now, 100);
      expect(windows[windows.length - 1]).toBe(closed[closed.length - 1]);
      windows.slice(1).forEach((w, i) => expect(w - windows[i]).toBe(BUCKET_MS));
    }
  });
});

describe("agentIdOf", () => {
  it("só aceita agent:<guid>", () => {
    expect(agentIdOf(AGENT)).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(agentIdOf("agent:3F2504E0-4F89-11D3-9A0C-0305E82C3301")).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(agentIdOf(SERVER_VANTAGE)).toBeNull();
    expect(agentIdOf("agent:x")).toBeNull();
    expect(agentIdOf("agent:3f2504e0-4f89-11d3-9a0c-0305e82c3301' OR 1=1")).toBeNull();
  });
});

describe("buildPhaseSeries", () => {
  it("dá a mediana de cada etapa por passo e ignora as falhas", () => {
    const end = new Date(T0);
    const at = new Date(T0 - 10 * 60_000);
    const series = buildPhaseSeries(
      [
        { at, ok: true, dnsMs: 2, connectMs: 10, tlsMs: 20, ttfbMs: 40 },
        { at, ok: true, dnsMs: 4, connectMs: 12, tlsMs: 22, ttfbMs: 60 },
        { at, ok: false, dnsMs: 500, connectMs: null, tlsMs: null, ttfbMs: null },
      ],
      { end, hours: 24, stepMin: 30 },
    );
    expect(series).not.toBeNull();
    expect(series!.dnsMs).toHaveLength(48);
    const last = series!.dnsMs.length - 1;
    expect(series!.dnsMs[last]).toBe(3);
    expect(series!.connectMs[last]).toBe(11);
    expect(series!.ttfbMs[last]).toBe(50);
    expect(series!.dnsMs[0]).toBeNull();
  });

  it("sem medição ok devolve null", () => {
    expect(buildPhaseSeries([{ at: new Date(T0), ok: false, dnsMs: null, connectMs: null, tlsMs: null, ttfbMs: null }], { end: new Date(T0), hours: 24, stepMin: 30 })).toBeNull();
  });
});

describe("uptimeFromTotals", () => {
  it("usa as somas do groupBy", () => {
    expect(uptimeFromTotals(100, 1)).toBe(99);
    expect(uptimeFromTotals(null, null)).toBeNull();
  });
});
