import { describe, expect, it } from "vitest";
import type { Device } from "@prisma/client";
import { dedupeHostsByMac, hostnamesCompatible, normalizeMac, planDuplicateMerges } from "./device-identity";
import { mergedDeviceData } from "./device-merge";

const day = (n: number) => new Date(Date.UTC(2026, 9, n));

describe("normalizeMac", () => {
  it("padroniza grafias diferentes do mesmo MAC", () => {
    expect(normalizeMac("9c-b6-54-a6-f8-80")).toBe("9C:B6:54:A6:F8:80");
    expect(normalizeMac("9cb6.54a6.f880")).toBe("9C:B6:54:A6:F8:80");
    expect(normalizeMac(null)).toBeNull();
  });
});

describe("hostnamesCompatible", () => {
  it("só contradiz quando os dois existem e diferem", () => {
    expect(hostnamesCompatible(null, "PC")).toBe(true);
    expect(hostnamesCompatible("hp-z230", "HP-Z230")).toBe(true);
    expect(hostnamesCompatible("PC-SALA", "IMPRESSORA")).toBe(false);
  });
});

describe("dedupeHostsByMac", () => {
  const hosts = [
    { ip: "192.168.0.20", mac: "AA:AA:AA:AA:AA:AA" },
    { ip: "192.168.0.5", mac: "AA:AA:AA:AA:AA:AA" },
    { ip: "192.168.0.9", mac: null },
    { ip: "192.168.0.10", mac: "BB:BB:BB:BB:BB:BB" },
  ];

  it("mantém um host por MAC, preferindo o IP já conhecido", () => {
    const result = dedupeHostsByMac(hosts, new Map([["AA:AA:AA:AA:AA:AA", "192.168.0.20"]]));
    expect(result.map((h) => h.ip)).toEqual(["192.168.0.20", "192.168.0.9", "192.168.0.10"]);
  });

  it("sem IP conhecido, fica o de menor IP", () => {
    const result = dedupeHostsByMac(hosts, new Map());
    expect(result.map((h) => h.ip)).toEqual(["192.168.0.5", "192.168.0.9", "192.168.0.10"]);
  });
});

describe("planDuplicateMerges", () => {
  it("funde o mesmo MAC escrito de outro jeito no registro mais antigo", () => {
    const plans = planDuplicateMerges([
      { id: "novo", ip: "192.168.0.7", mac: "aa-bb-cc-dd-ee-ff", hostname: null, firstSeenAt: day(9) },
      { id: "antigo", ip: "192.168.0.7", mac: "AA:BB:CC:DD:EE:FF", hostname: null, firstSeenAt: day(1) },
    ]);
    expect(plans).toEqual([{ keepId: "antigo", mergeIds: ["novo"], mac: "AA:BB:CC:DD:EE:FF" }]);
  });

  it("funde o registro sem MAC no aparelho com MAC do mesmo IP, mantendo o mais antigo", () => {
    const plans = planDuplicateMerges([
      { id: "sem-mac", ip: "192.168.0.82", mac: null, hostname: "HP-Z230", firstSeenAt: day(1) },
      { id: "com-mac", ip: "192.168.0.82", mac: "9C:B6:54:A6:F8:80", hostname: "HP-Z230", firstSeenAt: day(3) },
    ]);
    expect(plans).toEqual([{ keepId: "sem-mac", mergeIds: ["com-mac"], mac: "9C:B6:54:A6:F8:80" }]);
  });

  it("não funde quando os hostnames se contradizem ou o IP teve vários aparelhos", () => {
    expect(
      planDuplicateMerges([
        { id: "a", ip: "192.168.0.50", mac: null, hostname: "IMPRESSORA", firstSeenAt: day(1) },
        { id: "b", ip: "192.168.0.50", mac: "11:11:11:11:11:11", hostname: "CELULAR", firstSeenAt: day(2) },
      ]),
    ).toEqual([]);
    expect(
      planDuplicateMerges([
        { id: "a", ip: "192.168.0.50", mac: null, hostname: null, firstSeenAt: day(1) },
        { id: "b", ip: "192.168.0.50", mac: "11:11:11:11:11:11", hostname: null, firstSeenAt: day(2) },
        { id: "c", ip: "192.168.0.50", mac: "22:22:22:22:22:22", hostname: null, firstSeenAt: day(3) },
      ]),
    ).toEqual([]);
  });

  it("aparelhos diferentes ficam separados", () => {
    expect(
      planDuplicateMerges([
        { id: "a", ip: "192.168.0.2", mac: "11:11:11:11:11:11", hostname: null, firstSeenAt: day(1) },
        { id: "b", ip: "192.168.0.3", mac: "22:22:22:22:22:22", hostname: null, firstSeenAt: day(1) },
        { id: "c", ip: "192.168.0.4", mac: null, hostname: null, firstSeenAt: day(1) },
      ]),
    ).toEqual([]);
  });
});

describe("mergedDeviceData", () => {
  const base: Device = {
    id: "x",
    ip: "192.168.0.10",
    mac: null,
    ipv6: null,
    hostname: null,
    alias: null,
    typeLocked: false,
    notes: null,
    vendor: null,
    type: "UNKNOWN",
    os: null,
    loggedUser: null,
    status: "OFFLINE",
    openPorts: "",
    firstSeenAt: day(1),
    lastSeenAt: day(1),
    createdAt: day(1),
    updatedAt: day(1),
  };

  it("mantém nome e tipo do antigo e traz IP e última vez visto do mais recente", () => {
    const keep = { ...base, id: "antigo", alias: "PC do Caixa", type: "COMPUTER" as const, typeLocked: true };
    const dup = {
      ...base,
      id: "novo",
      ip: "192.168.0.33",
      mac: "AA:BB:CC:DD:EE:FF",
      alias: "Outro nome",
      type: "MOBILE" as const,
      status: "ONLINE" as const,
      firstSeenAt: day(5),
      lastSeenAt: day(9),
    };
    const data = mergedDeviceData(keep, [dup], "AA:BB:CC:DD:EE:FF");
    expect(data).toMatchObject({
      mac: "AA:BB:CC:DD:EE:FF",
      ip: "192.168.0.33",
      status: "ONLINE",
      lastSeenAt: day(9),
      firstSeenAt: day(1),
      alias: "PC do Caixa",
    });
    expect(data.type).toBeUndefined();
    expect(data.typeLocked).toBeUndefined();
  });

  it("aproveita o que o usuário editou só no duplicado", () => {
    const dup = { ...base, id: "novo", alias: "Impressora RH", notes: "2º andar", type: "PRINTER" as const, typeLocked: true };
    const data = mergedDeviceData({ ...base, id: "antigo" }, [dup], null);
    expect(data).toMatchObject({ alias: "Impressora RH", notes: "2º andar", type: "PRINTER", typeLocked: true });
  });
});
