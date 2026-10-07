import { describe, expect, it } from "vitest";
import { listHostsInCidr, MAX_SCAN_HOSTS, parseCidr, parseScanCidr } from "./subnet";

describe("parseCidr", () => {
  it("calcula rede, máscara, broadcast e faixa de hosts de um /24", () => {
    expect(parseCidr("192.168.1.0/24")).toEqual({
      network: "192.168.1.0",
      prefix: 24,
      mask: "255.255.255.0",
      broadcast: "192.168.1.255",
      totalAddresses: 256,
      hostCount: 254,
      firstHost: "192.168.1.1",
      lastHost: "192.168.1.254",
      baseAdjusted: false,
    });
  });

  it("usa 2^(32-p) - 2 hosts até /30", () => {
    expect(parseCidr("10.0.0.0/20")).toMatchObject({ hostCount: 4094, firstHost: "10.0.0.1", lastHost: "10.0.15.254", mask: "255.255.240.0" });
    expect(parseCidr("10.0.0.0/30")).toMatchObject({ hostCount: 2, firstHost: "10.0.0.1", lastHost: "10.0.0.2", broadcast: "10.0.0.3" });
  });

  it("trata /31 como enlace ponto a ponto com 2 hosts (RFC 3021)", () => {
    expect(parseCidr("10.0.0.0/31")).toMatchObject({ hostCount: 2, firstHost: "10.0.0.0", lastHost: "10.0.0.1", broadcast: null });
  });

  it("trata /32 como host único", () => {
    expect(parseCidr("10.0.0.7/32")).toMatchObject({ hostCount: 1, firstHost: "10.0.0.7", lastHost: "10.0.0.7", mask: "255.255.255.255" });
  });

  it("alinha um IP de host ao endereço de rede e sinaliza o ajuste", () => {
    expect(parseCidr("192.168.1.130/25")).toMatchObject({ network: "192.168.1.128", firstHost: "192.168.1.129", baseAdjusted: true });
  });

  it("calcula /0 sem o estouro de shift de 32 bits", () => {
    expect(parseCidr("0.0.0.0/0")).toMatchObject({ mask: "0.0.0.0", totalAddresses: 2 ** 32, broadcast: "255.255.255.255" });
  });

  it("recusa entradas malformadas", () => {
    expect(() => parseCidr("192.168.1.0")).toThrow(/CIDR inválido/);
    expect(() => parseCidr("192.168.1.300/24")).toThrow(/IP inválido/);
    expect(() => parseCidr("192.168.1.0/33")).toThrow(/Prefixo inválido/);
  });
});

describe("parseScanCidr", () => {
  it("aceita de /20 a /32", () => {
    expect(parseScanCidr("10.0.0.0/20").hostCount).toBe(MAX_SCAN_HOSTS);
    expect(parseScanCidr("10.0.0.1/32").hostCount).toBe(1);
  });

  it("recusa blocos maiores que /20", () => {
    expect(() => parseScanCidr("10.0.0.0/19")).toThrow(/8\.190 hosts/);
  });
});

describe("listHostsInCidr", () => {
  it("lista exatamente os hosts calculados", () => {
    const hosts = listHostsInCidr("192.168.1.0/24");
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe("192.168.1.1");
    expect(hosts.at(-1)).toBe("192.168.1.254");
    expect(listHostsInCidr("10.0.0.0/31")).toEqual(["10.0.0.0", "10.0.0.1"]);
    expect(listHostsInCidr("10.0.0.5/32")).toEqual(["10.0.0.5"]);
  });
});
