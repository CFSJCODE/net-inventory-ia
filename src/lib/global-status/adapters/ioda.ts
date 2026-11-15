import type { IncidentImpact, NormalizedComponent, NormalizedIncident, OfficialSnapshot, ServiceStatus } from "../types";

/**
 * IODA (Internet Outage Detection and Analysis, Georgia Tech): alertas de queda de Internet por país ou
 * por ASN, a partir de sinais passivos e ativos medidos do mundo todo. É a "visão de fora" do painel:
 * as duas máquinas do NetInventory saem pelo mesmo provedor, e o IODA diz se o Brasil (ou a sua
 * operadora) está com problema visto de fora.
 *
 * Endpoint (aberto, sem chave; conferido em 15/11/2026):
 *   https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?entityType=country&entityCode=BR&from=<s>&until=<s>
 * Cada alerta é uma mudança de nível de um sinal: "critical" ou "warning" abre, "normal" fecha. O valor
 * vem junto do histórico (ex.: BGP 20.220 prefixos contra 25.416 do normal).
 */

export interface IodaAlert {
  datasource?: string;
  time?: number;
  level?: string;
  value?: number | null;
  historyValue?: number | null;
}

export interface IodaAlertsResponse {
  data?: IodaAlert[] | null;
  error?: unknown;
}

/** Os sinais que o IODA acompanha por país e ASN; outros que aparecerem entram com o nome cru. */
export const IODA_SIGNALS: Record<string, string> = {
  bgp: "Rotas BGP",
  "ping-slash24": "Sondagem ativa (ping)",
  "merit-nt": "Telescópio de rede",
  gtr: "Tráfego no Google",
  "gtr-norm": "Tráfego no Google",
};
/** Sinais sempre listados como componentes, mesmo sem alerta na janela. */
const DEFAULT_SIGNALS = ["bgp", "ping-slash24", "merit-nt"];

/** Janela consultada: uma semana, para o histórico do detalhe. */
export const IODA_WINDOW_S = 7 * 24 * 3600;

export function iodaAlertsUrl(base: string, nowMs: number): string {
  const until = Math.floor(nowMs / 1000);
  return `${base}${base.includes("?") ? "&" : "?"}from=${until - IODA_WINDOW_S}&until=${until}`;
}

const signalLabel = (datasource: string) => IODA_SIGNALS[datasource] ?? datasource;

interface Run {
  datasource: string;
  start: number;
  end: number | null;
  level: "critical" | "warning";
  value: number | null;
  historyValue: number | null;
}

/** Variação do sinal contra o normal, em texto: "20.220 contra 25.416 do normal (−20%)". */
function dropText(value: number | null, history: number | null): string | null {
  if (value === null || history === null || !Number.isFinite(value) || !Number.isFinite(history) || history <= 0) return null;
  const pct = Math.round(((value - history) / history) * 100);
  const fmt = (n: number) => Math.round(n).toLocaleString("pt-BR");
  return `${fmt(value)} contra ${fmt(history)} do normal (${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%)`;
}

/** Junta os alertas de cada sinal em quedas: do primeiro "critical"/"warning" até o "normal" seguinte. */
export function iodaRuns(alerts: readonly IodaAlert[]): Run[] {
  const sorted = alerts
    .filter((a): a is Required<Pick<IodaAlert, "datasource" | "time" | "level">> & IodaAlert => typeof a.datasource === "string" && typeof a.time === "number" && typeof a.level === "string")
    .sort((a, b) => a.time - b.time);
  const open = new Map<string, Run>();
  const runs: Run[] = [];
  for (const a of sorted) {
    const current = open.get(a.datasource);
    if (a.level === "normal") {
      // Um "normal" sem queda aberta fecha uma que começou antes da janela: fica de fora.
      if (current) {
        current.end = a.time;
        open.delete(a.datasource);
      }
      continue;
    }
    const level = a.level === "critical" ? "critical" : "warning";
    if (!current) {
      const run: Run = { datasource: a.datasource, start: a.time, end: null, level, value: a.value ?? null, historyValue: a.historyValue ?? null };
      open.set(a.datasource, run);
      runs.push(run);
    } else if (level === "critical" && current.level !== "critical") {
      current.level = "critical";
      current.value = a.value ?? current.value;
      current.historyValue = a.historyValue ?? current.historyValue;
    }
  }
  return runs;
}

const LEVEL_STATUS: Record<Run["level"], ServiceStatus> = { critical: "DOWN", warning: "DEGRADED" };
const LEVEL_IMPACT: Record<Run["level"], IncidentImpact> = { critical: "MAJOR", warning: "MINOR" };

/**
 * Snapshot de uma entidade do IODA (país ou ASN).
 *
 * - Componentes: um por sinal, no nível do alerta aberto (crítico = fora, aviso = degradado).
 * - Status: normal sem alerta aberto; degradado com um sinal em alerta; fora do ar só com dois ou mais
 *   sinais em alerta crítico ao mesmo tempo (um país inteiro "fora" pede mais de uma evidência).
 * - Incidentes: cada queda da semana, aberta ou já encerrada, com o link para o painel do IODA.
 */
export function parseIodaAlerts(body: IodaAlertsResponse, options: { entity: string; pageUrl: string | null }): OfficialSnapshot {
  if (!body || !Array.isArray(body.data)) throw new Error("Resposta do IODA sem a lista de alertas");
  const runs = iodaRuns(body.data);
  const openRuns = runs.filter((r) => r.end === null);
  const openBySignal = new Map(openRuns.map((r) => [r.datasource, r]));

  const signals = [...new Set([...DEFAULT_SIGNALS, ...runs.map((r) => r.datasource)])];
  const components: NormalizedComponent[] = signals.map((datasource, position) => {
    const run = openBySignal.get(datasource);
    return { externalId: datasource, name: signalLabel(datasource), groupName: null, status: run ? LEVEL_STATUS[run.level] : "OK", position };
  });

  const critical = openRuns.filter((r) => r.level === "critical").length;
  const status: ServiceStatus = !openRuns.length ? "OK" : critical >= 2 ? "DOWN" : "DEGRADED";
  const description = !openRuns.length
    ? "Sem alertas do IODA"
    : `Alerta do IODA em ${openRuns.map((r) => signalLabel(r.datasource).toLowerCase()).join(", ")}`;

  const incidents: NormalizedIncident[] = runs.map((r) => {
    const drop = dropText(r.value, r.historyValue);
    return {
      externalId: `${r.datasource}:${r.start}`,
      title: `${options.entity}: queda no sinal ${signalLabel(r.datasource).toLowerCase()}`,
      impact: LEVEL_IMPACT[r.level],
      state: r.end === null ? "investigating" : "resolved",
      url: options.pageUrl,
      affected: drop ? `${signalLabel(r.datasource)}: ${drop}` : signalLabel(r.datasource),
      startedAt: new Date(r.start * 1000),
      resolvedAt: r.end === null ? null : new Date(r.end * 1000),
    };
  });

  return { status, description, components, incidents };
}
