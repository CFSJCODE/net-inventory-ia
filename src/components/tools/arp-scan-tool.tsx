"use client";

import { useEffect, useState } from "react";
import { runArpScan } from "@/app/actions/tool-actions";
import { Input } from "@/components/ui/input";
import { Field, ResultTable, RunButton, ToolCard, ToolError, ToolForm, ToolSummary, useTool, useToolDefaults } from "./tool-shell";

export function ArpScanTool() {
  const { data: defaults } = useToolDefaults();
  const [cidr, setCidr] = useState("");
  const { run, data, error, isPending } = useTool(runArpScan);

  useEffect(() => {
    if (defaults?.cidr) setCidr((current) => current || defaults.cidr);
  }, [defaults?.cidr]);

  return (
    <ToolCard
      title="ARP Scan"
      description="Força a resolução ARP de cada IP da faixa. Encontra até dispositivos que bloqueiam ping, como celulares e câmeras."
    >
      <ToolForm onSubmit={() => run(cidr)}>
        <Field label="Faixa (CIDR)" htmlFor="arp-cidr">
          <Input id="arp-cidr" value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="192.168.1.0/24" className="sm:w-52" />
        </Field>
        <RunButton isPending={isPending} label="Escanear" pendingLabel="Escaneando..." />
      </ToolForm>
      <ToolError error={error} />
      {data && (
        <>
          <ToolSummary>{data.length} dispositivo(s) responderam ao ARP.</ToolSummary>
          <ResultTable
            columns={["IP", "MAC", "Fabricante", "Estado"]}
            rows={data.map((h) => [h.ip, h.mac, h.vendor ?? "—", h.state])}
            mono={[0, 1]}
          />
        </>
      )}
    </ToolCard>
  );
}
