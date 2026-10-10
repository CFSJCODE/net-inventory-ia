import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pingSweep: vi.fn(),
  tcpSweep: vi.fn(),
  getArpTable: vi.fn(),
}));

vi.mock("./ping", () => ({ pingSweep: mocks.pingSweep }));
vi.mock("./tcp-probe", () => ({ tcpSweep: mocks.tcpSweep }));
vi.mock("./arp", () => ({ getArpTable: mocks.getArpTable }));
vi.mock("./dns", () => ({
  createGatewayResolver: vi.fn(),
  resolveHostname: vi.fn(async (ip: string) => (ip === "192.168.0.82" ? "HP-Z230" : null)),
}));
vi.mock("./port-scan", () => ({
  scanCommonPorts: vi.fn(async (ip: string) => (ip === "192.168.0.82" ? [3389] : [])),
}));
vi.mock("./vendor-lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vendor-lookup")>()),
  resolveVendors: vi.fn(async () => new Map()),
}));
vi.mock("./ipv6", () => ({ discoverIpv6: vi.fn(async () => new Map()) }));
vi.mock("./mdns", () => ({ discoverMdnsAndSsdp: vi.fn(async () => new Map()) }));

import { scanNetwork } from "./scanner";

describe("scanNetwork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("encontra um Windows que bloqueia ping mas responde em TCP (RDP)", async () => {
    mocks.pingSweep.mockResolvedValue(["192.168.0.1"]);
    mocks.getArpTable.mockResolvedValue(
      new Map([
        ["192.168.0.1", "CC:75:E2:D8:28:AF"],
        ["192.168.0.82", "9C:B6:54:A6:F8:80"],
      ]),
    );
    mocks.tcpSweep.mockResolvedValue(["192.168.0.82"]);

    const hosts = await scanNetwork("192.168.0.0/24");
    const z230 = hosts.find((h) => h.ip === "192.168.0.82");

    expect(z230).toMatchObject({
      mac: "9C:B6:54:A6:F8:80",
      hostname: "HP-Z230",
      openPorts: [3389],
      type: "COMPUTER",
    });
  });

  it("só sonda via TCP os IPs que não responderam ao ping", async () => {
    mocks.pingSweep.mockResolvedValue(["192.168.0.1"]);
    mocks.getArpTable.mockResolvedValue(new Map());
    mocks.tcpSweep.mockResolvedValue([]);

    const hosts = await scanNetwork("192.168.0.0/30");

    expect(mocks.tcpSweep).toHaveBeenCalledWith(["192.168.0.2"]);
    expect(hosts.map((h) => h.ip)).toEqual(["192.168.0.1"]);
  });
});
