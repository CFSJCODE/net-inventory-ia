"use client";

import { useState } from "react";
import { runDnsQuery } from "@/app/actions/tool-actions";
import { DNS_RECORD_TYPES, type DnsRecordType } from "@/lib/network/tools/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, ResultTable, RunButton, SimpleSelect, ToolCard, ToolError, ToolForm, ToolSummary, useTool, useToolDefaults } from "./tool-shell";

const TYPE_OPTIONS = Object.fromEntries(DNS_RECORD_TYPES.map((t) => [t, t])) as Record<DnsRecordType, string>;

export function DnsTool() {
  const { data: defaults } = useToolDefaults();
  const [name, setName] = useState("");
  const [type, setType] = useState<DnsRecordType>("A");
  const [server, setServer] = useState("");
  const { run, data, error, isPending } = useTool(runDnsQuery);

  return (
    <ToolCard
      title="Consulta DNS"
      description="Resolve registros DNS (A, MX, TXT...). Para descobrir o nome de um IP, use o tipo PTR. Com o gateway como servidor, dá para ver os nomes que o roteador conhece."
    >
      <ToolForm onSubmit={() => run(name, type, server)}>
        <Field label="Nome ou IP" htmlFor="dns-name">
          <Input id="dns-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="exemplo.com.br" className="sm:w-56" required />
        </Field>
        <Field label="Tipo" htmlFor="dns-type">
          <SimpleSelect id="dns-type" value={type} onChange={setType} options={TYPE_OPTIONS} className="sm:w-24" />
        </Field>
        <Field label="Servidor (vazio = do sistema)" htmlFor="dns-server">
          <div className="flex gap-2">
            <Input id="dns-server" value={server} onChange={(e) => setServer(e.target.value)} placeholder="8.8.8.8" className="sm:w-36 font-mono" />
            {defaults?.gateway && (
              <Button type="button" variant="outline" onClick={() => setServer(defaults.gateway)}>
                Gateway
              </Button>
            )}
          </div>
        </Field>
        <RunButton isPending={isPending} label="Consultar" pendingLabel="Consultando..." />
      </ToolForm>
      <ToolError error={error} />
      {data && (
        <>
          <ToolSummary>
            {data.records.length} registro(s) {data.type} para {data.name} via {data.server} em {data.durationMs} ms.
          </ToolSummary>
          <ResultTable columns={["Registro"]} rows={data.records.map((r) => [r])} mono={[0]} />
        </>
      )}
    </ToolCard>
  );
}
