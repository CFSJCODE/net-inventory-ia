import type { ServiceStatus } from "@/lib/global-status/types";

/** Cores semáforo do painel, nas mesmas classes dos selos de status do restante do app. */
export const SERVICE_STATUS_STYLE: Record<ServiceStatus, { label: string; badge: string; dot: string; text: string }> = {
  OK: { label: "Operando", badge: "border-emerald-900 bg-emerald-950 text-emerald-400", dot: "bg-emerald-500", text: "text-emerald-400" },
  DEGRADED: { label: "Degradado", badge: "border-amber-900 bg-amber-950 text-amber-400", dot: "bg-amber-500", text: "text-amber-400" },
  DOWN: { label: "Fora do ar", badge: "border-red-900 bg-red-950 text-red-400", dot: "bg-red-500", text: "text-red-400" },
  MAINTENANCE: { label: "Manutenção", badge: "border-sky-900 bg-sky-950 text-sky-400", dot: "bg-sky-500", text: "text-sky-400" },
  UNKNOWN: { label: "Sem dados", badge: "border-zinc-800 bg-zinc-900 text-zinc-400", dot: "bg-zinc-500", text: "text-zinc-400" },
};

export const IMPACT_LABEL: Record<string, string> = {
  MINOR: "Menor",
  MAJOR: "Grave",
  CRITICAL: "Crítico",
  MAINTENANCE: "Manutenção",
};

export const IMPACT_STATUS: Record<string, ServiceStatus> = {
  MINOR: "DEGRADED",
  MAJOR: "DOWN",
  CRITICAL: "DOWN",
  MAINTENANCE: "MAINTENANCE",
};

const STATE_LABEL: Record<string, string> = {
  investigating: "Investigando",
  identified: "Identificado",
  monitoring: "Monitorando",
  resolved: "Resolvido",
  scheduled: "Agendada",
  in_progress: "Em andamento",
  verifying: "Verificando",
  completed: "Concluída",
  available: "Normalizado",
  service_disruption: "Interrupção",
  service_outage: "Fora do ar",
  service_information: "Informativo",
};

export function incidentStateLabel(state: string): string {
  return STATE_LABEL[state.toLowerCase()] ?? state;
}
