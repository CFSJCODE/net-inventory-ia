import { describe, expect, it } from "vitest";
import { explainPortName } from "./port-hint";

describe("explainPortName", () => {
  it("explica o nome de porta do HP/Comware", () => {
    expect(explainPortName("porta GE1/0/3")).toBe(
      [
        "GE = GigabitEthernet: Ethernet de 1 Gbps",
        "1 = Membro 1 da pilha IRF (num switch sozinho é sempre 1)",
        "0 = Slot 0: portas fixas do próprio switch",
        "3 = Porta 3",
      ].join("\n"),
    );
  });

  it("reconhece 10 Gbps e slot de expansão", () => {
    expect(explainPortName("XGE2/1/24")).toContain("Ethernet de 10 Gbps");
    expect(explainPortName("XGE2/1/24")).toContain("1 = Slot 1: módulo de expansão");
  });

  it("ignora rótulos sem esse padrão", () => {
    expect(explainPortName("porta 5")).toBeUndefined();
    expect(explainPortName("Conexão Modem --> Switch")).toBeUndefined();
  });
});
