"use client";

import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { parsePortName } from "@/lib/network/port-name";
import type { PortStatus } from "@/lib/network/equipment-status";
import type { KnownDevice } from "@/app/actions/equipment-actions";

// ---------------------------------------------------------------- formatação

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(value: string | null): string {
  if (value === null) return "—";
  let n = Number(value);
  if (!Number.isFinite(n)) return value;
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n.toLocaleString("pt-BR", { maximumFractionDigits: unit ? 1 : 0 })} ${UNITS[unit]}`;
}

function formatCount(value: string | null): string {
  if (value === null) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR") : value;
}

export function formatSpeed(mbps: number | null): string {
  if (!mbps) return "—";
  return mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`;
}

function formatAgo(minutes: number | null): string {
  if (minutes === null) return "desde que o switch ligou";
  if (minutes < 1) return "agora há pouco";
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return `há ${d} d ${h} h`;
  if (h) return `há ${h} h ${m} min`;
  return `há ${m} min`;
}

const LINK_TYPE_LABEL: Record<NonNullable<PortStatus["linkType"]>, string> = {
  access: "Access (uma VLAN, sem tag)",
  trunk: "Trunk (várias VLANs com tag)",
  hybrid: "Hybrid (VLANs com e sem tag)",
};

export function linkLabel(port: PortStatus): string {
  if (port.adminStatus === "down") return "Desabilitada";
  if (port.operStatus === "up") return "Ativo";
  if (port.operStatus === "down") return "Inativo";
  return port.operStatus || "—";
}

// ---------------------------------------------------------------- blocos do popover

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">{children}</dl>
    </div>
  );
}

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 text-right break-words", mono && "font-mono")}>{children}</dd>
    </>
  );
}

function hasErrors(port: PortStatus): boolean {
  const c = port.counters;
  return [c.inErrors, c.outErrors].some((v) => v !== null && v !== "0");
}

