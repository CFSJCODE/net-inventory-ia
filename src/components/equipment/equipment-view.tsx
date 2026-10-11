"use client";

import { useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useCan } from "@/components/auth/user-provider";
import { useTool } from "@/components/tools/tool-shell";
import { runEquipmentStatus } from "@/app/actions/equipment-actions";
import type { EquipmentStatus, FanStatus, PsuStatus, PortStatus } from "@/lib/network/equipment-status";

// ---------------------------------------------------------------- estilos de estado

const LINK_STYLE: Record<string, string> = {
  up:   "border-emerald-900 bg-emerald-950 text-emerald-400",
  down: "border-red-900 bg-red-950 text-red-400",
};

const ENTITY_STYLE: Record<string, string> = {
  ok:  "border-emerald-900 bg-emerald-950 text-emerald-400",
  err: "border-red-900 bg-red-950 text-red-400",
  unk: "border-amber-900 bg-amber-950 text-amber-400",
};

function linkStyle(status: string) {
  return LINK_STYLE[status] ?? "border-amber-900 bg-amber-950 text-amber-400";
}

function entityStyle(ok: boolean, status: string) {
  if (ok) return ENTITY_STYLE.ok;
  if (status === "—") return ENTITY_STYLE.unk;
  return ENTITY_STYLE.err;
}

// ---------------------------------------------------------------- sub-componentes

function MetricItem({ label, value, unit }: { label: string; value: number | null; unit?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">
        {value !== null ? (
          <>
            {value}
            {unit && <span className="ml-0.5 text-sm font-normal text-muted-foreground">{unit}</span>}
          </>
        ) : (
          <span className="text-base font-normal text-muted-foreground">—</span>
        )}
      </span>
    </div>
  );
}

function UnitBadges({ items, label }: { items: (FanStatus | PsuStatus)[]; label: string }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">Nenhum {label} detectado.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge key={item.id} variant="outline" className={cn("w-fit gap-1.5 font-normal", entityStyle(item.ok, item.status))}>
          <span className={cn("h-1.5 w-1.5 rounded-full", item.ok ? "bg-emerald-500" : item.status === "—" ? "bg-amber-500" : "bg-red-500")} />
          {label} {item.id} — {item.status}
        </Badge>
      ))}
    </div>
  );
}

