import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import type { DiscoveredHost } from "./network/types";

// Prisma real, sempre em um banco temporário exclusivo. Só a descoberta de rede é simulada.
const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { PrismaClient } = await import("@prisma/client");
  const directory = mkdtempSync(join(tmpdir(), "netinventory-mac-test-"));
  const path = join(directory, "inventory.db");
  return {
    directory,
    path,
    prisma: new PrismaClient({ datasources: { db: { url: `file:${path.replace(/\\/g, "/")}` } } }),
    scanNetwork: vi.fn<() => Promise<DiscoveredHost[]>>(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: fixture.prisma }));
vi.mock("@/lib/network/scanner", () => ({ scanNetwork: fixture.scanNetwork }));

import { runScanAndPersist } from "./scan-service";
import { displayName } from "./device-name";
import { classifyDevice } from "./network/classify";
import { getIpRules } from "./network/ip-rules";
import { normalizeMac, hostnamesCompatible } from "./device-identity";
import { mergeDuplicateDevices } from "./device-merge";
import { loadPackagedScan } from "../../installer/mac-update-lib.mjs";

const db = fixture.prisma;
const MAC = "9C:B6:54:A6:F8:80";
const OTHER_MAC = "00:11:22:33:44:55";
const CIDR = "192.168.0.0/24";
const firstSeenAt = new Date("2026-10-01T12:00:00Z");
const packagedScan = process.env.NETINVENTORY_SCAN_PACKAGE_DIR
  ? loadPackagedScan(process.env.NETINVENTORY_SCAN_PACKAGE_DIR, process.env.NETINVENTORY_SCAN_PACKAGE_CHUNK)
  : null;

function host(overrides: Partial<DiscoveredHost> = {}): DiscoveredHost {
  return {
    ip: "192.168.0.166", mac: MAC, hostname: "gateway.docker.internal",
    ipv6: [], vendor: null, openPorts: [445], type: "COMPUTER", ...overrides,
  };
}

function device(overrides: Partial<Prisma.DeviceCreateInput> = {}) {
  return db.device.create({ data: {
    ip: "192.168.0.92", mac: MAC, hostname: "4600G", alias: "Meu 4600G",
    notes: "Identificação manual", type: "COMPUTER", typeLocked: true,
    status: "ONLINE", firstSeenAt, lastSeenAt: firstSeenAt, ...overrides,
  } });
}

async function scan(hosts: DiscoveredHost[]) {
  fixture.scanNetwork.mockResolvedValue(hosts);
  if (packagedScan) return packagedScan(CIDR, {
    prisma: db, scanNetwork: fixture.scanNetwork, classifyDevice, getIpRules,
    normalizeMac, hostnamesCompatible, mergeDuplicateDevices,
  });
  return runScanAndPersist(CIDR);
}

beforeAll(async () => {
  const migrations = new URL("../../prisma/migrations/", import.meta.url);
  for (const name of readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const sql = readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8");
    for (const statement of sql.split(";").filter((part) => part.trim())) {
      await db.$executeRawUnsafe(statement);
    }
  }
});

beforeEach(async () => {
  fixture.scanNetwork.mockReset();
  await db.topologyLink.deleteMany();
  await db.mapPosition.deleteMany();
  await db.deviceEvent.deleteMany();
  await db.device.deleteMany();
  await db.scanRun.deleteMany();
  await db.appSetting.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
  // Apenas o arquivo exclusivo criado acima; nenhuma exclusão recursiva.
  unlinkSync(fixture.path);
  rmdirSync(fixture.directory);
});

