import { redirect } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getCurrentUser } from "@/lib/auth/server";
import { can } from "@/lib/auth/permissions";
import { NoPermission } from "@/components/no-permission";
import { ArpScanTool } from "@/components/tools/arp-scan-tool";
import { PortScanTool } from "@/components/tools/port-scan-tool";
import { SnmpTool } from "@/components/tools/snmp-tool";
import { WakeOnLanTool } from "@/components/tools/wol-tool";
import { DhcpTool } from "@/components/tools/dhcp-tool";
import { DnsTool } from "@/components/tools/dns-tool";
import { ArpTableTool } from "@/components/tools/arp-table-tool";
import { RouteTableTool } from "@/components/tools/route-table-tool";
import { NetworkSecurityTool } from "@/components/ai/network-security-tool";

const TOOLS = [
  { value: "arp-scan", label: "ARP Scan", Component: ArpScanTool },
  { value: "port-scan", label: "Port Scan", Component: PortScanTool },
  { value: "snmp", label: "SNMP", Component: SnmpTool },
  { value: "wol", label: "Wake-on-LAN", Component: WakeOnLanTool },
  { value: "dhcp", label: "DHCP", Component: DhcpTool },
  { value: "dns", label: "DNS", Component: DnsTool },
  { value: "arp-table", label: "Tabela ARP", Component: ArpTableTool },
  { value: "routes", label: "Roteamento", Component: RouteTableTool },
  { value: "security", label: "Segurança", Component: NetworkSecurityTool },
] as const;

export default async function ToolsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // Sem "network.operate", só a aba Segurança: ela lê o inventário, não dispara nada na rede.
  const canOperate = can(user.role, "network.operate");
  const tools = canOperate ? TOOLS : TOOLS.filter((t) => t.value === "security");

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-3 py-8">
      <div>
        <p className="text-sm text-muted-foreground">Diagnóstico e descoberta executados a partir desta máquina.</p>
      </div>

      {!canOperate && <NoPermission role={user.role} what="executar as ferramentas de rede (scans, consultas e Wake-on-LAN)" />}

      <Tabs defaultValue={tools[0].value}>
        <TabsList className="h-auto flex-wrap">
          {tools.map(({ value, label }) => (
            <TabsTrigger key={value} value={value} className="flex-none px-3">
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {tools.map(({ value, Component }) => (
          <TabsContent key={value} value={value} keepMounted>
            <Component />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
