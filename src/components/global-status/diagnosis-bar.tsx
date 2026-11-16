"use client";

import { useQuery } from "@tanstack/react-query";
import { getRouteOverview, type GlobalStatusData } from "@/app/actions/global-status-actions";
import { SCOPE_LABEL, diagnose, type CauseScope } from "@/lib/global-status/diagnosis";
import { cn } from "@/lib/utils";
import { SERVICE_STATUS_STYLE } from "./status-style";

/** Cor de cada lugar da causa: na sua rede pede ação (vermelho/âmbar); fora dela é aviso neutro. */
const SCOPE_TONE: Record<CauseScope, string> = {
  LOCAL: SERVICE_STATUS_STYLE.DOWN.badge,
  ACCESS: SERVICE_STATUS_STYLE.DEGRADED.badge,
  UPSTREAM: SERVICE_STATUS_STYLE.MAINTENANCE.badge,
  PROVIDER: SERVICE_STATUS_STYLE.UNKNOWN.badge,
  SERVICE: SERVICE_STATUS_STYLE.UNKNOWN.badge,
};

/**
 * Faixa "Diagnóstico": agrupa os serviços fora do normal pela causa provável (regras em
 * `lib/global-status/diagnosis.ts`) e diz onde ela está e o que fazer. Usa as rotas da seção "Rotas e
 * trânsito" (mesma consulta, sem pedir de novo) para saber quem sai pelo mesmo lugar.
 */
export function DiagnosisBar({ data, onOpen }: { data: GlobalStatusData; onOpen: (slug: string) => void }) {
  const { data: routes } = useQuery({ queryKey: ["global-status-routes"], queryFn: () => getRouteOverview(), refetchInterval: 120_000, enabled: data.probes });
  const d = diagnose({ services: data.services, connectivity: data.connectivity, incidents: data.incidents, places: routes?.places });
  if (!d.headline || !d.scope) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm" aria-label="Diagnóstico">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-md border px-2 py-0.5 text-xs font-semibold tracking-wide", SCOPE_TONE[d.scope])}>{SCOPE_LABEL[d.scope]}</span>
        <span className="font-medium">{d.headline}.</span>
      </div>
      <ul className="flex flex-col gap-2">
        {d.groups.map((g) => (
          <li key={`${g.scope}-${g.label}`} className="flex flex-col gap-1 border-t pt-2 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className={cn("rounded border px-1.5 py-px font-medium", SCOPE_TONE[g.scope])}>{SCOPE_LABEL[g.scope]}</span>
              <span className="font-medium text-foreground">{g.label}</span>
              <span className="text-muted-foreground">
                {g.services.length} {g.services.length === 1 ? "serviço" : "serviços"}:{" "}
                {g.services.map((s, i) => (
                  <span key={s.slug}>
                    {i > 0 && ", "}
                    <button type="button" className={cn("hover:underline", SERVICE_STATUS_STYLE[s.status].text)} onClick={() => onOpen(s.slug)}>
                      {s.name}
                    </button>
                  </span>
                ))}
              </span>
            </div>
            <p className="text-muted-foreground">{g.detail}</p>
            <p className={g.action ? "text-foreground" : "text-muted-foreground"}>{g.action ? `O que fazer: ${g.action}` : "Nada a fazer do seu lado: acompanhe até normalizar."}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
