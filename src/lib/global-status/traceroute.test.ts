import { describe, expect, it } from "vitest";
import { finishHops, isTraceableHost, parseTracepathOutput, parseTracertOutput, parseTracerouteOutput } from "./traceroute";

describe("parseTracerouteOutput", () => {
  it("lê saltos com tempos, sem resposta e com mais de um IP", () => {
    const out = [
      "traceroute to 1.1.1.1 (1.1.1.1), 20 hops max, 60 byte packets",
      " 1  192.168.0.1  0.512 ms  0.433 ms",
      " 2  * *",
      " 3  10.15.0.1  8.201 ms 177.10.0.9  9.880 ms",
      " 4  1.1.1.1  12.1 ms !H  11.9 ms",
    ].join("\n");
    expect(parseTracerouteOutput(out)).toEqual([
      { ttl: 1, ip: "192.168.0.1", rttMs: 0.4 },
      { ttl: 2, ip: null, rttMs: null },
      { ttl: 3, ip: "10.15.0.1", rttMs: 8.2 },
      { ttl: 4, ip: "1.1.1.1", rttMs: 11.9 },
    ]);
  });
});

describe("parseTracepathOutput", () => {
  it("fica com a primeira resposta de cada salto e ignora pmtu e asymm", () => {
    const out = [
      " 1?: [LOCALHOST]                      pmtu 1500",
      " 1:  192.168.0.1                                           0.611ms ",
      " 1:  192.168.0.1                                           0.402ms ",
      " 2:  no reply",
      " 3:  200.160.1.1                                          10.250ms asymm  4",
      "     Resume: pmtu 1500 hops 3 back 4 ",
    ].join("\n");
    expect(parseTracepathOutput(out)).toEqual([
      { ttl: 1, ip: "192.168.0.1", rttMs: 0.6 },
      { ttl: 2, ip: null, rttMs: null },
      { ttl: 3, ip: "200.160.1.1", rttMs: 10.3 },
    ]);
  });
});

describe("parseTracertOutput", () => {
  it("lê a saída do Windows em português", () => {
    const out = [
      "Rastreando a rota para 1.1.1.1 com no máximo 20 saltos",
      "",
      "  1    <1 ms    <1 ms    <1 ms  192.168.0.1",
      "  2     *        *        *     Esgotado o tempo limite do pedido.",
      "  3    12 ms    11 ms    13 ms  1.1.1.1",
      "",
      "Rastreamento concluído.",
    ].join("\r\n");
    expect(parseTracertOutput(out)).toEqual([
      { ttl: 1, ip: "192.168.0.1", rttMs: 1 },
      { ttl: 2, ip: null, rttMs: null },
      { ttl: 3, ip: "1.1.1.1", rttMs: 11 },
    ]);
  });
});

describe("finishHops", () => {
  it("corta os saltos mudos do fim e diz se chegou", () => {
    const hops = [
      { ttl: 1, ip: "192.168.0.1", rttMs: 1 },
      { ttl: 2, ip: "1.1.1.1", rttMs: 10 },
      { ttl: 3, ip: null, rttMs: null },
    ];
    expect(finishHops(hops, "1.1.1.1")).toEqual({ hops: hops.slice(0, 2), reached: true });
    expect(finishHops(hops, "8.8.8.8").reached).toBe(false);
    expect(finishHops([], "1.1.1.1")).toEqual({ hops: [], reached: false });
  });
});

describe("isTraceableHost", () => {
  it("aceita IP e nome, recusa opção e espaço", () => {
    expect(isTraceableHost("1.1.1.1")).toBe(true);
    expect(isTraceableHost("www.github.com")).toBe(true);
    expect(isTraceableHost("-m 99")).toBe(false);
    expect(isTraceableHost("a b")).toBe(false);
    expect(isTraceableHost(undefined)).toBe(false);
  });
});
