import { describe, expect, it } from "vitest";
import { buildTimeline, describeCell, diagnose, normalizeHours, stepForHours, type LaneInput, type LaneKey, type LaneSample } from "./timeline";
import type { DnsAnswer } from "./types";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 15, 22, 0); // 19h00 em Brasília
const answers = (ms: number): DnsAnswer[] => [
  { resolver: "system", ok: true, ms, rcode: "NOERROR", ttlSec: 120, addresses: ["162.159.135.232"] },
  { resolver: "8.8.8.8", ok: true, ms: ms + 10, rcode: "NOERROR", ttlSec: 300, addresses: ["162.159.135.232"] },
  { resolver: "1.1.1.1", ok: true, ms: ms + 2, rcode: "NOERROR", ttlSec: 290, addresses: ["162.159.135.232"] },
];

/** Uma medição por minuto durante `minutes`, com a função dando a amostra de cada minuto. */
function series(minutes: number, make: (i: number, at: number) => Omit<LaneSample, "at">): LaneSample[] {
  return Array.from({ length: minutes }, (_, i) => ({ at: T0 + i * MIN + 5_000, ...make(i, T0 + i * MIN) }));
}

/** O cenário do pedido: às 20h05 a LAN e a WAN estáveis, TCP normal, mas o TTFB do Discord sobe. */
function discordScenario(): Record<LaneKey, LaneInput> {
  const slowFrom = 65; // 20h05
  return {
    gateway: { source: "ping no gateway", samples: series(120, () => ({ ok: true, latencyMs: 1 + Math.random() * 0.3, lossPct: 0 })) },
    wan: { source: "ping nos resolvedores", samples: series(120, () => ({ ok: true, latencyMs: 14, lossPct: 0 })) },
    dns: { source: "DNS composto", samples: series(120, () => ({ ok: true, latencyMs: 4, answers: answers(4), rcode: "NOERROR", ttlSec: 120 })) },
    https: {
      source: "HTTPS",
      samples: series(120, (i) => {
        const ttfb = i >= slowFrom ? 420 : 90;
        return { ok: true, latencyMs: ttfb, httpStatus: 200, stages: { dnsMs: 4, connectMs: 20, tlsMs: 25, ttfbMs: ttfb, totalMs: 4 + 20 + 25 + ttfb } };
      }),
    },
  };
}

