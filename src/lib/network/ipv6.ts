import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listHostsInCidr } from "./subnet";
import { isWindows, runIpJson, runPowerShellJson } from "./tools/shell";

const execFileAsync = promisify(execFile);

interface LanInterface {
  name: string;
  scopeId: number;
  globalAddress: string | null;
}

function isGlobalUnicast(addr: string): boolean {
  return /^[23]/.test(addr); // 2000::/3
}

/** Interfaces locais que estão na faixa escaneada e têm IPv6 (ignora WSL, Hyper-V, VPN...). */
function lanInterfaces(cidr: string): LanInterface[] {
  const inRange = new Set(listHostsInCidr(cidr));
  const result: LanInterface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!addrs?.some((a) => a.family === "IPv4" && inRange.has(a.address))) continue;
    const v6 = addrs.filter((a) => a.family === "IPv6" && !a.internal);
    const linkLocal = v6.find((a) => a.address.startsWith("fe80:"));
    if (!linkLocal?.scopeid) continue;
    result.push({ name, scopeId: linkLocal.scopeid, globalAddress: v6.find((a) => isGlobalUnicast(a.address))?.address ?? null });
  }
  return result;
}

/**
 * Ping para ff02::1 (todos os nós do enlace): quem responde fica na tabela de vizinhos (NDP).
 * Com origem link-local os vizinhos aprendidos são fe80::; com origem global, eles respondem
 * do endereço global — por isso enviamos das duas formas. O ping do Windows relata "tempo
 * esgotado" (não associa respostas de multicast), mas a tabela de vizinhos é preenchida igual.
 */
async function solicitAllNodes(iface: LanInterface): Promise<void> {
  const target = `ff02::1%${isWindows ? iface.scopeId : iface.name}`;
  const base = isWindows ? ["-6", "-n", "1", "-w", "1000"] : ["-6", "-c", "1", "-W", "1"];
  const sources: (string | null)[] = [null, iface.globalAddress].filter((s, i) => i === 0 || s);
  await Promise.all(
    sources.map((src) =>
      execFileAsync("ping", [...base, ...(src ? [isWindows ? "-S" : "-I", src] : []), target], { timeout: 3000 }).catch(() => {}),
    ),
  );
}

function normalizeMac(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const mac = raw.replace(/-/g, ":").toUpperCase();
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return null;
  // Multicast (33:33:..., bit I/G) e MAC nulo não são dispositivos.
  if (parseInt(mac.slice(0, 2), 16) & 1 || mac === "00:00:00:00:00:00") return null;
  return mac;
}

/** Ordem de exibição: global primeiro, depois ULA (fc00::/7), por último link-local. */
function addressRank(addr: string): number {
  if (isGlobalUnicast(addr)) return 0;
  if (/^f[cd]/i.test(addr)) return 1;
  return 2;
}

async function readNeighbors(ifaces: LanInterface[]): Promise<{ ip: string; mac: string | null }[]> {
  if (isWindows) {
    const indexes = ifaces.map((i) => i.scopeId).join(",");
    const rows = await runPowerShellJson<{ IPAddress: string; LinkLayerAddress: string; State: string }>(
      `Get-NetNeighbor -AddressFamily IPv6 -InterfaceIndex ${indexes} | Where-Object { "$($_.State)" -notin 'Unreachable','Incomplete' } | Select-Object IPAddress,LinkLayerAddress,@{n='State';e={"$($_.State)"}}`,
    );
    return rows.map((r) => ({ ip: r.IPAddress, mac: normalizeMac(r.LinkLayerAddress) }));
  }
  const rows = await runIpJson<{ dst: string; lladdr?: string; dev: string; state?: string[] }>(["-6", "neigh"]);
  const names = new Set(ifaces.map((i) => i.name));
  return rows
    .filter((r) => names.has(r.dev) && !r.state?.some((s) => s === "FAILED" || s === "INCOMPLETE"))
    .map((r) => ({ ip: r.dst, mac: normalizeMac(r.lladdr) }));
}

/**
 * Descobre os endereços IPv6 dos dispositivos da LAN, agrupados por MAC. Só aparecem os que
 * respondem a ping multicast (roteadores, Android, Linux, a maioria dos IoT com IPv6); o
 * Windows ignora esse ping por padrão, então PCs Windows costumam ficar sem IPv6 aqui.
 */
export async function discoverIpv6(cidr: string): Promise<Map<string, string[]>> {
  const byMac = new Map<string, Set<string>>();
  const add = (mac: string, ip: string) => byMac.set(mac, (byMac.get(mac) ?? new Set()).add(ip.replace(/%.*$/, "")));

  try {
    const ifaces = lanInterfaces(cidr);
    if (!ifaces.length) return new Map();

    await Promise.all(ifaces.map(solicitAllNodes));
    for (const n of await readNeighbors(ifaces)) if (n.mac) add(n.mac, n.ip);

    // A própria máquina não aparece na tabela de vizinhos: usa os endereços das interfaces locais.
    for (const iface of ifaces) {
      for (const a of os.networkInterfaces()[iface.name] ?? []) {
        const mac = normalizeMac(a.mac);
        if (a.family === "IPv6" && mac) add(mac, a.address);
      }
    }
  } catch {
    // IPv6 é complementar: se a descoberta falhar, o scan segue só com IPv4.
  }

  return new Map(
    Array.from(byMac, ([mac, set]) => [mac, Array.from(set).sort((a, b) => addressRank(a) - addressRank(b) || a.localeCompare(b))]),
  );
}
