"use client";

import Link from "next/link";
import { useState } from "react";
import { runArpTableQuery } from "@/app/actions/tool-actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResultTable, RunButton, ToolCard, ToolError, ToolForm, ToolSummary, useTool } from "./tool-shell";

/** Broadcast/multicast (bit I/G do primeiro octeto) e MAC vazio não são dispositivos. */
function isDeviceEntry(mac: string | null): boolean {
  return !!mac && (parseInt(mac.slice(0, 2), 16) & 1) === 0 && mac !== "00:00:00:00:00:00";
}

export function ArpTableTool() {
  const { run, data, error, isPending } = useTool(runArpTableQuery);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLowerCase();
  const rows = (data ?? [])
    .filter((e) => showAll || (isDeviceEntry(e.mac) && !/unreachable|incomplete/i.test(e.state)))
    .filter((e) => !needle || [e.ip, e.mac, e.vendor, e.interface, e.deviceName].some((v) => v?.toLowerCase().includes(needle)));

  return (
    <ToolCard
      title="Tabela ARP"
      description="Associações IP → MAC que esta máquina conhece, por interface de rede, com o fabricante e o dispositivo do inventário."
    >
      <ToolForm onSubmit={() => run()}>
        <RunButton isPending={isPending} label="Consultar" pendingLabel="Lendo tabela..." />
        {data && (
          <>
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar por IP, MAC, interface..." className="sm:w-64" />
            <Label className="flex items-center gap-2 text-sm font-normal">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Mostrar broadcast, multicast e entradas incompletas
            </Label>
          </>
        )}
      </ToolForm>
      <ToolError error={error} />
      {data && (
        <>
          <ToolSummary>
            Exibindo {rows.length} de {data.length} entrada(s).
          </ToolSummary>
          <ResultTable
            columns={["IP", "MAC", "Fabricante", "Inventário", "Estado", "Interface"]}
            rows={rows.map((e) => [
              e.ip,
              e.mac ?? "—",
              e.vendor ?? "—",
              e.deviceId ? (
                <Link key="d" href={`/devices/${e.deviceId}`} className="hover:underline">
                  {e.deviceName ?? "Dispositivo sem nome"}
                </Link>
              ) : (
                "—"
              ),
              e.state,
              e.interface,
            ])}
            mono={[0, 1]}
          />
        </>
      )}
    </ToolCard>
  );
}
