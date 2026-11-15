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

/** Impacto gravado de volta para o nível do IODA (para carregar uma queda aberta). */
export const IMPACT_LEVEL: Record<string, Level> = { MAJOR: "critical", CRITICAL: "critical", MINOR: "warning" };

/** "bgp:1794566700" → sinal e início da queda; null para um id que não é deste adaptador. */
export function parseRunId(externalId: string): { datasource: string; start: number } | null {
  const match = /^(.+):(\d+)$/.exec(externalId);
  return match ? { datasource: match[1], start: Number(match[2]) } : null;
}

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

type Level = "critical" | "warning";

/** Uma queda de um sinal: o nível mais grave dela (para o impacto) e o nível de agora (para o estado). */
export interface Run {
  datasource: string;
  start: number;
  end: number | null;
  /** O pior nível visto na queda. */
  level: Level;
  /** O nível do alerta mais novo: uma queda crítica que melhorou para aviso segue aberta, mas degradada. */
  current: Level;
  value: number | null;
  historyValue: number | null;
  /** Texto já gravado de uma queda que começou antes da janela consultada (sem os valores dela). */
  affected?: string | null;
}

/** Queda que estava aberta no banco: continua aberta até chegar um "normal", mesmo com o começo fora da janela de 7 dias. */
export interface CarriedRun {
  datasource: string;
  start: number;
  level: Level;
  affected: string | null;
}

/** Variação do sinal contra o normal, em texto: "20.220 contra 25.416 do normal (−20%)". */
function dropText(value: number | null, history: number | null): string | null {
  if (value === null || history === null || !Number.isFinite(value) || !Number.isFinite(history) || history <= 0) return null;
  const pct = Math.round(((value - history) / history) * 100);
  const fmt = (n: number) => Math.round(n).toLocaleString("pt-BR");
  return `${fmt(value)} contra ${fmt(history)} do normal (${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%)`;
}

type ValidAlert = Required<Pick<IodaAlert, "datasource" | "time" | "level">> & IodaAlert;

/** Aplica um alerta "critical"/"warning" à queda aberta do sinal, ou abre uma nova. */
function raise(open: Map<string, Run>, runs: Run[], a: ValidAlert): void {
  const level: Level = a.level === "critical" ? "critical" : "warning";
  const current = open.get(a.datasource);
  if (!current) {
    const run: Run = { datasource: a.datasource, start: a.time, end: null, level, current: level, value: a.value ?? null, historyValue: a.historyValue ?? null };
    open.set(a.datasource, run);
    runs.push(run);
    return;
  }
  current.current = level;
  if (level === "critical" && current.level !== "critical") {
    current.level = "critical";
    current.value = a.value ?? current.value;
    current.historyValue = a.historyValue ?? current.historyValue;
  }
}

/**
 * Junta os alertas de cada sinal em quedas: do primeiro "critical"/"warning" até o "normal" seguinte.
 * `carried` são as quedas que estavam abertas no banco: um "normal" na janela fecha cada uma, e sem
 * ele ela segue aberta (a janela de 7 dias pode já não ter o alerta que a abriu).
 */
export function iodaRuns(alerts: readonly IodaAlert[], carried: readonly CarriedRun[] = []): Run[] {
  const sorted = alerts
    .filter((a): a is ValidAlert => typeof a.datasource === "string" && typeof a.time === "number" && typeof a.level === "string")
    .sort((a, b) => a.time - b.time);
  const runs: Run[] = carried.map((c) => ({ datasource: c.datasource, start: c.start, end: null, level: c.level, current: c.level, value: null, historyValue: null, affected: c.affected }));
  const open = new Map(runs.map((r) => [r.datasource, r]));
  for (const a of sorted) {
    if (a.level !== "normal") {
      raise(open, runs, a);
      continue;
    }
    // Um "normal" sem queda aberta fecha uma que começou antes da janela e já foi encerrada: fica de fora.
    const current = open.get(a.datasource);
    if (current) {
      current.end = a.time;
      open.delete(a.datasource);
    }
  }
  return runs;
}

const LEVEL_STATUS: Record<Level, ServiceStatus> = { critical: "DOWN", warning: "DEGRADED" };
const LEVEL_IMPACT: Record<Level, IncidentImpact> = { critical: "MAJOR", warning: "MINOR" };

/**
 * Snapshot de uma entidade do IODA (país ou ASN).
 *
 * - Componentes: um por sinal, no nível do alerta mais novo da queda aberta (crítico = fora, aviso =
 *   degradado). O impacto do incidente fica no pior nível da queda.
 * - Status: normal sem alerta aberto; degradado com um sinal em alerta; fora do ar só com dois ou mais
 *   sinais em alerta crítico ao mesmo tempo (um país inteiro "fora" pede mais de uma evidência).
 * - Incidentes: cada queda da semana, aberta ou já encerrada, com o link para o painel do IODA.
 */
export function parseIodaAlerts(body: IodaAlertsResponse, options: { entity: string; pageUrl: string | null; carried?: readonly CarriedRun[] }): OfficialSnapshot {
  if (!body || !Array.isArray(body.data)) throw new Error("Resposta do IODA sem a lista de alertas");
  const runs = iodaRuns(body.data, options.carried);
  const openRuns = runs.filter((r) => r.end === null);
  const openBySignal = new Map(openRuns.map((r) => [r.datasource, r]));

  const signals = [...new Set([...DEFAULT_SIGNALS, ...runs.map((r) => r.datasource)])];
  const components: NormalizedComponent[] = signals.map((datasource, position) => {
    const run = openBySignal.get(datasource);
    return { externalId: datasource, name: signalLabel(datasource), groupName: null, status: run ? LEVEL_STATUS[run.current] : "OK", position };
  });

  const critical = openRuns.filter((r) => r.current === "critical").length;
  const status: ServiceStatus = !openRuns.length ? "OK" : critical >= 2 ? "DOWN" : "DEGRADED";
  const description = !openRuns.length
    ? "Sem alertas do IODA"
    : `Alerta do IODA em ${openRuns.map((r) => signalLabel(r.datasource).toLowerCase()).join(", ")}`;

  const incidents: NormalizedIncident[] = runs.map((r) => {
    const drop = dropText(r.value, r.historyValue);
    const affected = r.affected !== undefined ? r.affected : drop ? `${signalLabel(r.datasource)}: ${drop}` : signalLabel(r.datasource);
    return {
      externalId: `${r.datasource}:${r.start}`,
      title: `${options.entity}: queda no sinal ${signalLabel(r.datasource).toLowerCase()}`,
      impact: LEVEL_IMPACT[r.level],
      state: r.end === null ? "investigating" : "resolved",
      url: options.pageUrl,
      affected,
      startedAt: new Date(r.start * 1000),
      resolvedAt: r.end === null ? null : new Date(r.end * 1000),
    };
  });

  return { status, description, components, incidents };
}
