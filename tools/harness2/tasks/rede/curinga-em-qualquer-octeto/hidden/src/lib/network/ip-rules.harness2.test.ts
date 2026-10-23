import { describe, expect, it } from "vitest";
import { matchesIpPattern } from "./ip-rules";

describe("curinga em qualquer octeto", () => {
  it("aceita curinga no terceiro octeto", () => {
    expect(matchesIpPattern("192.168.5.10", "192.168.*.10")).toBe(true);
    expect(matchesIpPattern("192.168.200.10", "192.168.*.10")).toBe(true);
  });
  it("recusa quando o octeto fixo difere", () => {
    expect(matchesIpPattern("192.168.5.11", "192.168.*.10")).toBe(false);
    expect(matchesIpPattern("192.169.5.10", "192.168.*.10")).toBe(false);
  });
  it("aceita vários curingas", () => {
    expect(matchesIpPattern("10.1.2.1", "10.*.*.1")).toBe(true);
    expect(matchesIpPattern("10.1.2.2", "10.*.*.1")).toBe(false);
    expect(matchesIpPattern("8.8.8.8", "*.*.*.*")).toBe(true);
  });
  it("mantém o curinga final cobrindo os octetos restantes", () => {
    expect(matchesIpPattern("192.168.0.42", "192.168.0.*")).toBe(true);
    expect(matchesIpPattern("192.168.5.20", "192.168.*")).toBe(true);
    expect(matchesIpPattern("192.169.5.20", "192.168.*")).toBe(false);
  });
  it("não confunde octetos com prefixos de texto", () => {
    expect(matchesIpPattern("192.168.10.5", "192.168.1.*")).toBe(false);
  });
  it("recusa asterisco colado a dígitos", () => {
    expect(matchesIpPattern("192.168.10.5", "192.168.1*")).toBe(false);
    expect(matchesIpPattern("192.168.1.5", "192.168.1*")).toBe(false);
  });
  it("continua aceitando faixa, CIDR e IP único", () => {
    expect(matchesIpPattern("192.168.0.15", "192.168.0.10-192.168.0.20")).toBe(true);
    expect(matchesIpPattern("192.168.0.15", "192.168.0.0/28")).toBe(true);
    expect(matchesIpPattern("192.168.0.16", "192.168.0.0/28")).toBe(false);
    expect(matchesIpPattern("192.168.0.50", "192.168.0.50")).toBe(true);
  });
});
