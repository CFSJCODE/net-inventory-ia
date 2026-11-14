"use client";

import type { StatusServiceRow } from "@/app/actions/global-status-actions";
import { worstStatus, type LocalConnectivity, type ServiceStatus } from "@/lib/global-status/types";
import { formatDateTime, formatRelativeTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import { formatLatency } from "./format";
import { SERVICE_STATUS_STYLE } from "./status-style";

const OUT_TITLE: Record<Exclude<LocalConnectivity["state"], "ok">, string> = {
  offline: "Sua Internet está fora",
  dns: "O DNS deste servidor não está respondendo",
};

/** Cor do rótulo da faixa: o pior estado conhecido entre os itens; "Sem dados" enquanto nada foi medido. */
function stripTone(services: StatusServiceRow[], out: boolean): ServiceStatus {
  if (out) return "DOWN";
  const known = services.map((s) => s.status).filter((s) => s !== "UNKNOWN");
  return known.length ? worstStatus(known) : "UNKNOWN";
}

/**
 * Faixa "Sua Internet": a conexão do próprio servidor (gateway, DNS e resolvedores públicos), para a
 * pessoa separar uma queda local de uma queda do provedor. Cada item abre o detalhe do serviço.
 */
export function InternetHealthBar({ services, connectivity, onOpen }: { services: StatusServiceRow[]; connectivity: LocalConnectivity; onOpen: (slug: string) => void }) {
  const out = connectivity.state !== "ok";
  // Sem nenhum serviço de Internet habilitado e com a conexão normal, não há o que mostrar.
  if (!out && !services.length) return null;

  const tone = stripTone(services, out);
  const toneStyle = SERVICE_STATUS_STYLE[tone];
  const measured = services.some((s) => s.measuredStatus !== null);

  const items = services.map((s) => {
    const style = SERVICE_STATUS_STYLE[s.status];
    return (
      // flex-wrap: numa tela estreita o estado e o motivo descem juntos para a linha de baixo em vez de serem cortados.
      <button key={s.slug} type="button" onClick={() => onOpen(s.slug)} className="flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 text-left hover:text-foreground">
        <span className="flex shrink-0 items-center gap-2">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} />
          <span className="font-medium text-foreground">{s.name}</span>
          <span className="tabular-nums">{formatLatency(s.latencyMs)}</span>
        </span>
        {s.status !== "OK" && (
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("shrink-0", style.text)}>{style.label}</span>
            {s.measuredReason && <span className="truncate">{s.measuredReason}</span>}
          </span>
        )}
      </button>
    );
  });

  return (
    <div className={cn("flex items-center overflow-hidden rounded-xl border text-sm", out ? SERVICE_STATUS_STYLE.DOWN.badge : "bg-card text-muted-foreground")}>
      <span className={cn("flex shrink-0 items-center gap-2 self-stretch border-r px-3 text-xs font-semibold tracking-wide", !out && toneStyle.text)}>
        <span className={cn("h-1.5 w-1.5 rounded-full", toneStyle.dot, tone !== "OK" && tone !== "UNKNOWN" && "animate-pulse")} />
        SUA INTERNET
      </span>
      {out ? (
        <div className="flex min-w-0 flex-1 flex-col gap-2 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4">
            <span className="font-medium">{OUT_TITLE[connectivity.state === "dns" ? "dns" : "offline"]}</span>
            {connectivity.reason && <span>{connectivity.reason}</span>}
            {connectivity.since && (
              <span className="text-xs" title={formatDateTime(connectivity.since)}>
                · {formatRelativeTime(connectivity.since)}
              </span>
            )}
          </div>
          <p className="px-4 text-xs">As medições dos serviços ficam pausadas até a conexão voltar. Os cards mostram só o status oficial.</p>
          {items.length > 0 && <div className="flex flex-wrap items-center gap-y-1">{items}</div>}
        </div>
      ) : measured ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-y-1 py-2.5">{items}</div>
      ) : (
        <span className="min-w-0 flex-1 px-4 py-2.5">Medindo a conexão deste servidor…</span>
      )}
    </div>
  );
}
