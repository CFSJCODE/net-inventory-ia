import { describe, expect, it } from "vitest";
import * as rules from "./ip-rules";
import type { IpClassificationRule } from "./ip-rules";

const isValid = (p: string): boolean => {
  const fn = (rules as Record<string, unknown>).isValidRulePattern;
  if (typeof fn !== "function") throw new Error("isValidRulePattern não exportada");
  return (fn as (p: string) => boolean)(p);
};

describe("isValidRulePattern", () => {
  it("aceita os quatro formatos", () => {
    expect(isValid("192.168.0.50")).toBe(true);
    expect(isValid("192.168.0.10-192.168.0.20")).toBe(true);
    expect(isValid("192.168.0.10 - 192.168.0.20")).toBe(true);
    expect(isValid("192.168.0.0/24")).toBe(true);
    expect(isValid("0.0.0.0/0")).toBe(true);
    expect(isValid("192.168.0.*")).toBe(true);
  });
  it("recusa padrões inválidos", () => {
    for (const p of ["", "   ", "192.168.0", "192.168.0.256", "192.168.0.0/33", "192.168.0.0/-1", "abc", "192.168.0.10-", "192.168.0.10-300.1.1.1", "192.168.0.0/x", "1*"]) {
      expect(isValid(p), p).toBe(false);
    }
  });
});

describe("findMatchingRule com regra inválida", () => {
  it("pula a regra inválida e usa a próxima válida", () => {
    const list: IpClassificationRule[] = [
      { id: "a", pattern: "1*", type: "ROUTER", lock: false, enabled: true } as IpClassificationRule,
      { id: "b", pattern: "192.168.0.0/24", type: "PRINTER", lock: false, enabled: true } as IpClassificationRule,
    ];
    expect(rules.findMatchingRule("192.168.0.9", list)?.id).toBe("b");
  });
});
