import { describe, expect, it } from "vitest";
import type { Device } from "@prisma/client";
import { Redactor, nameHints } from "./redact";

const device = (over: Partial<Device>): Device => ({
  id: "d1",
  ip: "192.168.0.1",
  mac: "A4:2B:B0:12:34:56",
  ipv6: "2001:db8:34:101f::1",
  hostname: "roteador-casa",
  alias: null,
  typeLocked: false,
  notes: null,
  vendor: "TP-Link",
  type: "ROUTER",
  os: null,
  loggedUser: null,
  status: "ONLINE",
  openPorts: "22,80",
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("Redactor", () => {
  it("não deixa IP, MAC, IPv6, hostname nem apelido no payload", () => {
    const r = new Redactor();
    const d = device({ alias: "Roteador do João" });
    const payload = JSON.stringify([
      r.device(d),
      r.text("ligação com Roteador do João (192.168.0.1) caiu; MAC A4-2B-B0-12-34-56, v6 2001:db8:34:101f::1"),
    ]);
    for (const secret of ["192.168.0.1", "A4:2B", "A4-2B", "2001:db8", "roteador-casa", "João"]) {
      expect(payload).not.toContain(secret);
    }
  });

  it("desmascara a resposta de volta, sem duplicar o IP", () => {
    const r = new Redactor();
    r.device(device({}));
    const masked = r.text("— ligação com roteador-casa (192.168.0.1) caiu");
    expect(masked).toBe("— ligação com dispositivo-1 (ip-1) caiu");
    expect(r.unmask(masked)).toBe("— ligação com roteador-casa (192.168.0.1) caiu");
  });

  it("não confunde horário com IPv6 e mascara IPv6 comprimido inteiro", () => {
    expect(new Redactor().text("às 12:30:45 o 2001:db8:34::1 caiu")).toBe("às 12:30:45 o ip-1 caiu");
  });

  it("gera dicas genéricas do nome sem enviar o nome", () => {
    expect(nameHints("DESKTOP-A1B2C3D")).toEqual(["padrão de nome do Windows"]);
    expect(nameHints("Galaxy-S21")).toEqual(["Samsung"]);
  });
});
