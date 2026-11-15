"use client";

import type { StatusServiceRow } from "@/app/actions/global-status-actions";
import { worstStatus, type ServiceStatus } from "@/lib/global-status/types";
import { cn } from "@/lib/utils";
import { SERVICE_STATUS_STYLE } from "./status-style";

/** Cor do rótulo: o pior estado conhecido entre os itens; "Sem dados" enquanto nada foi consultado. */
function stripTone(services: StatusServiceRow[]): ServiceStatus {
  const known = services.map((s) => s.status).filter((s) => s !== "UNKNOWN");
  return known.length ? worstStatus(known) : "UNKNOWN";
}

/**
 * Faixa "Internet no Brasil" (fase 4): a visão de fora, logo abaixo da faixa "Sua Internet". Alertas do
 * IODA para o país e para a operadora do servidor, e a visibilidade BGP dos prefixos dos serviços. Mesmo
 * desenho da faixa de cima; cada item abre o detalhe com os sinais e os incidentes da semana.
 */
export function RegionalBar({ services, onOpen }: { services: StatusServiceRow[]; onOpen: (slug: string) => void }) {
  if (!services.length) return null;
  const tone = stripTone(services);
  const toneStyle = SERVICE_STATUS_STYLE[tone];
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-card text-sm text-muted-foreground sm:flex-row sm:items-center">
      <span className={cn("flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs font-semibold tracking-wide sm:self-stretch sm:border-r sm:border-b-0 sm:px-3 sm:py-0", toneStyle.text)}>
        <span className={cn("h-1.5 w-1.5 rounded-full", toneStyle.dot, tone !== "OK" && tone !== "UNKNOWN" && "animate-pulse")} />
        INTERNET NO BRASIL
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-y-1 py-2.5">
        {services.map((s) => {
          const style = SERVICE_STATUS_STYLE[s.status];
          return (
            <button key={s.slug} type="button" onClick={() => onOpen(s.slug)} className="flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 text-left hover:text-foreground">
              <span className="flex shrink-0 items-center gap-2">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} />
                <span className="font-medium text-foreground">{s.name}</span>
              </span>
              <span className={cn("min-w-0 break-words", s.status !== "OK" && style.text)}>{s.officialStatus ?? (s.lastError ? "Fonte indisponível" : "Consultando…")}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
