/**
 * Contas da saúde das portas da switch, sem rede nem banco: diferença entre duas leituras dos contadores
 * IF-MIB (com volta do Counter32 e zeragem), taxas por minuto, utilização e a correlação entre os erros
 * de interface e a latência. A coleta fica em poller.ts.
 */

const TWO_32 = BigInt(2) ** BigInt(32);
/** Uma "volta" do Counter32 maior que isso é zeragem (reset counters, reinício), não volta de verdade. */
const MAX_PLAUSIBLE_WRAP = BigInt(2) ** BigInt(31);

/** Contadores crus de uma porta numa leitura (strings decimais: Counter64 passa de 2^53). */
export interface RawPortCounters {
  inErrors: string | null;
  outErrors: string | null;
  inDiscards: string | null;
  outDiscards: string | null;
  /** dot3StatsFCSErrors (EtherLike-MIB): quadros com CRC errado. */
  crcErrors: string | null;
  inOctets: string | null;
  outOctets: string | null;
}

export interface RawPortReading {
  ifIndex: number;
  name: string;
  operUp: boolean;
  speedMbps: number | null;
  counters: RawPortCounters;
}

/** Uma leitura de todas as portas físicas, com o sysUpTime para detectar reinício do equipamento. */
export interface RawSnapshot {
  at: number;
  /** sysUpTime em centésimos de segundo; null quando o agente não informou. */
  uptimeTicks: number | null;
  ports: RawPortReading[];
}

export interface PortRates {
  ifIndex: number;
  name: string;
  operUp: boolean;
  speedMbps: number | null;
  /** Quantidades no intervalo (null = sem base de comparação ou contador zerado). */
  inErrors: number | null;
  outErrors: number | null;
  inDiscards: number | null;
  outDiscards: number | null;
  crcErrors: number | null;
  /** Erros de entrada + saída por minuto (os de CRC já estão dentro dos de entrada, no ifInErrors). */
  errorsPerMin: number | null;
  discardsPerMin: number | null;
  crcPerMin: number | null;
  inBps: number | null;
  outBps: number | null;
  /** Maior sentido sobre a velocidade negociada, em %. */
  utilPct: number | null;
}

/**
 * Diferença entre duas leituras de um contador. Counter32 dá a volta em 2^32; uma volta grande demais é
 * contador zerado, e aí não há como saber quanto passou (null). Counter64 não dá a volta na prática:
 * valor menor é zeragem.
 */
export function counterDelta(prev: string | null, cur: string | null, bits: 32 | 64): bigint | null {
  if (prev === null || cur === null || !/^\d+$/.test(prev) || !/^\d+$/.test(cur)) return null;
  const a = BigInt(prev);
  const b = BigInt(cur);
  if (b >= a) return b - a;
  if (bits === 64) return null;
  const wrapped = b + TWO_32 - a;
  return wrapped <= MAX_PLAUSIBLE_WRAP ? wrapped : null;
}

const toNum = (v: bigint | null): number | null => (v === null ? null : Number(v));
const perMin = (count: number | null, seconds: number) => (count === null ? null : round2((count * 60) / seconds));
const sumNullable = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Taxas de cada porta entre duas leituras. Sem leitura anterior, com o equipamento reiniciado no meio
 * (sysUpTime voltou) ou com intervalo inválido, as quantidades ficam null: a primeira rodada só serve de base.
 */
export function computeRates(prev: RawSnapshot | null, cur: RawSnapshot): PortRates[] {
  const seconds = prev ? (cur.at - prev.at) / 1000 : 0;
  const rebooted = prev !== null && prev.uptimeTicks !== null && cur.uptimeTicks !== null && cur.uptimeTicks < prev.uptimeTicks;
  const usable = prev !== null && seconds > 0 && !rebooted;
  const prevPorts = new Map((prev?.ports ?? []).map((p) => [p.ifIndex, p]));
  return cur.ports.map((p) => {
    const before = usable ? prevPorts.get(p.ifIndex) : undefined;
    const d = (key: keyof RawPortCounters, bits: 32 | 64) => (before ? toNum(counterDelta(before.counters[key], p.counters[key], bits)) : null);
    const inErrors = d("inErrors", 32);
    const outErrors = d("outErrors", 32);
    const inDiscards = d("inDiscards", 32);
    const outDiscards = d("outDiscards", 32);
    const crcErrors = d("crcErrors", 32);
    const inOctets = d("inOctets", 64);
    const outOctets = d("outOctets", 64);
    const inBps = inOctets === null ? null : Math.round((inOctets * 8) / seconds);
    const outBps = outOctets === null ? null : Math.round((outOctets * 8) / seconds);
    const top = inBps === null && outBps === null ? null : Math.max(inBps ?? 0, outBps ?? 0);
    return {
      ifIndex: p.ifIndex,
      name: p.name,
      operUp: p.operUp,
      speedMbps: p.speedMbps,
      inErrors,
      outErrors,
      inDiscards,
      outDiscards,
      crcErrors,
      errorsPerMin: perMin(sumNullable(inErrors, outErrors), seconds),
      discardsPerMin: perMin(sumNullable(inDiscards, outDiscards), seconds),
      crcPerMin: perMin(crcErrors, seconds),
      inBps,
      outBps,
      utilPct: top !== null && p.speedMbps ? round2(Math.min(100, (top / (p.speedMbps * 1e6)) * 100)) : null,
    };
  });
}