function PortsTable({ ports }: { ports: PortStatus[] }) {
  if (!ports.length) return <p className="text-sm text-muted-foreground">Nenhuma porta física detectada.</p>;
  const up = ports.filter((p) => p.operStatus === "up").length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {up} de {ports.length} portas com link ativo
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30 text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Porta</th>
              <th className="px-3 py-2 text-left font-medium">Link</th>
              <th className="px-3 py-2 text-left font-medium">Velocidade</th>
              <th className="px-3 py-2 text-left font-medium">Descrição</th>
              <th className="px-3 py-2 text-left font-medium">Vizinho LLDP</th>
            </tr>
          </thead>
          <tbody>
            {ports.map((port) => (
              <tr key={port.name} className="border-b last:border-0 hover:bg-muted/20">
                <td className="px-3 py-1.5 font-mono text-xs">{port.shortName}</td>
                <td className="px-3 py-1.5">
                  <Badge variant="outline" className={cn("w-fit gap-1.5 font-normal text-xs", linkStyle(port.operStatus))}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", port.operStatus === "up" ? "bg-emerald-500" : "bg-red-500")} />
                    {port.operStatus === "up" ? "Ativo" : port.operStatus === "down" ? "Inativo" : port.operStatus}
                  </Badge>
                </td>
                <td className="px-3 py-1.5 text-xs text-muted-foreground">
                  {port.speedMbps ? (port.speedMbps >= 1000 ? `${port.speedMbps / 1000} Gbps` : `${port.speedMbps} Mbps`) : "—"}
                </td>
                <td className="px-3 py-1.5 text-xs text-muted-foreground">{port.description || "—"}</td>
                <td className="px-3 py-1.5 text-xs font-mono">{port.neighbor ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusCards({ data, isPending, onRefresh, canRefresh }: {
  data: EquipmentStatus;
  isPending: boolean;
  onRefresh: () => void;
  canRefresh: boolean;
}) {
  const readAt = new Date(data.readAt).toLocaleTimeString("pt-BR");
  return (
    <div className="flex flex-col gap-4">
      {/* linha de hora + botão */}
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {isPending ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Atualizando…
            </span>
          ) : (
            <>Atualizado às {readAt} — {data.sysName}</>
          )}
        </p>
        {canRefresh && (
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={isPending} className="w-fit gap-2">
            <RefreshCw className={cn("h-3.5 w-3.5", isPending && "animate-spin")} />
            Atualizar agora
          </Button>
        )}
      </div>

      {/* CPU / Memória / Temperatura */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Hardware</CardTitle>
          <CardDescription>Utilização do processador, memória e temperatura do chassi.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-8">
          <MetricItem label="CPU" value={data.cpuPct} unit="%" />
          <MetricItem label="Memória" value={data.memPct} unit="%" />
          <MetricItem label="Temperatura" value={data.tempC} unit="°C" />
          {data.tempThresholdC !== null && (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">Limite</span>
              <span className="text-2xl font-semibold tabular-nums">
                {data.tempThresholdC}
                <span className="ml-0.5 text-sm font-normal text-muted-foreground">°C</span>
              </span>
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Ligado há</span>
            <span className="text-base font-medium">{data.uptime}</span>
          </div>
        </CardContent>
      </Card>

      {/* Ventoinhas */}
      {data.fans.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Ventoinhas</CardTitle>
            <CardDescription>Estado de cada unidade de arrefecimento.</CardDescription>
          </CardHeader>
          <CardContent>
            <UnitBadges items={data.fans} label="Ventoinha" />
          </CardContent>
        </Card>
      )}

      {/* Fontes de alimentação */}
      {data.psus.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Fontes de alimentação</CardTitle>
            <CardDescription>Estado de cada fonte de alimentação (PSU).</CardDescription>
          </CardHeader>
          <CardContent>
            <UnitBadges items={data.psus} label="Fonte" />
          </CardContent>
        </Card>
      )}

      {/* Portas */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Portas</CardTitle>
          <CardDescription>
            Estado operacional das interfaces físicas. A velocidade é lida via ifHighSpeed (Mbps). O
            vizinho LLDP é o nome do sistema anunciado pelo dispositivo ligado naquela porta.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PortsTable ports={data.ports} />
        </CardContent>
      </Card>

      {/* Como ler */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Como ler estas informações</CardTitle>
          <CardDescription>De onde vêm os dados e o que significam.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>
            <strong className="font-medium text-foreground">CPU e Memória</strong> — lidos via OID{" "}
            <code className="font-mono text-xs">hh3cEntityExtCpuUsage</code> e{" "}
            <code className="font-mono text-xs">hh3cEntityExtMemUsage</code> da HH3C-ENTITY-EXT-MIB
            (prefixo <code className="font-mono text-xs">1.3.6.1.4.1.25506.2.6.1.1.1.1</code>), índice
            .8 refere-se ao chassi principal. O valor é a percentagem instantânea.
          </p>
          <p>
            <strong className="font-medium text-foreground">Temperatura</strong> — OID{" "}
            <code className="font-mono text-xs">hh3cEntityExtTemperature</code> (índice .12.8) em graus
            Celsius. O limite (<code className="font-mono text-xs">hh3cEntityExtTemperatureThreshold</code>,
            índice .13.8) é o máximo seguro configurado no dispositivo.
          </p>
          <p>
            <strong className="font-medium text-foreground">Ventoinhas e Fontes</strong> — tabela{" "}
            <code className="font-mono text-xs">hh3cEntityExtStateTable</code> (prefixo{" "}
            <code className="font-mono text-xs">1.3.6.1.4.1.25506.8.35.9</code>). Estado 2 = Normal;
            outros valores indicam problemas.
          </p>
          <p>
            <strong className="font-medium text-foreground">Portas</strong> — colunas da IF-MIB:{" "}
            <code className="font-mono text-xs">ifName</code> (nome),{" "}
            <code className="font-mono text-xs">ifOperStatus</code> (link ativo/inativo),{" "}
            <code className="font-mono text-xs">ifHighSpeed</code> (velocidade em Mbps),{" "}
            <code className="font-mono text-xs">ifAlias</code> (descrição configurada manualmente). O
            índice de cada porta (ex.: GE1/0/3) indica o slot/módulo/número da porta no chassis.
          </p>
          <p>
            <strong className="font-medium text-foreground">Vizinho LLDP</strong> — OID{" "}
            <code className="font-mono text-xs">lldpRemSysName</code> da LLDP-MIB (prefixo{" "}
            <code className="font-mono text-xs">1.0.8802.1.1.2.1.4.1.1.9</code>). Mostra o hostname do
            equipamento ligado naquela porta, se ele também anunciar LLDP.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- componente principal

export function EquipmentView() {
  const canQuery = useCan("network.operate");
  const [host, setHost] = useState("192.168.0.3");
  const [community, setCommunity] = useState("public");

  const { run, data, error, isPending } = useTool(runEquipmentStatus);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    run({ host, community });
  }

  function handleRefresh() {
    run({ host, community });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Formulário */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Consultar equipamento</CardTitle>
          <CardDescription>
            Informe o endereço IP do switch e a community SNMP para ler o estado do hardware e das
            portas em tempo real.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eq-host" className="text-xs">Endereço IP</Label>
              <Input
                id="eq-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.0.3"
                className="w-44 font-mono text-sm"
                disabled={isPending || !canQuery}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eq-community" className="text-xs">Community SNMP</Label>
              <Input
                id="eq-community"
                value={community}
                onChange={(e) => setCommunity(e.target.value)}
                placeholder="public"
                className="w-36 font-mono text-sm"
                disabled={isPending || !canQuery}
              />
            </div>
            <Button type="submit" disabled={isPending || !canQuery || !host.trim()} className="gap-2">
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Consultar
            </Button>
          </form>
          {!canQuery && (
            <p className="mt-2 text-xs text-muted-foreground">
              Requer permissão de operador de rede para consultar via SNMP.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Resultado */}
      {isPending && !data && (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {data && (
        <StatusCards
          data={data}
          isPending={isPending}
          onRefresh={handleRefresh}
          canRefresh={canQuery}
        />
      )}
    </div>
  );
}
