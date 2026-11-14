import { beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ isWindows: true, runIpJson: vi.fn(), runPowerShellJson: vi.fn() }));

vi.mock("./shell", () => shell);

import { fromWindowsRoute, readRouteTable } from "./route-table";

beforeEach(() => {
  shell.isWindows = true;
  shell.runIpJson.mockReset();
  shell.runPowerShellJson.mockReset();
});

describe("fromWindowsRoute", () => {
  it("leva a métrica da rota e a da interface, cada uma no seu campo", () => {
    expect(fromWindowsRoute({ DestinationPrefix: "0.0.0.0/0", NextHop: "192.168.0.1", InterfaceAlias: "Ethernet", RouteMetric: 0, InterfaceMetric: 25, Protocol: "NetMgmt" })).toEqual({
      destination: "0.0.0.0/0",
      nextHop: "192.168.0.1",
      interface: "Ethernet",
      metric: 0,
      interfaceMetric: 25,
      protocol: "NetMgmt",
    });
  });

  it("sem a métrica da interface (ou com um valor que não é número) o campo fica nulo", () => {
    const row = { DestinationPrefix: "10.0.0.0/8", NextHop: "0.0.0.0", InterfaceAlias: "Wi-Fi", RouteMetric: 256, Protocol: "Local" };
    expect(fromWindowsRoute(row).interfaceMetric).toBeNull();
    expect(fromWindowsRoute({ ...row, InterfaceMetric: null }).interfaceMetric).toBeNull();
    expect(fromWindowsRoute({ ...row, InterfaceMetric: "25" as never }).interfaceMetric).toBeNull();
  });
});

describe("readRouteTable", () => {
  it("Windows: pede a métrica da interface ao Get-NetRoute e a devolve em cada rota", async () => {
    shell.runPowerShellJson.mockResolvedValue([
      { DestinationPrefix: "0.0.0.0/0", NextHop: "192.168.1.1", InterfaceAlias: "Wi-Fi", RouteMetric: 0, InterfaceMetric: 50, Protocol: "NetMgmt" },
      { DestinationPrefix: "0.0.0.0/0", NextHop: "192.168.0.1", InterfaceAlias: "Ethernet", RouteMetric: 0, InterfaceMetric: 25, Protocol: "NetMgmt" },
    ]);
    const routes = await readRouteTable();
    expect(shell.runPowerShellJson).toHaveBeenCalledTimes(1);
    expect(shell.runPowerShellJson.mock.calls[0][0]).toMatch(/Select-Object [^|]*\bRouteMetric,InterfaceMetric\b/);
    expect(routes.map((route) => [route.nextHop, route.metric, route.interfaceMetric])).toEqual([
      ["192.168.1.1", 0, 50],
      ["192.168.0.1", 0, 25],
    ]);
    expect(shell.runIpJson).not.toHaveBeenCalled();
  });

  it("Linux: lê o `ip -4 route`, sem métrica de interface", async () => {
    shell.isWindows = false;
    shell.runIpJson.mockResolvedValue([
      { dst: "default", gateway: "192.168.0.1", dev: "eth0", metric: 100, protocol: "dhcp" },
      { dst: "192.168.0.0/24", dev: "eth0" },
    ]);
    expect(await readRouteTable()).toEqual([
      { destination: "0.0.0.0/0", nextHop: "192.168.0.1", interface: "eth0", metric: 100, protocol: "dhcp" },
      { destination: "192.168.0.0/24", nextHop: "0.0.0.0", interface: "eth0", metric: null, protocol: "—" },
    ]);
    expect(shell.runIpJson).toHaveBeenCalledWith(["-4", "route"]);
    expect(shell.runPowerShellJson).not.toHaveBeenCalled();
  });
});
