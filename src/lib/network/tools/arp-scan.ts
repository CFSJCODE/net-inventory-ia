import dgram from "node:dgram";
import os from "node:os";
import { listHostsInCidr } from "../subnet";
import { resolveVendors } from "../vendor-lookup";
import { isUnicastMac, readArpTable } from "./arp-table";

export interface ArpScanHost {
  ip: string;
  mac: string;
  vendor: string | null;
  state: string;
}

// Estados que indicam que o vizinho respondeu ao ARP agora (ou é permanente/a própria máquina).
// "Stale" fica de fora: é uma entrada antiga no cache, o dispositivo pode já ter saído da rede.
const RESPONDED_STATES = new Set(["reachable", "permanent", "delay", "probe", "local"]);

const SETTLE_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Força o SO a fazer ARP para cada IP: para enviar um datagrama UDP, o sistema precisa antes
 * descobrir o MAC do destino. A porta 9 (discard) é descartada pelo host, mas a resolução ARP
 * acontece de qualquer forma — por isso encontra até dispositivos que bloqueiam ping (ICMP).
 */
async function triggerArpRequests(ips: string[]): Promise<void> {
  const socket = dgram.createSocket("udp4");
  socket.on("error", () => {});
  const payload = Buffer.alloc(1);

  for (let i = 0; i < ips.length; i++) {
    socket.send(payload, 9, ips[i], () => {});
    // Pequenos lotes evitam estourar a fila de resoluções ARP pendentes do SO.
    if (i % 32 === 31) await delay(30);
  }

  await delay(SETTLE_MS);
  socket.close();
}

function localIpToMac(): Map<string, string> {
  const map = new Map<string, string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) map.set(a.address, a.mac.toUpperCase());
    }
  }
  return map;
}

/** ARP Scan: descobre rapidamente os dispositivos ativos da faixa via resolução ARP. */
export async function arpScan(cidr: string): Promise<ArpScanHost[]> {
  const candidates = listHostsInCidr(cidr);
  const candidateSet = new Set(candidates);

  await triggerArpRequests(candidates);
  const table = await readArpTable();

  const found = new Map<string, { mac: string; state: string }>();
  for (const entry of table) {
    if (!candidateSet.has(entry.ip) || !entry.mac || !isUnicastMac(entry.mac)) continue;
    if (!RESPONDED_STATES.has(entry.state.toLowerCase())) continue;
    found.set(entry.ip, { mac: entry.mac, state: entry.state });
  }
  for (const [ip, mac] of localIpToMac()) {
    if (candidateSet.has(ip)) found.set(ip, { mac, state: "Local" });
  }

  const vendors = await resolveVendors(Array.from(new Set(Array.from(found.values(), (f) => f.mac))));

  return candidates
    .filter((ip) => found.has(ip))
    .map((ip) => {
      const { mac, state } = found.get(ip)!;
      return { ip, mac, state, vendor: vendors.get(mac) ?? null };
    });
}
