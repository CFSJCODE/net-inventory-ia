import { describe, expect, it } from "vitest";
import { parsePortName } from "./port-name";

describe("parsePortName", () => {
  it("explica o padrão membro/slot/porta do Comware", () => {
    const info = parsePortName("GigabitEthernet1/0/5");
    expect(info).toMatchObject({ type: "GigabitEthernet", abbr: "GE", numbers: [1, 0, 5], subinterface: null });
    expect(info?.typeLabel).toContain("1 Gbps");
    expect(info?.parts[1]).toContain("Slot 0");
    expect(info?.parts[2]).toBe("Porta 5");
  });

  it("aceita a forma abreviada e o 10G", () => {
    expect(parsePortName("GE1/0/25")?.type).toBe("GigabitEthernet");
    expect(parsePortName("Ten-GigabitEthernet1/0/49")?.abbr).toBe("XGE");
    expect(parsePortName("XGE2/0/1")?.parts[0]).toContain("Membro 2");
  });

  it("não confunde a porta de gerência com uma GE comum", () => {
    expect(parsePortName("M-GigabitEthernet0/0/0")?.type).toBe("M-GigabitEthernet");
  });

  it("reconhece interfaces lógicas e subinterfaces", () => {
    expect(parsePortName("Vlan-interface1")?.type).toBe("Vlan-interface");
    expect(parsePortName("Bridge-Aggregation3")?.abbr).toBe("BAGG");
    expect(parsePortName("GigabitEthernet0/1.100")?.subinterface).toBe(100);
  });

  it("devolve null para nomes desconhecidos", () => {
    expect(parsePortName("Tunnel0")).toBeNull();
    expect(parsePortName("")).toBeNull();
  });
});

describe("leitura dos valores da porta", () => {
  it("converte o TimeTicks formatado em minutos", async () => {
    const { ticksTextToMinutes } = await import("./equipment-status");
    expect(ticksTextToMinutes("11d 19h 50m")).toBe(11 * 1440 + 19 * 60 + 50);
    expect(ticksTextToMinutes("0d 0h 0m")).toBe(0);
    expect(ticksTextToMinutes("—")).toBeNull();
  });

  it("ignora a descrição padrão do Comware", async () => {
    const { configuredDescription } = await import("./equipment-status");
    expect(configuredDescription("GigabitEthernet1/0/2 Interface", "GigabitEthernet1/0/2")).toBeNull();
    expect(configuredDescription(" UPLINK ", "GigabitEthernet1/0/1")).toBe("UPLINK");
    expect(configuredDescription("", "GigabitEthernet1/0/1")).toBeNull();
  });
});
