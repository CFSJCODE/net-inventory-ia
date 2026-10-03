import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);

function normalizeMac(raw: string): string {
  return raw.replace(/-/g, ":").toUpperCase();
}

/**
 * O SO nunca faz ARP para si mesmo, então os próprios IPs da máquina que está
 * escaneando não aparecem em `arp -a`. Preenchemos esses MACs a partir das
 * interfaces de rede locais para que o próprio host também tenha fabricante.
 */
function getLocalInterfaceMacs(): Map<string, string> {
  const table = new Map<string, string>();

  for (const addrs of Object.values(os.networkInterfaces())) {
    if (!addrs) continue;
    const mac = addrs.find((a) => a.mac && a.mac !== "00:00:00:00:00:00")?.mac;
    if (!mac) continue;

    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        table.set(addr.address, normalizeMac(mac));
      }
    }
  }

  return table;
}

/** Lê a tabela ARP do sistema operacional e retorna um mapa IP -> MAC. */
export async function getArpTable(): Promise<Map<string, string>> {
  const isWindows = process.platform === "win32";
  const table = new Map<string, string>();

  try {
    const { stdout } = await execFileAsync(isWindows ? "arp" : "arp", [isWindows ? "-a" : "-an"]);
    const macRegex = /([0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5})/;
    const ipRegex = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

    for (const line of stdout.split("\n")) {
      const macMatch = line.match(macRegex);
      const ipMatch = line.match(ipRegex);
      if (macMatch && ipMatch) {
        table.set(ipMatch[1], normalizeMac(macMatch[1]));
      }
    }
  } catch {
    // Sem tabela ARP disponível (ex: sem permissão ou comando ausente) — segue sem MACs.
  }

  for (const [ip, mac] of getLocalInterfaceMacs()) {
    if (!table.has(ip)) table.set(ip, mac);
  }

  return table;
}
