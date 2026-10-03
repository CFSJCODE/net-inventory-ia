import { describe, expect, it } from "vitest";
import { parsePortSpec } from "./port-scan";

describe("parsePortSpec", () => {
  it("lista, faixas, duplicadas e ordenação", () => {
    expect(parsePortSpec("80, 22,20-23,80")).toEqual([20, 21, 22, 23, 80]);
  });
  it("rejeita porta fora do intervalo, faixa invertida e vazio", () => {
    expect(() => parsePortSpec("70000")).toThrow();
    expect(() => parsePortSpec("100-50")).toThrow();
    expect(() => parsePortSpec("")).toThrow();
  });
});
