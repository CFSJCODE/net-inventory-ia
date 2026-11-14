import { aggregateChecks, bucketStart, median, percentile, uptimePct, type CheckSample } from "./stats";
import type { ProbeKind } from "./types";

/**
 * Séries para os gráficos do painel, a partir das janelas de 5 min (ProbeRollup) e das medições cruas
 * que ainda não viraram janela. Funções puras.
 */

/** Série compacta: um valor por passo, do mais antigo ao mais novo (o último passo termina em `end`). */
export interface SparkSeries {
  /** Início do primeiro passo (ISO 8601). */
  start: string;
  /** Duração de cada passo, em minutos. */
  stepMin: number;
  /** Latência mediana de cada passo, em ms; null = sem amostra ok. */
  p50: (number | null)[];
  /** Latência p95 de cada passo, em ms; null = sem amostra ok. */
  p95: (number | null)[];
  /** Medições com falha em cada passo. */
  fail: number[];
}

export interface RollupPoint {
  bucket: Date;
  samples: number;
  failures: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** Uma casa decimal: é o que as sondas medem, e deixa a série menor para trafegar a cada consulta da página. */
const round1 = (value: number | null): number | null => (value === null ? null : Math.round(value * 10) / 10);

/**
 * Junta janelas de 5 min em passos de `stepMin` cobrindo as últimas `hours` horas até `end`.
 *
 * A grade é fixa: termina no próximo múltiplo do passo depois de `end`, então duas consultas dentro do
 * mesmo passo devolvem a mesma grade e o gráfico não desliza a cada atualização. Em cada passo, a
 * mediana das medianas das janelas, o maior p95 e a soma das falhas; janela fora da grade é ignorada.
 */
export function buildSeries(rollups: RollupPoint[], options: { end: Date; hours: number; stepMin: number }): SparkSeries {
  const stepMs = options.stepMin * 60_000;
  const steps = Math.max(0, Math.round((options.hours * 60) / options.stepMin));
  const gridEnd = Math.ceil(options.end.getTime() / stepMs) * stepMs;
  const start = gridEnd - steps * stepMs;

  const medians: number[][] = Array.from({ length: steps }, () => []);
  const p95: (number | null)[] = Array.from({ length: steps }, () => null);
  const fail: number[] = Array.from({ length: steps }, () => 0);
  for (const point of rollups) {
    const step = Math.floor((point.bucket.getTime() - start) / stepMs);
    if (!(step >= 0 && step < steps)) continue;
    if (point.p50Ms !== null) medians[step].push(point.p50Ms);
    if (point.p95Ms !== null && point.p95Ms > (p95[step] ?? -Infinity)) p95[step] = point.p95Ms;
    fail[step] += point.failures;
  }
  return {
    start: new Date(start).toISOString(),
    stepMin: options.stepMin,
    p50: medians.map((values) => round1(median(values))),
    p95: p95.map(round1),
    fail,
  };
}

/** Disponibilidade em % sobre as janelas (1 − Σfalhas ÷ Σamostras); null sem amostras. */
export function uptimeOf(rollups: Pick<RollupPoint, "samples" | "failures">[]): number | null {
  let samples = 0;
  let failures = 0;
  for (const point of rollups) {
    samples += point.samples;
    failures += point.failures;
  }
  return uptimePct(samples, failures);
}

/** Mediana e p95 da latência de um período: a mediana das medianas das janelas e o percentil 95 dos p95. */
export function latencySummary(rollups: Pick<RollupPoint, "p50Ms" | "p95Ms">[]): { p50Ms: number | null; p95Ms: number | null } {
  const p50s = rollups.map((point) => point.p50Ms).filter((value): value is number => value !== null);
  const p95s = rollups.map((point) => point.p95Ms).filter((value): value is number => value !== null);
  return { p50Ms: round1(median(p50s)), p95Ms: round1(percentile(p95s, 95)) };
}

/** Uma medição crua (ProbeCheck) ainda sem janela fechada. */
export interface TailCheck extends CheckSample {
  targetId: string;
  at: Date;
}

/**
 * Ponta viva: resume as medições cruas mais novas que a última janela gravada, por alvo e por janela de
 * 5 min, no mesmo formato das janelas. Sem isso uma instalação nova ficaria até 6 min sem gráfico, e o
 * ponto mais novo do gráfico estaria sempre 6 min atrasado.
 */
export function tailPoints(checks: TailCheck[]): Map<string, RollupPoint[]> {
  const groups = new Map<string, Map<number, CheckSample[]>>();
  for (const check of checks) {
    let buckets = groups.get(check.targetId);
    if (!buckets) groups.set(check.targetId, (buckets = new Map()));
    const bucket = bucketStart(check.at.getTime());
    const list = buckets.get(bucket);
    if (list) list.push(check);
    else buckets.set(bucket, [check]);
  }
  const points = new Map<string, RollupPoint[]>();
  for (const [targetId, buckets] of groups) {
    const list = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bucket, samples]) => {
        const stats = aggregateChecks(samples);
        return { bucket: new Date(bucket), samples: stats.samples, failures: stats.failures, p50Ms: stats.p50Ms, p95Ms: stats.p95Ms };
      });
    points.set(targetId, list);
  }
  return points;
}

/**
 * Ordem de preferência do alvo que representa a latência de um serviço no card. O handshake TCP (um
 * round-trip) e o ping medem a rede; o HTTP fica por último porque soma DNS, TLS e o tempo do servidor.
 */
export const LATENCY_KIND_ORDER: ProbeKind[] = ["TCP", "ICMP", "TLS", "DNS", "HTTP"];

/** O alvo que representa a latência do serviço: o primeiro pelo tipo, em `LATENCY_KIND_ORDER`; null sem alvos. */
export function mainLatencyTarget<T extends { kind: string }>(targets: readonly T[]): T | null {
  for (const kind of LATENCY_KIND_ORDER) {
    const found = targets.find((target) => target.kind === kind);
    if (found) return found;
  }
  return targets[0] ?? null;
}
