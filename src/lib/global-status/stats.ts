import type { TargetStatus } from "./types";

/**
 * Estatística das medições próprias. Usa mediana e MAD (desvio absoluto mediano) em vez de média e
 * desvio padrão: um pico isolado não desloca a linha de base.
 */

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Percentil por interpolação linear (p entre 0 e 100). */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Desvio absoluto mediano: mediana de |xᵢ − mediana|. */
export function mad(values: number[]): number | null {
  const m = median(values);
  if (m === null) return null;
  return median(values.map((v) => Math.abs(v - m)));
}

/** Jitter no estilo da RFC 3550: média de |RTTᵢ − RTTᵢ₋₁| entre amostras consecutivas. */
export function jitter(rtts: number[]): number | null {
  if (rtts.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < rtts.length; i++) sum += Math.abs(rtts[i] - rtts[i - 1]);
  return sum / (rtts.length - 1);
}

/** Disponibilidade em % (1 − falhas ÷ amostras); null sem amostras. */
export function uptimePct(samples: number, failures: number): number | null {
  if (samples <= 0) return null;
  return Math.max(0, Math.min(100, (1 - failures / samples) * 100));
}

/** Duração de uma janela de agregação (uma linha de ProbeRollup por alvo e janela). */
export const BUCKET_MS = 5 * 60_000;

/** Início (ms desde 1970) da janela de 5 min que contém o instante `ms`. */
export function bucketStart(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}

/** O que a agregação precisa de cada medição crua. */
export interface CheckSample {
  ok: boolean;
  latencyMs: number | null;
  lossPct: number | null;
}

/** Resumo das medições de uma janela (os campos de ProbeRollup). */
export interface BucketStats {
  samples: number;
  failures: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  lossPct: number | null;
}

/**
 * Resume as medições de uma janela. As latências contam só as medições que deram certo (uma falha não
 * tem latência, tem ausência); a perda é a média das medições que informam perda (ping).
 */
export function aggregateChecks(checks: CheckSample[]): BucketStats {
  const latencies = checks.filter((c) => c.ok && c.latencyMs !== null).map((c) => c.latencyMs as number);
  const losses = checks.map((c) => c.lossPct).filter((v): v is number => v !== null);
  return {
    samples: checks.length,
    failures: checks.filter((c) => !c.ok).length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: latencies.length ? Math.max(...latencies) : null,
    lossPct: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
  };
}

/** Uma medição recente de um alvo. */
export interface RecentCheck {
  ok: boolean;
  latencyMs: number | null;
  lossPct: number | null;
  certDays: number | null;
}

export interface TargetVerdict {
  status: TargetStatus;
  reason: string | null;
}

/** Quantas medições recentes entram na avaliação. */
export const WINDOW_SIZE = 5;
/** Falhas seguidas para considerar o alvo fora do ar. */
export const FAILURES_TO_DOWN = 3;
/** Falhas seguidas para avisar (uma falha isolada não muda o estado; aparece só no gráfico). */
export const FAILURES_TO_DEGRADED = 2;
/** Mínimo de janelas de 5 min na linha de base para julgar latência (1 h). */
export const MIN_BASELINE_POINTS = 12;
/** Perda média de pacotes, na janela, acima da qual o alvo fica degradado. */
export const LOSS_DEGRADED_PCT = 5;
/** Aviso de certificado: dias restantes (certificados de vida curta usam `certWarningFor`). */
export const CERT_WARNING_DAYS = 14;

/**
 * Limite do aviso de vencimento para um certificado com `lifetimeDays` de validade total: 14 dias, mas
 * nunca mais que 20% da validade. Sem isso um certificado de 6 dias (Let's Encrypt "shortlived")
 * ficaria em aviso permanente.
 */
export function certWarningFor(lifetimeDays: number | null | undefined): number {
  if (!lifetimeDays || lifetimeDays <= 0) return CERT_WARNING_DAYS;
  return Math.min(CERT_WARNING_DAYS, Math.floor(lifetimeDays * 0.2));
}

/** Latência acima da qual o alvo está "acima do normal", dada a linha de base; null sem base suficiente. */
export function latencyLimit(baseline: number[]): { median: number; limit: number } | null {
  if (baseline.length < MIN_BASELINE_POINTS) return null;
  const m = median(baseline)!;
  const spread = mad(baseline)!;
  // Folga mínima de 50% e 20 ms: oscilação de poucos ms num alvo muito estável não é degradação.
  return { median: m, limit: Math.max(m + 3 * spread, m * 1.5, m + 20) };
}

/**
 * Status de um alvo a partir das últimas medições (mais nova primeiro; usa as `WINDOW_SIZE` primeiras)
 * e da linha de base de 24 h (medianas das janelas de 5 min).
 *
 * - Fora: 3 falhas seguidas.
 * - Degradado: 2 falhas seguidas; certificado perto de vencer; perda média de pacotes acima de 5% na
 *   janela; ou latência sustentada acima de mediana + 3·MAD (a mediana da janela, isto é, 3 das 5
 *   medições acima do limite: um pico isolado não alarma).
 */
export function evaluateTarget(recent: RecentCheck[], baseline: number[], options: { certWarningDays?: number } = {}): TargetVerdict {
  const window = recent.slice(0, WINDOW_SIZE);
  if (!window.length) return { status: "UNKNOWN", reason: null };

  const firstOk = window.findIndex((c) => c.ok);
  const failures = firstOk === -1 ? window.length : firstOk;
  if (failures >= FAILURES_TO_DOWN) {
    return { status: "DOWN", reason: failures >= WINDOW_SIZE ? `sem resposta nas últimas ${failures} medições` : `${failures} falhas seguidas` };
  }
  if (failures >= FAILURES_TO_DEGRADED) return { status: "DEGRADED", reason: `${failures} falhas seguidas` };

  const latest = window[0];
  const certWarningDays = options.certWarningDays ?? CERT_WARNING_DAYS;
  if (latest.certDays !== null && latest.certDays < certWarningDays) {
    const reason = latest.certDays < 0 ? "certificado vencido" : latest.certDays === 0 ? "certificado vence hoje" : `certificado vence em ${latest.certDays} dia${latest.certDays === 1 ? "" : "s"}`;
    return { status: "DEGRADED", reason };
  }

  const losses = window.map((c) => c.lossPct).filter((v): v is number => v !== null);
  if (losses.length) {
    const loss = losses.reduce((a, b) => a + b, 0) / losses.length;
    if (loss > LOSS_DEGRADED_PCT) return { status: "DEGRADED", reason: `perda de ${Math.round(loss)}% dos pacotes` };
  }

  const latencies = window.filter((c) => c.ok).map((c) => c.latencyMs).filter((v): v is number => v !== null);
  const base = latencyLimit(baseline);
  if (base && latencies.length >= 3) {
    const current = median(latencies)!;
    if (current > base.limit && base.median > 0) {
      return { status: "DEGRADED", reason: `latência ${(current / base.median).toFixed(1).replace(".", ",")}× acima do normal (${Math.round(current)} ms)` };
    }
  }
  return { status: "OK", reason: null };
}