export interface EquipmentTotals {
  errorsPerMin: number | null;
  discardsPerMin: number | null;
  crcPerMin: number | null;
  inBps: number | null;
  outBps: number | null;
  /** Porta com mais erros por minuto nesta rodada (null sem erro nenhum). */
  worstPort: string | null;
  worstPortErrorsPerMin: number | null;
}

/** Soma das portas, e a porta com mais erros (o alerta diz qual é). */
export function totalsOf(rates: PortRates[]): EquipmentTotals {
  const sum = (key: "errorsPerMin" | "discardsPerMin" | "crcPerMin" | "inBps" | "outBps") => {
    const values = rates.map((r) => r[key]).filter((v): v is number => v !== null);
    return values.length ? round2(values.reduce((a, b) => a + b, 0)) : null;
  };
  let worst: PortRates | null = null;
  for (const r of rates) {
    const score = r.errorsPerMin ?? 0;
    if (score > 0 && (!worst || score > (worst.errorsPerMin ?? 0))) worst = r;
  }
  return {
    errorsPerMin: sum("errorsPerMin"),
    discardsPerMin: sum("discardsPerMin"),
    crcPerMin: sum("crcPerMin"),
    inBps: sum("inBps"),
    outBps: sum("outBps"),
    worstPort: worst?.name ?? null,
    worstPortErrorsPerMin: worst?.errorsPerMin ?? null,
  };
}

// ---------------------------------------------------------------- correlação

/** Coeficiente de Pearson; null com menos de `minPoints` pares ou com uma das séries constante. */
export function pearson(xs: number[], ys: number[], minPoints = 10): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < minPoints) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return Math.round((cov / Math.sqrt(vx * vy)) * 1000) / 1000;
}

export interface CorrelationPoint {
  errorsPerMin: number | null;
  latencyMs: number | null;
}

export interface Correlation {
  /** Pearson entre erros/min e latência, nos minutos com as duas medidas. */
  r: number | null;
  /** Pares usados. */
  samples: number;
  /** Latência média nos minutos com erro e nos minutos sem erro. */
  latencyWithErrorsMs: number | null;
  latencyWithoutErrorsMs: number | null;
  minutesWithErrors: number;
  /** "inverse": a latência cai quando os erros sobem (r <= -0,4); não indica que os erros pesem na latência. */
  verdict: "insufficient" | "none" | "inverse" | "weak" | "moderate" | "strong";
}

const mean = (v: number[]) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null);

/**
 * Relação entre os erros de interface e a latência na mesma janela. Um r alto e a latência dos minutos com
 * erro bem acima da dos minutos limpos indicam que os erros (cabo, duplex, porta ruim) estão custando
 * retransmissões; r perto de zero indica que a latência vem de outro lugar (Wi-Fi, operadora).
 */
export function correlate(points: CorrelationPoint[]): Correlation {
  const pairs = points.filter((p): p is { errorsPerMin: number; latencyMs: number } => p.errorsPerMin !== null && p.latencyMs !== null);
  const r = pearson(pairs.map((p) => p.errorsPerMin), pairs.map((p) => p.latencyMs));
  const withErr = pairs.filter((p) => p.errorsPerMin > 0).map((p) => p.latencyMs);
  const without = pairs.filter((p) => p.errorsPerMin === 0).map((p) => p.latencyMs);
  let verdict: Correlation["verdict"] = "insufficient";
  if (pairs.length >= 10) {
    if (!withErr.length || r === null) verdict = "none";
    else {
      // Só r positivo diz que a latência sobe com os erros; negativo forte vira "inverse".
      verdict = r >= 0.7 ? "strong" : r >= 0.4 ? "moderate" : r >= 0.2 ? "weak" : r <= -0.4 ? "inverse" : "none";
    }
  }
  return {
    r,
    samples: pairs.length,
    latencyWithErrorsMs: mean(withErr),
    latencyWithoutErrorsMs: mean(without),
    minutesWithErrors: withErr.length,
    verdict,
  };
}

// ---------------------------------------------------------------- limites

export interface SwitchHealthThresholds {
  /** Erros de interface (ifInErrors + ifOutErrors, que já incluem o CRC) por minuto numa porta: alerta a partir daqui. */
  errorsPerMin: number;
  /** Descartes por minuto numa porta a partir dos quais a porta fica em atenção. */
  discardsPerMin: number;
}

export type PortHealth = "ok" | "warning" | "critical" | "unknown";

/** Estado da porta: crítico com erros acima do limite, atenção com descartes acima do limite ou algum erro. */
export function portHealth(r: Pick<PortRates, "errorsPerMin" | "crcPerMin" | "discardsPerMin">, t: SwitchHealthThresholds): PortHealth {
  if (r.errorsPerMin === null && r.crcPerMin === null && r.discardsPerMin === null) return "unknown";
  // O CRC entra só quando o agente não informa os erros gerais (ele já faz parte do ifInErrors).
  const errors = r.errorsPerMin ?? r.crcPerMin ?? 0;
  if (errors >= t.errorsPerMin) return "critical";
  if (errors > 0 || (r.discardsPerMin ?? 0) >= t.discardsPerMin) return "warning";
  return "ok";
}
