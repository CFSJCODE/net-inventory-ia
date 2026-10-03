"use client";

import { useState } from "react";
import { runSnmpQuery } from "@/app/actions/tool-actions";
import type { SnmpMode, SnmpVersion } from "@/lib/network/tools/snmp";
import { Input } from "@/components/ui/input";
import { Field, ResultTable, RunButton, SimpleSelect, ToolCard, ToolError, ToolForm, ToolSummary, useTool } from "./tool-shell";

const MODES: Record<SnmpMode, string> = {
  system: "Identificação (system)",
  interfaces: "Interfaces de rede",
  printer: "Suprimentos da impressora",
  get: "GET de um OID",
  walk: "WALK a partir de um OID",
};

const VERSIONS: Record<SnmpVersion, string> = { "2c": "v2c", "1": "v1" };

export function SnmpTool() {
  const [host, setHost] = useState("");
  const [community, setCommunity] = useState("public");
  const [version, setVersion] = useState<SnmpVersion>("2c");
  const [mode, setMode] = useState<SnmpMode>("system");
  const [oid, setOid] = useState("1.3.6.1.2.1.1");
  const { run, data, error, isPending } = useTool(runSnmpQuery);
  const needsOid = mode === "get" || mode === "walk";

  return (
    <ToolCard
      title="SNMP Query"
      description="Coleta dados de switches, roteadores e impressoras gerenciáveis (SNMP v1/v2c). O dispositivo precisa ter o SNMP habilitado."
    >
      <ToolForm onSubmit={() => run({ host, community, version, mode, oid: needsOid ? oid : undefined })}>
        <Field label="Host" htmlFor="snmp-host">
          <Input id="snmp-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.2" className="sm:w-40" required />
        </Field>
        <Field label="Community" htmlFor="snmp-community">
          <Input id="snmp-community" value={community} onChange={(e) => setCommunity(e.target.value)} className="sm:w-32" />
        </Field>
        <Field label="Versão" htmlFor="snmp-version">
          <SimpleSelect id="snmp-version" value={version} onChange={setVersion} options={VERSIONS} className="sm:w-20" />
        </Field>
        <Field label="Consulta" htmlFor="snmp-mode">
          <SimpleSelect id="snmp-mode" value={mode} onChange={setMode} options={MODES} className="sm:w-56" />
        </Field>
        {needsOid && (
          <Field label="OID" htmlFor="snmp-oid">
            <Input id="snmp-oid" value={oid} onChange={(e) => setOid(e.target.value)} className="sm:w-56 font-mono" required />
          </Field>
        )}
        <RunButton isPending={isPending} label="Consultar" pendingLabel="Consultando..." />
      </ToolForm>
      <ToolError error={error} />
      {data && (
        <>
          {data.rows.length > 0 && <ToolSummary>{data.rows.length} linha(s) retornada(s).</ToolSummary>}
          <ResultTable
            columns={data.columns}
            rows={data.rows}
            mono={mode === "get" || mode === "walk" ? [0] : mode === "interfaces" ? [2] : []}
            empty="O agente respondeu, mas não há dados para essa consulta."
          />
        </>
      )}
    </ToolCard>
  );
}
