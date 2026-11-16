/**
 * Série da seção Switch Health: as rodadas gravadas agrupadas em passos (no máximo MAX_POINTS), com os
 * erros somados por passo e a latência pela média, e o resumo por porta na janela. Puro, para testar.
 */

import { correlate, type Correlation } from "./counters";

export const MAX_POINTS = 240;

/** Janelas da tela, em horas. */
export const SWITCH_HEALTH_RANGES = [1, 6, 24, 168] as const;
export type SwitchHealthRange = (typeof SWITCH_HEALTH_RANGES)[number];

export interface HealthRow {
  at: Date;
  intervalSec: number;
  errorsPerMin: number | null;
  crcPerMin: number | null;
  discardsPerMin: number | null;
  inBps: number | null;
  outBps: number | null;
  latencyMs: number | null;
  gatewayLatencyMs: number | null;
}

export interface SeriesPoint {
  /** Início do passo (ms). */
  at: number;
  errorsPerMin: number | null;
  crcPerMin: number | null;
  discardsPerMin: number | null;
  latencyMs: number | null;
  gatewayLatencyMs: number | null;
  inBps: number | null;
  outBps: number | null;
}

const avg = (v: number[]) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null);
const nums = (rows: HealthRow[], key: keyof Omit<HealthRow, "at" | "intervalSec">) => rows.map((r) => r[key]).filter((v): v is number => v !== null);

/** Agrupa as rodadas em passos de tamanho fixo entre `from` e `to`. Passo sem rodada fica de fora. */
export function bucketSeries(rows: HealthRow[], from: number, to: number, maxPoints = MAX_POINTS): { stepMs: number; points: SeriesPoint[] } {
  const span = Math.max(1, to - from);
  const stepMs = Math.max(60_000, Math.ceil(span / maxPoints / 60_000) * 60_000);
  const buckets = new Map<number, HealthRow[]>();
  for (const r of rows) {
    const t = r.at.getTime();
    if (t < from || t > to) continue;
    const key = from + Math.floor((t - from) / stepMs) * stepMs;
    buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }
  const points = Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([at, group]) => ({
      at,
      // Taxa média do passo: um minuto com 60 erros num passo de 5 min dá 12/min, não some.
      errorsPerMin: avg(nums(group, "errorsPerMin")),
      crcPerMin: avg(nums(group, "crcPerMin")),
      discardsPerMin: avg(nums(group, "discardsPerMin")),
      latencyMs: avg(nums(group, "latencyMs")),
      gatewayLatencyMs: avg(nums(group, "gatewayLatencyMs")),
      inBps: avg(nums(group, "inBps")),
      outBps: avg(nums(group, "outBps")),
    }));
  return { stepMs, points };
}

/** Correlação dos erros com a latência à switch (LAN) e ao gateway, rodada a rodada (sem agrupar). */
export function correlations(rows: HealthRow[]): { lan: Correlation; gateway: Correlation } {
  return {
    lan: correlate(rows.map((r) => ({ errorsPerMin: r.errorsPerMin, latencyMs: r.latencyMs }))),
    gateway: correlate(rows.map((r) => ({ errorsPerMin: r.errorsPerMin, latencyMs: r.gatewayLatencyMs }))),
  };
}

export interface PortRow {
  ifIndex: number;
  name: string;
  inErrors: number | null;
  outErrors: number | null;
  inDiscards: number | null;
  outDiscards: number | null;
  crcErrors: number | null;
  errorsPerMin: number | null;
  utilPct: number | null;
}

export interface PortWindow {
  ifIndex: number;
  name: string;
  inErrors: number;
  outErrors: number;
  crcErrors: number;
  discards: number;
  /** Pior minuto da janela. */
  peakErrorsPerMin: number;
  /** Rodadas com algum erro. */
  samplesWithErrors: number;
  avgUtilPct: number | null;
}

/** Totais de cada porta na janela, piores primeiro. */
export function portWindows(rows: PortRow[]): PortWindow[] {
  const byPort = new Map<number, PortWindow & { utils: number[] }>();
  for (const r of rows) {
    const w = byPort.get(r.ifIndex) ?? { ifIndex: r.ifIndex, name: r.name, inErrors: 0, outErrors: 0, crcErrors: 0, discards: 0, peakErrorsPerMin: 0, samplesWithErrors: 0, avgUtilPct: null, utils: [] };
    w.inErrors += r.inErrors ?? 0;
    w.outErrors += r.outErrors ?? 0;
    w.crcErrors += r.crcErrors ?? 0;
    w.discards += (r.inDiscards ?? 0) + (r.outDiscards ?? 0);
    w.peakErrorsPerMin = Math.max(w.peakErrorsPerMin, r.errorsPerMin ?? 0);
    if ((r.inErrors ?? 0) + (r.outErrors ?? 0) > 0) w.samplesWithErrors++;
    if (r.utilPct !== null) w.utils.push(r.utilPct);
    byPort.set(r.ifIndex, w);
  }
  return Array.from(byPort.values())
    .map(({ utils, ...w }) => ({ ...w, avgUtilPct: avg(utils) }))
    .sort((a, b) => b.inErrors + b.outErrors - (a.inErrors + a.outErrors) || b.discards - a.discards || a.ifIndex - b.ifIndex);
}
