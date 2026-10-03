"use client";

import { useState } from "react";
import { runPortScan } from "@/app/actions/tool-actions";
import { Input } from "@/components/ui/input";
import { Field, ResultTable, RunButton, SimpleSelect, ToolCard, ToolError, ToolForm, ToolSummary, useTool } from "./tool-shell";

const PRESETS = {
  common: "Portas comuns (~70)",
  wellKnown: "Well-known (1-1024)",
  all: "Todas (1-65535)",
  custom: "Personalizado",
};

export function PortScanTool({ initialHost = "" }: { initialHost?: string }) {
  const [host, setHost] = useState(initialHost);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("common");
  const [custom, setCustom] = useState("22,80,443,8000-8100");
  const [timeoutMs, setTimeoutMs] = useState("500");
  const { run, data, error, isPending } = useTool(runPortScan);

  return (
    <ToolCard
      title="Port Scan"
      description="Scan TCP connect (como nmap -sT). Porta fechada = o host recusou a conexão; filtrada = sem resposta (firewall)."
    >
      <ToolForm onSubmit={() => run(host, preset === "custom" ? custom : preset, Number(timeoutMs))}>
        <Field label="Host (IP ou nome)" htmlFor="ps-host">
          <Input id="ps-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" className="sm:w-44" required />
        </Field>
        <Field label="Portas" htmlFor="ps-preset">
          <SimpleSelect id="ps-preset" value={preset} onChange={setPreset} options={PRESETS} className="sm:w-52" />
        </Field>
        {preset === "custom" && (
          <Field label="Lista / faixas" htmlFor="ps-custom">
            <Input id="ps-custom" value={custom} onChange={(e) => setCustom(e.target.value)} className="sm:w-56 font-mono" />
          </Field>
        )}
        <Field label="Timeout (ms)" htmlFor="ps-timeout">
          <Input id="ps-timeout" type="number" min={100} max={5000} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} className="sm:w-28" />
        </Field>
        <RunButton isPending={isPending} label="Escanear portas" pendingLabel="Escaneando..." />
      </ToolForm>
      {preset === "all" && !isPending && !data && (
        <ToolSummary>Um scan de todas as portas leva cerca de 1 a 2 minutos por host.</ToolSummary>
      )}
      <ToolError error={error} />
      {data && (
        <>
          <ToolSummary>
            {data.target}: {data.open.length} aberta(s), {data.closed} fechada(s), {data.filtered} filtrada(s) de {data.scanned} porta(s)
            testada(s) em {(data.durationMs / 1000).toFixed(1)}s.
          </ToolSummary>
          <ResultTable
            columns={["Porta", "Serviço provável", "Latência"]}
            rows={data.open.map((p) => [`${p.port}/tcp`, p.service ?? "—", `${p.latencyMs} ms`])}
            mono={[0]}
            empty="Nenhuma porta aberta encontrada."
          />
        </>
      )}
    </ToolCard>
  );
}
