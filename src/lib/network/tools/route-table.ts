import { isWindows, runIpJson, runPowerShellJson } from "./shell";

export interface RouteEntry {
  destination: string;
  nextHop: string;
  interface: string;
  metric: number | null;
  /**
   * Métrica da interface (só no Windows). O Windows escolhe a rota pela soma desta com a da rota: duas
   * rotas padrão por DHCP têm ambas métrica 0, e o que as desempata é a interface (cabo antes do Wi-Fi).
   */
  interfaceMetric?: number | null;
  protocol: string;
}

/** Uma linha do Get-NetRoute como o PowerShell a devolve. */
export interface WindowsRouteRow {
  DestinationPrefix: string;
  NextHop: string;
  InterfaceAlias: string;
  RouteMetric: number;
  InterfaceMetric?: number | null;
  Protocol: string;
}

export function fromWindowsRoute(row: WindowsRouteRow): RouteEntry {
  return {
    destination: row.DestinationPrefix,
    nextHop: row.NextHop,
    interface: row.InterfaceAlias,
    metric: row.RouteMetric,
    interfaceMetric: typeof row.InterfaceMetric === "number" ? row.InterfaceMetric : null,
    protocol: row.Protocol,
  };
}

/** Lê a tabela de roteamento IPv4 do sistema operacional. */
export async function readRouteTable(): Promise<RouteEntry[]> {
  if (isWindows) {
    const rows = await runPowerShellJson<WindowsRouteRow>(
      `Get-NetRoute -AddressFamily IPv4 | Sort-Object DestinationPrefix | Select-Object DestinationPrefix,NextHop,InterfaceAlias,RouteMetric,InterfaceMetric,@{n='Protocol';e={"$($_.Protocol)"}}`,
    );
    return rows.map(fromWindowsRoute);
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
