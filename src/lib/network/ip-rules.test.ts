import { describe, expect, it } from "vitest";
import {
  findMatchingRule,
  ipToNumber,
  matchesIpPattern,
  type IpClassificationRule,
} from "./ip-rules";

describe("IP Classification Rules", () => {
  describe("ipToNumber", () => {
    it("converte IP válido para número unsigned", () => {
      expect(ipToNumber("192.168.1.1")).toBe(3232235777);
      expect(ipToNumber("0.0.0.0")).toBe(0);
      expect(ipToNumber("255.255.255.255")).toBe(4294967295);
    });

    it("retorna -1 para IPs inválidos", () => {
      expect(ipToNumber("invalid")).toBe(-1);
      expect(ipToNumber("192.168.1.300")).toBe(-1);
      expect(ipToNumber("192.168.1")).toBe(-1);
    });
  });

  describe("matchesIpPattern", () => {
    it("corresponde a IP individual exato", () => {
      expect(matchesIpPattern("192.168.0.50", "192.168.0.50")).toBe(true);
      expect(matchesIpPattern("192.168.0.51", "192.168.0.50")).toBe(false);
    });

    it("corresponde a faixa com hífen (range)", () => {
      const pattern = "192.168.0.100 - 192.168.0.120";
      expect(matchesIpPattern("192.168.0.99", pattern)).toBe(false);
      expect(matchesIpPattern("192.168.0.100", pattern)).toBe(true);
      expect(matchesIpPattern("192.168.0.110", pattern)).toBe(true);
      expect(matchesIpPattern("192.168.0.120", pattern)).toBe(true);
      expect(matchesIpPattern("192.168.0.121", pattern)).toBe(false);
    });

    it("corresponde a CIDR", () => {
      const cidr = "192.168.0.0/24";
      expect(matchesIpPattern("192.168.0.1", cidr)).toBe(true);
      expect(matchesIpPattern("192.168.0.254", cidr)).toBe(true);
      expect(matchesIpPattern("192.168.1.1", cidr)).toBe(false);

      const smallCidr = "192.168.0.128/28"; // 128 a 143
      expect(matchesIpPattern("192.168.0.128", smallCidr)).toBe(true);
      expect(matchesIpPattern("192.168.0.143", smallCidr)).toBe(true);
      expect(matchesIpPattern("192.168.0.144", smallCidr)).toBe(false);
    });

    it("corresponde a wildcard com asterisco", () => {
      const wildcard = "192.168.15.*";
      expect(matchesIpPattern("192.168.15.10", wildcard)).toBe(true);
      expect(matchesIpPattern("192.168.15.250", wildcard)).toBe(true);
      expect(matchesIpPattern("192.168.1.10", wildcard)).toBe(false);
    });
  });

  describe("findMatchingRule", () => {
    const rules: IpClassificationRule[] = [
      {
        id: "1",
        name: "Impressora da Sala",
        pattern: "192.168.0.50",
        type: "PRINTER",
        lock: true,
        enabled: true,
      },
      {
        id: "2",
        name: "Câmeras CFTV",
        pattern: "192.168.0.200 - 192.168.0.220",
        type: "CAMERA",
        lock: true,
        enabled: true,
      },
      {
        id: "3",
        name: "Regra Desativada",
        pattern: "192.168.0.10",
        type: "ROUTER",
        lock: true,
        enabled: false,
      },
    ];

    it("encontra regra correspondente ativa", () => {
      const match1 = findMatchingRule("192.168.0.50", rules);
      expect(match1).toBeDefined();
      expect(match1?.type).toBe("PRINTER");

      const match2 = findMatchingRule("192.168.0.205", rules);
      expect(match2).toBeDefined();
      expect(match2?.type).toBe("CAMERA");
    });

    it("ignora regras desativadas", () => {
      const match = findMatchingRule("192.168.0.10", rules);
      expect(match).toBeNull();
    });

    it("retorna null se não houver regra para o IP", () => {
      const match = findMatchingRule("192.168.0.77", rules);
      expect(match).toBeNull();
    });
  });
});