/** Detalhes completos de uma porta; o gatilho (quadradinho do painel ou nome na tabela) vem de fora. */
export function PortPopover({
  port,
  devicesByMac,
  children,
}: {
  port: PortStatus;
  devicesByMac: Record<string, KnownDevice>;
  children: ReactElement;
}) {
  const info = parsePortName(port.name);
  const c = port.counters;
  const known = port.learnedMacs.map((mac) => ({ mac, device: devicesByMac[mac] ?? null }));
  const shown = known.slice(0, 8);

  return (
    <Popover>
      <PopoverTrigger openOnHover delay={150} closeDelay={100} render={children} />
      <PopoverContent className="flex w-84 flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <PopoverTitle className="font-mono text-sm">{port.shortName}</PopoverTitle>
            {port.description && <p className="truncate text-xs font-medium text-primary">{port.description}</p>}
          </div>
          <span
            className={cn(
              "shrink-0 rounded-md border px-1.5 py-0.5 text-[11px]",
              port.operStatus === "up" ? "border-emerald-900 bg-emerald-950 text-emerald-400" : "border-border text-muted-foreground",
            )}
          >
            {linkLabel(port)}
          </span>
        </div>

        {info && (
          <div className="flex flex-col gap-1 rounded-md bg-muted/40 px-2.5 py-2 text-xs">
            <p className="font-mono">{port.name}</p>
            <p className="text-muted-foreground">
              <span className="font-mono text-foreground">{info.abbr}</span> = {info.type}: {info.typeLabel}
            </p>
            {info.numbers.map((n, i) => (
              <p key={i} className="text-muted-foreground">
                <span className="font-mono text-foreground">{n}</span> = {info.parts[i]}
              </p>
            ))}
          </div>
        )}

        <Section title="Estado">
          <Row label="Administrativo">{port.adminStatus === "up" ? "Habilitada" : port.adminStatus === "down" ? "Desabilitada (shutdown)" : port.adminStatus || "—"}</Row>
          <Row label="Link">{port.operStatus === "up" ? "Ativo" : port.operStatus === "down" ? "Inativo (sem cabo ou do outro lado desligado)" : port.operStatus || "—"}</Row>
          <Row label="Velocidade">{formatSpeed(port.speedMbps)}</Row>
          <Row label="Duplex">{port.duplex === "full" ? "Full (envia e recebe ao mesmo tempo)" : port.duplex === "half" ? "Half (verifique a negociação)" : "—"}</Row>
          <Row label="Última mudança">{formatAgo(port.lastChangeMinutesAgo)}</Row>
        </Section>

        <Separator />

        <Section title="Camada 2">
          <Row label="Modo da porta">{port.linkType ? LINK_TYPE_LABEL[port.linkType] : "—"}</Row>
          <Row label="VLAN (PVID)">{port.pvid !== null ? `${port.pvid}${port.vlanName ? ` · ${port.vlanName}` : ""}` : "—"}</Row>
          <Row label="Spanning Tree">{port.stpState ?? "—"}</Row>
          <Row label="MTU">{port.mtu !== null ? `${port.mtu.toLocaleString("pt-BR")} bytes` : "—"}</Row>
          <Row label="MAC da porta" mono>{port.mac ?? "—"}</Row>
        </Section>

        <Separator />

        <Section title="Tráfego desde que o switch ligou">
          <Row label="Recebido">{formatBytes(c.inOctets)}</Row>
          <Row label="Enviado">{formatBytes(c.outOctets)}</Row>
          <Row label="Pacotes unicast">{formatCount(c.inUcast)} ↓ · {formatCount(c.outUcast)} ↑</Row>
          <Row label="Multicast">{formatCount(c.inMcast)} ↓ · {formatCount(c.outMcast)} ↑</Row>
          <Row label="Broadcast">{formatCount(c.inBcast)} ↓ · {formatCount(c.outBcast)} ↑</Row>
          <Row label="Erros">
            <span className={cn(hasErrors(port) && "text-red-400")}>
              {formatCount(c.inErrors)} ↓ · {formatCount(c.outErrors)} ↑
            </span>
          </Row>
          <Row label="Descartes">{formatCount(c.inDiscards)} ↓ · {formatCount(c.outDiscards)} ↑</Row>
        </Section>

        <Separator />

        <Section title="Vizinho LLDP">
          {port.neighbor ? (
            <>
              <Row label="Sistema">{port.neighbor.sysName ?? "—"}</Row>
              <Row label="Porta remota">{port.neighbor.portDesc ?? port.neighbor.portId ?? "—"}</Row>
              <Row label="Chassi" mono>{port.neighbor.chassisId ?? "—"}</Row>
            </>
          ) : (
            <dd className="col-span-2 text-muted-foreground">Nenhum vizinho anunciou LLDP nesta porta.</dd>
          )}
        </Section>

        <Separator />

        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            MACs aprendidos ({port.learnedMacCount})
          </p>
          {port.learnedMacCount === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum endereço aprendido nesta porta agora.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {shown.map(({ mac, device }) => (
                <li key={mac} className="flex items-center justify-between gap-3">
                  <span className="font-mono text-muted-foreground">{mac}</span>
                  {device ? (
                    <Link href={`/devices/${device.id}`} className="truncate text-right text-primary hover:underline">
                      {device.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground/60">fora do inventário</span>
                  )}
                </li>
              ))}
              {port.learnedMacCount > shown.length && (
                <li className="text-muted-foreground">
                  e mais {port.learnedMacCount - shown.length}
                  {port.learnedMacCount > 20 ? ". Muitos MACs costumam indicar um uplink ou outro switch nesta porta." : "."}
                </li>
              )}
            </ul>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground/70">ifIndex {port.ifIndex}{port.ifType !== null ? ` · ifType ${port.ifType}` : ""}</p>
      </PopoverContent>
    </Popover>
  );
}
