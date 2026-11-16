import { describe, expect, it } from "vitest";
import { EMBRATEL_PTR, TCP_GOOGLE, TCP_NO_PRIVILEGE, UDP_GOOGLE_ECMP, UDP_MIT_MIAMI } from "./__fixtures__/traceroute-embratel";
import { cityFromHostname, cityFromIata } from "./route-cities";
import { inPrefix, parsePrefix, routerRole } from "./route-roles";
import { lastVisibleTtl } from "./route-runner";
import { betterTrace, finishHops, isPermissionError, mergeTraces, parseTracerouteOutput, type TraceResult } from "./traceroute";

function result(stdout: string, dest: string, mode: TraceResult["mode"], tool = "traceroute"): TraceResult {
  const { hops, reached } = finishHops(parseTracerouteOutput(stdout), dest);
  return { ok: hops.length > 0, host: "google.com", address: dest, tool, hops, reached, error: null, mode };
}

describe("ECMP (fase 7)", () => {
  it("guarda todos os IPs que responderam no mesmo salto", () => {
    const hops = parseTracerouteOutput(UDP_GOOGLE_ECMP);
    expect(hops[3]).toEqual({ ttl: 4, ip: "200.230.20.5", rttMs: 9.4, altIps: ["200.230.20.9"] });
    expect(hops[4].altIps).toEqual(["200.230.20.5"]);
    expect(hops[0].altIps).toEqual([]);
  });

  it("a união de UDP e TCP junta os caminhos e chega ao destino", () => {
    const udp = result(UDP_GOOGLE_ECMP, "142.250.79.46", "udp");
    const tcp = result(TCP_GOOGLE, "142.250.79.46", "tcp", "traceroute (TCP 443)");
    expect(udp.reached).toBe(false);
    const merged = mergeTraces([udp, tcp]);
    expect(merged.mode).toBe("union");
    expect(merged.reached).toBe(true);
    expect(merged.hops).toHaveLength(8);
    // O principal vem do rastreio mais completo (TCP); o UDP soma os outros caminhos.
    expect(merged.hops[3]).toMatchObject({ ip: "200.230.20.9", altIps: ["200.230.20.5"] });
    expect(merged.tool).toBe("traceroute (TCP 443) + traceroute");
  });

  it("quando o TCP chega antes do último roteador do UDP, a rota termina no destino e com o tempo dele", () => {
    const dest = "142.250.1.1";
    const h = (ttl: number, ip: string, rttMs: number) => ({ ttl, ip, rttMs, altIps: [] as string[] });
    const base = { ok: true, host: "google.com", address: dest, error: null } as const;
    const tcp: TraceResult = { ...base, tool: "traceroute (TCP 443)", mode: "tcp", reached: true, hops: [h(1, "192.168.0.1", 1), h(2, dest, 10)] };
    const udp: TraceResult = { ...base, tool: "traceroute", mode: "udp", reached: false, hops: [h(1, "192.168.0.1", 1), h(2, "200.230.1.1", 9), h(3, "200.230.9.9", 100)] };
    const merged = mergeTraces([udp, tcp]);
    expect(merged.reached).toBe(true);
    expect(merged.hops).toHaveLength(2);
    expect(merged.hops[1]).toMatchObject({ ttl: 2, ip: dest, rttMs: 10, altIps: [] });
  });
});

describe("betterTrace", () => {
  it("prefere o que chegou, depois o que foi mais longe", () => {
    const udp = result(UDP_GOOGLE_ECMP, "142.250.79.46", "paris");
    const tcp = result(TCP_GOOGLE, "142.250.79.46", "tcp");
    expect(betterTrace(udp, tcp)).toBe(tcp);
    expect(betterTrace(tcp, udp)).toBe(tcp);
    const failed: TraceResult = { ...tcp, ok: false, hops: [], reached: false, error: "sem permissão" };
    expect(betterTrace(udp, failed)).toBe(udp);
  });
});

describe("permissão do modo TCP", () => {
  it("reconhece o aviso do traceroute sem CAP_NET_RAW", () => {
    expect(isPermissionError(TCP_NO_PRIVILEGE)).toBe(true);
    expect(isPermissionError("")).toBe(false);
  });
});

describe("último roteador visível", () => {
  it("é o último que respondeu quando a rota não chega", () => {
    const miami = result(UDP_MIT_MIAMI, "23.212.110.10", "paris");
    expect(lastVisibleTtl(miami)).toBe(5);
    expect(lastVisibleTtl(result(TCP_GOOGLE, "142.250.79.46", "tcp"))).toBeNull();
  });
});

describe("nomes da Embratel", () => {
  it("lê a cidade dos nomes reais", () => {
    expect(cityFromHostname(EMBRATEL_PTR.access)?.name).toBe("Rio de Janeiro");
    expect(cityFromHostname(EMBRATEL_PTR.intlMiami)?.name).toBe("Miami");
    expect(cityFromHostname(EMBRATEL_PTR.peeringGoogle)?.name).toBe("Rio de Janeiro");
    expect(cityFromHostname("ae-1.spo.embratel.net.br")?.name).toBe("São Paulo");
    // Um sufixo de papel sem código conhecido não vira cidade.
    expect(cityFromHostname("xyzac01.example.net.br")).toBeNull();
  });

  it("lê o papel do roteador", () => {
    expect(routerRole(EMBRATEL_PTR.access)).toBe("ACCESS");
    expect(routerRole(EMBRATEL_PTR.intlMiami)).toBe("INTL_EDGE");
    expect(routerRole(EMBRATEL_PTR.peeringGoogle)).toBe("PEERING");
    expect(routerRole("be-10.core1.gru.example.net")).toBe("CORE");
    expect(routerRole("142-250-79-46.example.com")).toBeNull();
    expect(routerRole(null)).toBeNull();
  });

  it("código de aeroporto dos PoPs", () => {
    expect(cityFromIata("GRU")?.name).toBe("São Paulo");
    expect(cityFromIata("gig")?.name).toBe("Rio de Janeiro");
    expect(cityFromIata("ZZZ")).toBeNull();
  });
});

describe("blocos CIDR", () => {
  it("IPv4 e IPv6", () => {
    const v4 = parsePrefix("187.16.216.0/21")!;
    expect(inPrefix("187.16.220.10", v4)).toBe(true);
    expect(inPrefix("187.16.224.1", v4)).toBe(false);
    const v6 = parsePrefix("2001:12f8::/64")!;
    expect(inPrefix("2001:12f8::1:2", v6)).toBe(true);
    expect(inPrefix("2001:12f8:0:1::1", v6)).toBe(false);
    expect(inPrefix("187.16.220.10", v6)).toBe(false);
    expect(parsePrefix("nada")).toBeNull();
  });
});
