import { jitter, median, percentile } from "./stats";

/**
 * Janela deslizante das medições (fase 6): p50/p95/p99, jitter e perda sobre as últimas N medições, e
 * um gatilho de degradação contra uma linha de base dinâmica.
 *
 * Modelo: seja x₁…xₜ a série de latências de um alvo (só medições com resposta) e W as últimas N
 * medições (com e sem resposta). Então
 *
 *   p_q(W)   = percentil q das latências de W (interpolação linear, como em `percentile`);
 *   jitter   = média de |xᵢ − xᵢ₋₁| nas latências consecutivas de W (RFC 3550, sem o filtro 1/16);
 *   perda    = média em W de 100 para cada medição sem resposta e da perda medida (ping) nas demais;
 *   base     = mediana das últimas B latências (B = 100 por padrão), incluindo as de W;
 *   degradado ⇔ |base| ≥ B_min ∧ p95(W) > max(1,5 · base, base + Δ_min).
 *
 * A mediana como base resiste a picos (um pico isolado não a desloca), e o p95 da janela pega a cauda
 * que piora antes da mediana. O Δ_min (10 ms) evita alarme de ruído em alvos de 1 ms, como o gateway da
 * LAN, em que 2 ms já seria "o dobro do normal".
 *
 * Custo: O(n · (N log N + B log B)) para a série inteira; com n ≈ 1.440 medições por dia, N = 20 e
 * B = 100, são algumas centenas de milhares de comparações, desprezível.
 */

export const DEFAULT_WINDOW_SIZE = 20;
export const MIN_WINDOW_SIZE = 5;
export const MAX_WINDOW_SIZE = 200;
export const BASELINE_POINTS = 100;
export const DEGRADE_FACTOR = 1.5;
/** Pontos mínimos na base para o gatilho valer (com menos, qualquer variação parece anomalia). */
export const MIN_BASELINE_POINTS = 30;
/** Diferença mínima entre o p95 e a base para degradar, em ms. */
export const MIN_DEGRADE_DELTA_MS = 10;

export interface WindowSample {
  ok: boolean;
  latencyMs: number | null;
  lossPct?: number | null;
}

export interface WindowOptions {
  /** N: medições na janela. */
  size?: number;
  /** B: latências na linha de base. */
  baselinePoints?: number;
  factor?: number;
  minBaselinePoints?: number;
  minDeltaMs?: number;
}

export interface WindowStats {
  /** Medições na janela (com e sem resposta). */
  samples: number;
  /** Medições com latência na janela. */
  answered: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  /** Mediana das últimas B latências; null sem nenhuma. */
  baselineMs: number | null;
  /** p95 ÷ base; null sem os dois. */
  ratio: number | null;
  degraded: boolean;
}

/** N válido entre 5 e 200; o resto vira o padrão (20). */
export function normalizeWindowSize(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_WINDOW_SIZE && n <= MAX_WINDOW_SIZE ? n : DEFAULT_WINDOW_SIZE;
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

function latenciesOf(samples: readonly WindowSample[]): number[] {
  return samples.filter((s) => s.ok && finite(s.latencyMs)).map((s) => s.latencyMs as number);
}

function lossOf(window: readonly WindowSample[]): number | null {
  if (!window.length) return null;
  const sum = window.reduce((acc, s) => acc + (s.ok ? (finite(s.lossPct) ? s.lossPct : 0) : 100), 0);
  return sum / window.length;
}

/** Estatística da janela que termina na última medição de `samples` (da mais velha para a mais nova). */
export function windowStats(samples: readonly WindowSample[], options: WindowOptions = {}): WindowStats {
  const size = normalizeWindowSize(options.size ?? DEFAULT_WINDOW_SIZE);
  const window = samples.slice(-size);
  const lats = latenciesOf(window);
  const baseline = latenciesOf(samples).slice(-(options.baselinePoints ?? BASELINE_POINTS));
  const baselineMs = median(baseline);
  const p95Ms = percentile(lats, 95);
  const ratio = p95Ms !== null && baselineMs !== null && baselineMs > 0 ? p95Ms / baselineMs : null;
  const factor = options.factor ?? DEGRADE_FACTOR;
  const minDelta = options.minDeltaMs ?? MIN_DEGRADE_DELTA_MS;
  // Com poucas respostas na janela, o p95 é praticamente o máximo: exige ao menos 5 (ou a janela toda, se menor).
  const enough = baseline.length >= (options.minBaselinePoints ?? MIN_BASELINE_POINTS) && lats.length >= Math.min(5, size);
  const degraded = enough && p95Ms !== null && baselineMs !== null && p95Ms > Math.max(factor * baselineMs, baselineMs + minDelta);
  return {
    samples: window.length,
    answered: lats.length,
    p50Ms: percentile(lats, 50),
    p95Ms,
    p99Ms: percentile(lats, 99),
    jitterMs: jitter(lats),
    lossPct: lossOf(window),
    baselineMs,
    ratio,
    degraded,
  };
}

/** A estatística da janela em cada ponto da série (o i-ésimo item usa as medições até a i-ésima). */
export function rollingWindowStats(samples: readonly WindowSample[], options: WindowOptions = {}): WindowStats[] {
  const keep = Math.max(normalizeWindowSize(options.size ?? DEFAULT_WINDOW_SIZE), options.baselinePoints ?? BASELINE_POINTS);
  // Basta olhar para trás até juntar B latências (e N medições); o histórico mais velho não muda nada.
  const out: WindowStats[] = [];
  for (let i = 0; i < samples.length; i++) {
    let from = i;
    let answered = 0;
    while (from > 0 && (answered < keep || i - from + 1 < keep)) {
      from--;
      if (samples[from].ok && finite(samples[from].latencyMs)) answered++;
    }
    out.push(windowStats(samples.slice(from, i + 1), options));
  }
  return out;
}
