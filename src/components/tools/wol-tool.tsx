"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { runWakeOnLan } from "@/app/actions/tool-actions";
import { useDevices } from "@/hooks/use-devices";
import { displayName } from "@/lib/device-name";
import { Input } from "@/components/ui/input";
import { Field, RunButton, SimpleSelect, ToolCard, ToolError, ToolForm, ToolSummary, useTool, useToolDefaults } from "./tool-shell";

const MANUAL = "__manual__";

export function WakeOnLanTool() {
  const { data: defaults } = useToolDefaults();
  const { data: devices } = useDevices();
  const [selected, setSelected] = useState<string>(MANUAL);
  const [mac, setMac] = useState("");
  const [broadcast, setBroadcast] = useState("");
  const { run, data, error, isPending } = useTool(runWakeOnLan);

  useEffect(() => {
    if (defaults?.broadcast) setBroadcast((current) => current || defaults.broadcast);
  }, [defaults?.broadcast]);

  useEffect(() => {
    if (data) toast.success("Magic packet enviado", { description: `Para ${data.mac}` });
  }, [data]);

  const withMac = (devices ?? []).filter((d) => d.mac);
  const options: Record<string, string> = {
    [MANUAL]: "Informar MAC manualmente",
    ...Object.fromEntries(withMac.map((d) => [d.mac!, `${displayName(d, "Sem nome")} — ${d.ip} (${d.mac})`])),
  };

  function handleSelect(value: string) {
    setSelected(value);
    if (value !== MANUAL) setMac(value);
  }

  return (
    <ToolCard
      title="Wake-on-LAN"
      description="Liga um PC remotamente enviando o magic packet em broadcast. O PC precisa ter o WoL habilitado na BIOS/UEFI e na placa de rede, e estar ligado por cabo."
    >
      <ToolForm onSubmit={() => run(mac, broadcast)}>
        <Field label="Dispositivo do inventário" htmlFor="wol-device">
          <SimpleSelect id="wol-device" value={selected} onChange={handleSelect} options={options} className="sm:w-80" />
        </Field>
        <Field label="MAC" htmlFor="wol-mac">
          <Input
            id="wol-mac"
            value={mac}
            onChange={(e) => {
              setMac(e.target.value);
              setSelected(MANUAL);
            }}
            placeholder="AA:BB:CC:DD:EE:FF"
            className="sm:w-48 font-mono"
            required
          />
        </Field>
        <Field label="Broadcast" htmlFor="wol-bcast">
          <Input id="wol-bcast" value={broadcast} onChange={(e) => setBroadcast(e.target.value)} className="sm:w-40 font-mono" required />
        </Field>
        <RunButton isPending={isPending} label="Ligar" pendingLabel="Enviando..." />
      </ToolForm>
      <ToolError error={error} />
      {data && (
        <ToolSummary>
          Magic packet enviado 3x para {data.mac} via {data.targets.join(" e ")} (UDP 9). Se o PC não ligar em até 1 minuto,
          verifique as configurações de WoL dele.
        </ToolSummary>
      )}
    </ToolCard>
  );
}
