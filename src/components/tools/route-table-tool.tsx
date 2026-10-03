"use client";

import { runRouteTableQuery } from "@/app/actions/tool-actions";
import { Badge } from "@/components/ui/badge";
import { ResultTable, RunButton, ToolCard, ToolError, ToolForm, ToolSummary, useTool } from "./tool-shell";

export function RouteTableTool() {
  const { run, data, error, isPending } = useTool(runRouteTableQuery);
  const defaultRoutes = data?.filter((r) => r.destination === "0.0.0.0/0") ?? [];

  return (
    <ToolCard
      title="Tabela de Roteamento"
      description="Rotas IPv4 desta máquina: para onde cada destino é encaminhado. A rota 0.0.0.0/0 é o gateway padrão (saída para a internet)."
    >
      <ToolForm onSubmit={() => run()}>
        <RunButton isPending={isPending} label="Consultar" pendingLabel="Lendo rotas..." />
      </ToolForm>
      <ToolError error={error} />
      {data && (
        <>
          <ToolSummary>
            {data.length} rota(s).{" "}
            {defaultRoutes.length > 0 &&
              `Gateway padrão: ${defaultRoutes.map((r) => `${r.nextHop} (${r.interface})`).join(", ")}.`}
          </ToolSummary>
          <ResultTable
            columns={["Destino", "Próximo salto", "Interface", "Métrica", "Origem"]}
            rows={data.map((r) => [
              r.destination === "0.0.0.0/0" ? (
                <span key="d" className="flex items-center gap-2">
                  {r.destination}
                  <Badge variant="secondary">padrão</Badge>
                </span>
              ) : (
                r.destination
              ),
              r.nextHop === "0.0.0.0" ? "direto (on-link)" : r.nextHop,
              r.interface,
              r.metric ?? "—",
              r.protocol,
            ])}
            mono={[0, 1]}
          />
        </>
      )}
    </ToolCard>
  );
}