describe("buildTimeline", () => {
  it("alinha as quatro faixas nos mesmos passos", () => {
    const tl = buildTimeline(discordScenario(), { start: T0, end: T0 + 120 * MIN, stepMs: MIN }, { size: 20, serviceName: "Discord" });
    expect(tl.steps).toHaveLength(120);
    for (const lane of ["gateway", "wan", "dns", "https"] as const) expect(tl.lanes[lane]).toHaveLength(120);
  });

  it("aponta o HTTPS e o TTFB, com LAN, WAN e DNS estáveis", () => {
    // Às 20h15: dez minutos de lentidão. (Uma hora depois a base dinâmica já se ajustou ao nível novo.)
    const tl = buildTimeline(discordScenario(), { start: T0, end: T0 + 75 * MIN, stepMs: MIN }, { size: 20, serviceName: "Discord" });
    const at2005 = 65;
    // Às 20h05 a janela ainda tem 19 medições normais; o gatilho aparece um ou dois minutos depois.
    const firstWarn = tl.lanes.https.findIndex((c) => c.state === "warn");
    expect(firstWarn).toBeGreaterThanOrEqual(at2005);
    expect(firstWarn).toBeLessThanOrEqual(at2005 + 2);
    expect(tl.lanes.gateway.every((c) => c.state === "ok")).toBe(true);
    expect(tl.lanes.wan.every((c) => c.state === "ok")).toBe(true);
    expect(tl.lanes.dns.every((c) => c.state === "ok")).toBe(true);
    expect(tl.lanes.https[at2005 + 3].stages?.ttfbMs).toBe(420);
    expect(tl.summary.https.blamed?.stage).toBe("ttfbMs");
    expect(tl.diagnosis).toContain("LAN, WAN e DNS normais");
    expect(tl.diagnosis).toContain("TTFB");
    expect(tl.diagnosis).toContain("servidor do serviço");
  });

  it("DNS composto: latência por resolvedor, TTL esperado e envelhecimento no cache", () => {
    const tl = buildTimeline(discordScenario(), { start: T0, end: T0 + 120 * MIN, stepMs: MIN }, { size: 20 });
    const dns = tl.summary.dns;
    expect(dns.expectedTtlSec).toBe(300);
    const system = dns.resolvers!.find((r) => r.resolver === "system")!;
    expect(system.p50Ms).toBe(4);
    expect(system.ttlDriftSec).toBe(180);
    expect(dns.resolvers!.find((r) => r.resolver === "8.8.8.8")!.ttlDriftSec).toBe(0);
    expect(tl.lanes.dns[10].resolvers).toHaveLength(3);
  });

  it("conta NXDOMAIN, SERVFAIL e TIMEOUT por resolvedor", () => {
    const lanes = discordScenario();
    lanes.dns.samples = series(30, (i) => {
      const bad: DnsAnswer["rcode"] = i % 3 === 0 ? "NXDOMAIN" : i % 3 === 1 ? "SERVFAIL" : "TIMEOUT";
      return {
        ok: false,
        latencyMs: null,
        error: "DNS do sistema: falha",
        answers: [
          { resolver: "system", ok: false, ms: null, rcode: bad, ttlSec: null, addresses: [] },
          { resolver: "8.8.8.8", ok: true, ms: 12, rcode: "NOERROR", ttlSec: 60, addresses: ["1.2.3.4"] },
        ],
      };
    });
    const tl = buildTimeline(lanes, { start: T0, end: T0 + 30 * MIN, stepMs: MIN });
    const system = tl.summary.dns.resolvers!.find((r) => r.resolver === "system")!;
    expect(system.errors).toEqual({ NXDOMAIN: 10, SERVFAIL: 10, TIMEOUT: 10 });
    expect(tl.lanes.dns.every((c) => c.state === "bad")).toBe(true);
    expect(tl.diagnosis).toContain("DNS");
  });

  it("gateway caído vence: o problema está na LAN mesmo com o resto falhando", () => {
    const lanes = discordScenario();
    for (const lane of ["gateway", "wan", "https"] as const) lanes[lane].samples = series(10, () => ({ ok: false, latencyMs: null, error: "sem resposta" }));
    const tl = buildTimeline(lanes, { start: T0, end: T0 + 10 * MIN, stepMs: MIN });
    expect(tl.lanes.gateway[5].state).toBe("bad");
    expect(tl.diagnosis).toContain("rede local");
  });

  it("passo maior junta várias medições: falha parcial é amarela, total é vermelha", () => {
    const lanes = discordScenario();
    lanes.wan.samples = series(10, (i) => (i === 2 ? { ok: false, latencyMs: null } : { ok: true, latencyMs: 14 }));
    const tl = buildTimeline(lanes, { start: T0, end: T0 + 10 * MIN, stepMs: 5 * MIN });
    expect(tl.lanes.wan.map((c) => c.state)).toEqual(["warn", "ok"]);
    expect(tl.lanes.wan[0]).toMatchObject({ samples: 5, failures: 1, ms: 14 });
  });

  it("a base é dinâmica: uma hora depois, o nível novo vira o normal", () => {
    const tl = buildTimeline(discordScenario(), { start: T0, end: T0 + 120 * MIN, stepMs: MIN }, { size: 20 });
    expect(tl.summary.https.blamed).toBeNull();
    expect(tl.lanes.https.at(-1)!.state).toBe("ok");
  });

  it("faixa sem medição fica 'none' e não é culpada", () => {
    const lanes = discordScenario();
    lanes.dns.samples = [];
    const tl = buildTimeline(lanes, { start: T0, end: T0 + 30 * MIN, stepMs: MIN });
    expect(tl.summary.dns.available).toBe(false);
    expect(tl.lanes.dns.every((c) => c.state === "none")).toBe(true);
  });
});

describe("diagnose e describeCell", () => {
  it("tudo estável", () => {
    expect(diagnose({ gateway: "ok", wan: "ok", dns: "ok", https: "ok" })).toContain("estáveis");
    expect(diagnose({ gateway: "none", wan: "none", dns: "none", https: "none" })).toContain("sem medições");
  });

  it("WAN instável com LAN normal", () => {
    expect(diagnose({ gateway: "ok", wan: "warn", dns: "ok", https: "warn" })).toContain("WAN instável");
  });

  it("frase de um passo HTTPS traz as etapas", () => {
    const text = describeCell("https", { state: "ok", samples: 1, failures: 0, ms: 90, lossPct: null, p95Ms: 90, baselineMs: 90, degraded: false, error: null, stages: { dnsMs: 4, connectMs: 20, tlsMs: 25.5, ttfbMs: 90 } });
    expect(text).toBe("estável: DNS 4,0 ms · TCP 20 ms · TLS 26 ms · TTFB 90 ms");
  });

  it("passos e períodos", () => {
    expect(stepForHours(1)).toBe(MIN);
    expect(stepForHours(3)).toBe(2 * MIN);
    expect(stepForHours(24)).toBe(15 * MIN);
    expect(normalizeHours("6")).toBe(6);
    expect(normalizeHours(5)).toBe(3);
  });
});
