"use client";

import { runDhcpQuery } from "@/app/actions/tool-actions";
import { formatDateTime } from "@/lib/format-time";
import { ResultTable, RunButton, ToolCard, ToolError, ToolForm, ToolSummary, useTool } from "./tool-shell";

function formatLeaseDate(iso: string | null): string {
  return iso ? formatDateTime(new Date(iso)) : "—";
}

export function DhcpTool() {
  const { run, data, error, isPending } = useTool(runDhcpQuery);

  return (
    <ToolCard
      title="Consulta DHCP"
      description="Mostra as concessões DHCP desta máquina: qual servidor entregou o IP, gateway, DNS e validade da concessão."
    >
      <ToolForm onSubmit={() => run()}>
        <RunButton isPending={isPending} label="Consultar" pendingLabel="Consultando..." />
      </ToolForm>
      <ToolError error={error} />
      {data && (
        <>
          <ToolSummary>
            {data.filter((l) => l.dhcpEnabled).length} de {data.length} adaptador(es) ativo(s) usam DHCP.
          </ToolSummary>
          <ResultTable
            columns={["Adaptador", "IP", "Servidor DHCP", "Gateway", "DNS", "Obtida em", "Expira em"]}
            rows={data.map((l) => [
              <span key="a">
                {l.adapter}
                {l.mac && <span className="block font-mono text-xs text-muted-foreground">{l.mac}</span>}
              </span>,
              l.ipAddresses.join(", ") || "—",
              l.dhcpEnabled ? l.dhcpServer ?? "—" : "IP fixo",
              l.gateways.filter((g) => g.includes(".")).join(", ") || "—",
              l.dnsServers.join(", ") || "—",
              formatLeaseDate(l.leaseObtained),
              formatLeaseDate(l.leaseExpires),
            ])}
            mono={[1, 2, 3, 4]}
          />
        </>
      )}
    </ToolCard>
  );
}
