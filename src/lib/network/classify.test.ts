import { describe, expect, it } from "vitest";
import { classifyDevice } from "./classify";

const c = (vendor: string | null, openPorts: number[]) => classifyDevice({ ip: "192.168.15.50", hostname: null, vendor, openPorts });

describe("classifyDevice", () => {
  it("roteador TP-Link com painel web ou só SSH", () => {
    expect(c("TP-Link Systems Inc", [22, 80])).toBe("ROUTER");
    expect(c("TP-Link Systems Inc", [22])).toBe("ROUTER");
  });
  it("tomada inteligente TP-Link sem portas continua desconhecida", () => {
    expect(c("TP-Link Systems Inc", [])).toBe("UNKNOWN");
  });
  it("celular por fabricante sem portas abertas", () => {
    expect(c("Beijing Xiaomi Mobile Software Co., Ltd", [])).toBe("MOBILE");
  });
  it("impressora pela porta 9100", () => expect(c(null, [9100])).toBe("PRINTER"));
  it("PC Windows pelo SMB", () => expect(c("Elitegroup", [135, 139, 445])).toBe("COMPUTER"));
});
