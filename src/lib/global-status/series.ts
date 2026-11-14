/**
 * Séries para os gráficos do painel, a partir das janelas de 5 min (ProbeRollup). Funções puras.
 *
 * ESQUELETO: as assinaturas abaixo são o contrato entre as actions e os componentes.
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

/** Junta janelas de 5 min em passos de `stepMin` cobrindo as últimas `hours` horas até `end`. */
export function buildSeries(rollups: RollupPoint[], options: { end: Date; hours: number; stepMin: number }): SparkSeries {
  void rollups; void options;
  throw new Error("buildSeries: não implementado");
}

/** Disponibilidade em % sobre as janelas (1 − Σfalhas ÷ Σamostras); null sem amostras. */
export function uptimeOf(rollups: Pick<RollupPoint, "samples" | "failures">[]): number | null {
  void rollups;
  throw new Error("uptimeOf: não implementado");
}
