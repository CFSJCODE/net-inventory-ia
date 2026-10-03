import dns from "node:dns/promises";
import net from "node:net";
import { isWindows, runPowerShellJson } from "./tools/shell";

let systemServersCache: { servers: string[]; at: number } | null = null;

/**
 * No Windows o Node (c-ares) pode ler um DNS diferente do que o sistema realmente usa (ex:
 * 127.0.0.1 herdado de adaptadores virtuais), então buscamos os servidores direto dos adaptadores.
 */
export async function getSystemDnsServers(): Promise<string[]> {
  if (!isWindows) return [];
  if (systemServersCache && Date.now() - systemServersCache.at < 60_000) return systemServersCache.servers;
  try {
    const servers = await runPowerShellJson<string>(
      `Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses -and $_.InterfaceAlias -notmatch 'vEthernet|Loopback' } | Select-Object -ExpandProperty ServerAddresses -Unique`,
    );
    const usable = servers.filter((s) => net.isIPv4(s) && !s.startsWith("127."));
    systemServersCache = { servers: usable, at: Date.now() };
    return usable;
  } catch {
    return [];
  }
}

/** Resolver DNS com os servidores reais do sistema (ou o padrão do Node, fora do Windows). */
export async function createSystemResolver(): Promise<dns.Resolver> {
  const resolver = new dns.Resolver({ timeout: 1500, tries: 1 });
  const servers = await getSystemDnsServers();
  if (servers.length) resolver.setServers(servers);
  return resolver;
}
