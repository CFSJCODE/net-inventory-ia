import { isWindows, runIpJson, runPowerShellJson } from "./shell";

export interface ArpEntry {
  ip: string;
  mac: string | null;
  state: string;
  interface: string;
}

/** MACs de broadcast/multicast (bit I/G do primeiro octeto) não representam dispositivos reais. */
export function isUnicastMac(mac: string): boolean {
  const firstByte = parseInt(mac.slice(0, 2), 16);
  return !Number.isNaN(firstByte) && (firstByte & 1) === 0 && mac !== "00:00:00:00:00:00";
}

function normalizeMac(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const mac = raw.replace(/-/g, ":").toUpperCase();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ? mac : null;
}

/** Lê a tabela ARP (vizinhos IPv4) do sistema operacional, com estado e interface de cada entrada. */
export async function readArpTable(): Promise<ArpEntry[]> {
  if (isWindows) {
    const rows = await runPowerShellJson<{ IPAddress: string; LinkLayerAddress: string; State: string; InterfaceAlias: string }>(
      `Get-NetNeighbor -AddressFamily IPv4 | Select-Object IPAddress,LinkLayerAddress,@{n='State';e={"$($_.State)"}},InterfaceAlias`,
    );
    return rows.map((r) => ({ ip: r.IPAddress, mac: normalizeMac(r.LinkLayerAddress), state: r.State, interface: r.InterfaceAlias }));
  }

  const rows = await runIpJson<{ dst: string; lladdr?: string; state?: string[]; dev: string }>(["-4", "neigh"]);
  return rows.map((r) => ({
    ip: r.dst,
    mac: normalizeMac(r.lladdr),
    state: r.state?.[0] ?? "UNKNOWN",
    interface: r.dev,
  }));
}
