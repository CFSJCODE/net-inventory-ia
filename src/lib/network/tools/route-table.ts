import { isWindows, runIpJson, runPowerShellJson } from "./shell";

export interface RouteEntry {
  destination: string;
  nextHop: string;
  interface: string;
  metric: number | null;
  protocol: string;
}

/** Lê a tabela de roteamento IPv4 do sistema operacional. */
export async function readRouteTable(): Promise<RouteEntry[]> {
  if (isWindows) {
    const rows = await runPowerShellJson<{
      DestinationPrefix: string;
      NextHop: string;
      InterfaceAlias: string;
      RouteMetric: number;
      Protocol: string;
    }>(
      `Get-NetRoute -AddressFamily IPv4 | Sort-Object DestinationPrefix | Select-Object DestinationPrefix,NextHop,InterfaceAlias,RouteMetric,@{n='Protocol';e={"$($_.Protocol)"}}`,
    );
    return rows.map((r) => ({
      destination: r.DestinationPrefix,
      nextHop: r.NextHop,
      interface: r.InterfaceAlias,
      metric: r.RouteMetric,
      protocol: r.Protocol,
    }));
  }

  const rows = await runIpJson<{ dst: string; gateway?: string; dev: string; metric?: number; protocol?: string }>(["-4", "route"]);
  return rows.map((r) => ({
    destination: r.dst === "default" ? "0.0.0.0/0" : r.dst,
    nextHop: r.gateway ?? "0.0.0.0",
    interface: r.dev,
    metric: r.metric ?? null,
    protocol: r.protocol ?? "—",
  }));
}