describe("identidade por MAC na persistência do scan", () => {
  it("4600G troca .92 por .166 mantendo id, nome, apelido, histórico e mapa", async () => {
    const uplink = await device({ ip: "192.168.0.1", mac: OTHER_MAC, hostname: "Switch", alias: null });
    const pc = await device({ uplink: { connect: { id: uplink.id } } });
    const link = await db.topologyLink.create({ data: { fromDeviceId: uplink.id, toDeviceId: pc.id } });
    const position = await db.mapPosition.create({ data: { nodeId: pc.id, x: 100, y: 80 } });
    const oldEvent = await db.deviceEvent.create({ data: {
      deviceId: pc.id, type: "DEVICE_DISCOVERED", message: "Cadastro original",
    } });

    expect(await scan([host(), host({ ip: uplink.ip, mac: OTHER_MAC, hostname: "Switch", type: "SWITCH" })]))
      .toEqual({ devicesFound: 2, newDevices: 0 });
    const updated = await db.device.findUniqueOrThrow({ where: { id: pc.id } });
    expect(updated).toMatchObject({
      ip: "192.168.0.166", mac: MAC, hostname: "4600G", alias: "Meu 4600G",
      notes: pc.notes, type: pc.type, typeLocked: true, firstSeenAt, uplinkId: uplink.id,
    });
    expect(updated.lastSeenAt.getTime()).toBeGreaterThan(firstSeenAt.getTime());
    expect(displayName(updated)).toBe("Meu 4600G");
    expect(await db.device.count()).toBe(2);
    expect(await db.topologyLink.findUnique({ where: { id: link.id } })).toEqual(link);
    expect(await db.mapPosition.findUnique({ where: { nodeId: pc.id } })).toEqual(position);
    expect(await db.deviceEvent.findUnique({ where: { id: oldEvent.id } })).toEqual(oldEvent);
    expect(await db.deviceEvent.findMany({ where: { deviceId: pc.id, id: { not: oldEvent.id } } }))
      .toEqual([expect.objectContaining({ type: "IP_CHANGED", previousValue: pc.ip, newValue: updated.ip })]);
  });

  it("preserva também o hostname quando não há apelido e não repete eventos", async () => {
    const pc = await device({ alias: null });
    await scan([host()]);
    await scan([host({ hostname: "OUTRO-NOME" })]);
    await scan([host({ hostname: null })]);
    const updated = await db.device.findUniqueOrThrow({ where: { id: pc.id } });
    expect(displayName(updated)).toBe("4600G");
    expect(await db.device.count()).toBe(1);
    expect(await db.deviceEvent.findMany()).toEqual([expect.objectContaining({ type: "IP_CHANGED" })]);
  });

  it("aprende no primeiro scan e atualiza automaticamente em futuras trocas de IP", async () => {
    expect(await scan([host({ ip: "192.168.0.92", hostname: "4600G" })]))
      .toEqual({ devicesFound: 1, newDevices: 1 });
    const original = await db.device.findFirstOrThrow();
    expect(await scan([host()])).toEqual({ devicesFound: 1, newDevices: 0 });
    expect(await scan([host({ ip: "192.168.0.92" })])).toEqual({ devicesFound: 1, newDevices: 0 });
    expect(await db.device.findMany()).toEqual([expect.objectContaining({
      id: original.id, ip: "192.168.0.92", hostname: "4600G", firstSeenAt: original.firstSeenAt,
    })]);
    expect(await db.deviceEvent.count({ where: { type: "IP_CHANGED" } })).toBe(2);
    expect(await db.deviceEvent.count({ where: { type: "DEVICE_DISCOVERED" } })).toBe(1);
  });

  it("reconhece MAC legado com hífens e scan com pontos no novo IP", async () => {
    const pc = await device({ mac: "9c-b6-54-a6-f8-80" });
    expect(await scan([host({ mac: "9cb6.54a6.f880" })])).toEqual({ devicesFound: 1, newDevices: 0 });
    expect(await db.device.findMany()).toEqual([expect.objectContaining({
      id: pc.id, mac: MAC, ip: "192.168.0.166", hostname: "4600G", alias: pc.alias,
    })]);
  });

  it("mantém o IP conhecido se o mesmo MAC aparecer em dois IPs no mesmo scan", async () => {
    const pc = await device({ mac: "9c-b6-54-a6-f8-80" });
    expect(await scan([host(), host({ ip: pc.ip, mac: "9cb6.54a6.f880" })]))
      .toEqual({ devicesFound: 1, newDevices: 0 });
    expect(await db.device.findMany()).toEqual([expect.objectContaining({ id: pc.id, mac: MAC, ip: pc.ip })]);
    expect(await db.deviceEvent.count()).toBe(0);
  });

  it("aprende o MAC de um cadastro sem MAC antes de acompanhar sua troca de IP", async () => {
    const pc = await device({ mac: null });
    expect(await scan([host({ ip: pc.ip, hostname: "4600G" })])).toEqual({ devicesFound: 1, newDevices: 0 });
    expect(await scan([host()])).toEqual({ devicesFound: 1, newDevices: 0 });
    expect(await db.device.findMany()).toEqual([expect.objectContaining({
      id: pc.id, mac: MAC, ip: "192.168.0.166", hostname: "4600G", alias: pc.alias,
    })]);
  });

  it("preenche hostname ausente uma única vez sem mudar o apelido", async () => {
    const pc = await device({ hostname: null });
    await scan([host({ hostname: "4600G" })]);
    await scan([host()]);
    expect(await db.device.findUniqueOrThrow({ where: { id: pc.id } }))
      .toMatchObject({ hostname: "4600G", alias: pc.alias });
    expect(await db.deviceEvent.findMany({ where: { type: "HOSTNAME_CHANGED" } }))
      .toEqual([expect.objectContaining({ previousValue: null, newValue: "4600G" })]);
  });

  it("um MAC diferente no IP antigo cria outro aparelho e não herda o nome/apelido", async () => {
    const pc = await device();
    expect(await scan([host({ ip: pc.ip, mac: OTHER_MAC, hostname: "IMPRESSORA", type: "PRINTER" })]))
      .toEqual({ devicesFound: 1, newDevices: 1 });
    expect(await db.device.findUniqueOrThrow({ where: { id: pc.id } }))
      .toMatchObject({ mac: MAC, hostname: "4600G", alias: pc.alias, status: "OFFLINE" });
    expect(await db.device.findUniqueOrThrow({ where: { mac: OTHER_MAC } }))
      .toMatchObject({ ip: pc.ip, hostname: "IMPRESSORA", alias: null, status: "ONLINE" });
  });

  it("prioriza os MACs quando dois aparelhos trocam de IP entre si", async () => {
    const pc = await device();
    const other = await device({ ip: "192.168.0.166", mac: OTHER_MAC, hostname: "Servidor", alias: "NAS" });
    expect(await scan([host({ ip: pc.ip, mac: OTHER_MAC }), host({ ip: other.ip, mac: MAC })]))
      .toEqual({ devicesFound: 2, newDevices: 0 });
    expect(await db.device.findUniqueOrThrow({ where: { id: pc.id } }))
      .toMatchObject({ ip: other.ip, mac: MAC, hostname: pc.hostname, alias: pc.alias });
    expect(await db.device.findUniqueOrThrow({ where: { id: other.id } }))
      .toMatchObject({ ip: pc.ip, mac: OTHER_MAC, hostname: other.hostname, alias: other.alias });
  });

  it("não associa IPs diferentes só pelo hostname quando o scan não obtém MAC", async () => {
    const pc = await device();
    expect(await scan([host({ mac: null, hostname: "4600G" })])).toEqual({ devicesFound: 1, newDevices: 1 });
    expect(await db.device.count()).toBe(2);
    expect(await db.device.findUniqueOrThrow({ where: { id: pc.id } }))
      .toMatchObject({ ip: pc.ip, mac: MAC, hostname: pc.hostname, alias: pc.alias });
  });

  it("uma falha temporária de ARP no mesmo IP não apaga o MAC já aprendido", async () => {
    const pc = await device();
    expect(await scan([host({ ip: pc.ip, mac: null, hostname: "4600G" })]))
      .toEqual({ devicesFound: 1, newDevices: 0 });
    expect(await db.device.findUniqueOrThrow({ where: { id: pc.id } }))
      .toMatchObject({ mac: MAC, hostname: pc.hostname, alias: pc.alias, status: "ONLINE" });
    expect(await db.deviceEvent.count()).toBe(0);
  });

  it("funde duplicados legados pelo MAC preservando histórico e ligações", async () => {
    const uplink = await device({ ip: "192.168.0.1", mac: OTHER_MAC, hostname: "Switch", alias: null });
    const original = await device({ mac: "9c-b6-54-a6-f8-80" });
    const duplicate = await device({
      ip: "192.168.0.166", alias: "Duplicado", hostname: "gateway.docker.internal",
      firstSeenAt: new Date("2026-10-10T12:00:00Z"), lastSeenAt: new Date("2026-10-10T12:00:00Z"),
    });
    const event = await db.deviceEvent.create({ data: {
      deviceId: duplicate.id, type: "IP_CHANGED", message: "Histórico do duplicado",
    } });
    const link = await db.topologyLink.create({ data: { fromDeviceId: uplink.id, toDeviceId: duplicate.id } });
    await db.mapPosition.create({ data: { nodeId: duplicate.id, x: 120, y: 40 } });

    expect(await scan([host(), host({ ip: uplink.ip, mac: OTHER_MAC, hostname: "Switch" })]))
      .toEqual({ devicesFound: 2, newDevices: 0 });
    expect(await db.device.findUnique({ where: { id: duplicate.id } })).toBeNull();
    expect(await db.device.findUniqueOrThrow({ where: { id: original.id } }))
      .toMatchObject({ mac: MAC, ip: duplicate.ip, hostname: original.hostname, alias: original.alias, firstSeenAt });
    expect(await db.deviceEvent.findUniqueOrThrow({ where: { id: event.id } }))
      .toMatchObject({ deviceId: original.id });
    expect(await db.topologyLink.findUniqueOrThrow({ where: { id: link.id } }))
      .toMatchObject({ toDeviceId: original.id });
    expect(await db.mapPosition.findUniqueOrThrow({ where: { nodeId: original.id } }))
      .toMatchObject({ x: 120, y: 40 });
    expect(await db.mapPosition.findUnique({ where: { nodeId: duplicate.id } })).toBeNull();
    expect(await db.device.count()).toBe(2);
  });

  it("mantém os IPs ignorados fora da descoberta e dos eventos", async () => {
    const pc = await device();
    await db.appSetting.create({ data: {
      key: "network.ignoredIps", value: JSON.stringify([{ id: "test", pattern: "192.168.0.*" }]),
    } });
    expect(await scan([host()])).toEqual({ devicesFound: 0, newDevices: 0 });
    expect(await db.device.findUniqueOrThrow({ where: { id: pc.id } }))
      .toMatchObject({ ip: pc.ip, lastSeenAt: firstSeenAt, status: "ONLINE" });
    expect(await db.deviceEvent.count()).toBe(0);
  });
});
