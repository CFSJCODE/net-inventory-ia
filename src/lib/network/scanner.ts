import { listHostsInCidr } from "./subnet";
import { pingSweep } from "./ping";
import { getArpTable } from "./arp";
import { createGatewayResolver, resolveHostname } from "./dns";
import { scanCommonPorts } from "./port-scan";
import { resolveVendors } from "./vendor-lookup";
import { classifyDevice } from "./classify";
import { mapWithConcurrency } from "./concurrency";
import { discoverIpv6 } from "./ipv6";
import { discoverMdnsAndSsdp, type MdnsDeviceHint } from "./mdns";
import type { DiscoveredHost } from "./types";

/** Descobre dispositivos ativos em uma faixa de IP (CIDR). */
export async function scanNetwork(cidr: string): Promise<DiscoveredHost[]> {
  const candidateIps = listHostsInCidr(cidr);
  const candidateSet = new Set(candidateIps);

  // Inicia descoberta mDNS/SSDP em paralelo com o ping sweep para aproveitar o tempo de rede
  const mdnsPromise = discoverMdnsAndSsdp(1800).catch(() => new Map<string, MdnsDeviceHint>());

  const firstPass = await pingSweep(candidateIps);
  const arpTable = await getArpTable();
  // Roteadores limitam a taxa de respostas ICMP e podem ignorar o ping durante a rajada do sweep.
  // Quem não respondeu mas está na tabela ARP (respondeu ao ARP) ganha uma segunda chance, com calma.
  const answered = new Set(firstPass);
  const retry = await pingSweep(
    candidateIps.filter((ip) => !answered.has(ip) && arpTable.has(ip)),
    { concurrency: 4, timeoutMs: 1500 },
  );

  const mdnsByIp = await mdnsPromise;

  // Inclui hosts que responderam via Ping, ARP ou diretamente via mDNS/SSDP multicast na mesma sub-rede
  const mdnsAliveIps = Array.from(mdnsByIp.keys()).filter((ip) => candidateSet.has(ip));
  const aliveIps = Array.from(new Set([...firstPass, ...retry, ...mdnsAliveIps]));

  const macsFound = Array.from(
    new Set(aliveIps.map((ip) => arpTable.get(ip)).filter((mac): mac is string => !!mac)),
  );
  const [vendorByMac, ipv6ByMac] = await Promise.all([resolveVendors(macsFound), discoverIpv6(cidr)]);
  // Convenção de redes domésticas/pequenas: o gateway é o primeiro host da faixa (ex: .1).
  const gatewayResolver = candidateIps[0] ? createGatewayResolver(candidateIps[0]) : undefined;

  const hosts = await mapWithConcurrency(aliveIps, 12, async (ip): Promise<DiscoveredHost> => {
    const mac = arpTable.get(ip) ?? null;
    const [dnsHostname, openPorts] = await Promise.all([resolveHostname(ip, gatewayResolver), scanCommonPorts(ip)]);
    const vendor = mac ? vendorByMac.get(mac) ?? null : null;

    const mdnsHint = mdnsByIp.get(ip);
    // Prioriza hostname DNS/NetBIOS; se nulo, usa o hostname legível descoberto por mDNS/SSDP
    const hostname = dnsHostname ?? mdnsHint?.hostname ?? null;

    let type = classifyDevice({ ip, hostname, vendor, openPorts });
    // Se a classificação clássica deu UNKNOWN ou se mDNS trouxe certeza sobre impressora/streaming
    if (mdnsHint?.suggestedType) {
      if (type === "UNKNOWN" || (mdnsHint.suggestedType === "PRINTER" && type !== "PRINTER")) {
        type = mdnsHint.suggestedType;
      }
    }

    return { ip, mac, ipv6: mac ? ipv6ByMac.get(mac) ?? [] : [], hostname, vendor, openPorts, type };
  });

  return hosts;
}
