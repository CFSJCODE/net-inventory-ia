import os from "node:os";
import { isWindows, runPowerShellJson } from "./shell";

export interface DhcpLease {
  adapter: string;
  mac: string | null;
  ipAddresses: string[];
  gateways: string[];
  dnsServers: string[];
  dhcpEnabled: boolean;
  dhcpServer: string | null;
  leaseObtained: string | null;
  leaseExpires: string | null;
}

/**
 * Consulta as concessões DHCP das interfaces locais: qual servidor entregou o IP, quando a
 * concessão foi obtida e quando expira. No Windows vem do WMI/CIM; no Linux não há uma fonte
 * padrão (depende do cliente DHCP), então mostramos apenas os endereços das interfaces.
 */
export async function readDhcpLeases(): Promise<DhcpLease[]> {
  if (isWindows) {
    const rows = await runPowerShellJson<{
      Description: string;
      MACAddress: string | null;
      IPAddress: string[] | null;
      DefaultIPGateway: string[] | null;
      DNSServerSearchOrder: string[] | null;
      DHCPEnabled: boolean;
      DHCPServer: string | null;
      LeaseObtained: string | null;
      LeaseExpires: string | null;
    }>(
      `Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=true' | Select-Object Description,MACAddress,IPAddress,DefaultIPGateway,DNSServerSearchOrder,DHCPEnabled,DHCPServer,` +
        `@{n='LeaseObtained';e={if($_.DHCPLeaseObtained){$_.DHCPLeaseObtained.ToString('o')}else{$null}}},` +
        `@{n='LeaseExpires';e={if($_.DHCPLeaseExpires){$_.DHCPLeaseExpires.ToString('o')}else{$null}}}`,
    );
    return rows.map((r) => ({
      adapter: r.Description,
      mac: r.MACAddress,
      ipAddresses: (r.IPAddress ?? []).filter((ip) => ip.includes(".")),
      gateways: r.DefaultIPGateway ?? [],
      dnsServers: r.DNSServerSearchOrder ?? [],
      dhcpEnabled: r.DHCPEnabled,
      dhcpServer: r.DHCPServer,
      leaseObtained: r.LeaseObtained,
      leaseExpires: r.LeaseExpires,
    }));
  }

  return Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) => {
    const ipv4 = (addrs ?? []).filter((a) => a.family === "IPv4" && !a.internal);
    if (!ipv4.length) return [];
    return [
      {
        adapter: name,
        mac: ipv4[0].mac.toUpperCase(),
        ipAddresses: ipv4.map((a) => a.address),
        gateways: [],
        dnsServers: [],
        dhcpEnabled: false,
        dhcpServer: null,
        leaseObtained: null,
        leaseExpires: null,
      },
    ];
  });
}
