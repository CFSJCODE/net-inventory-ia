import { median } from "./stats";
import type { DnsAnswer, DnsRcode } from "./types";
import { rollingWindowStats, windowStats, type WindowOptions, type WindowStats } from "./window-stats";

/**
 * Linha do tempo NOC (fase 6): quatro leituras de um serviço alinhadas no mesmo eixo de tempo.
 *
 *   gateway → a LAN até o roteador (ping no gateway padrão);
 *   wan     → a saída para a Internet (ping nos resolvedores públicos 1.1.1.1, 8.8.8.8 e 9.9.9.9);
 *   dns     → o nome do serviço (DNS composto: sistema, 8.8.8.8 e 1.1.1.1);
 *   https   → o pedido ao serviço, com DNS, TCP, TLS, espera do servidor (TTFB) e total.
 *
 * Lidas da esquerda para a direita, as faixas apontam a camada do problema: a primeira vermelha ou
 * amarela, na ordem LAN → WAN → DNS → HTTPS, é por onde começar. Ex.: "às 20h05 a LAN e a WAN estavam
 * estáveis, o TCP do Discord normal, mas o TTFB subiu" = o atraso é no servidor do serviço.
 *
 * Este arquivo é só cálculo (sem banco e sem Node), para ser testado e usado também na tela.
 */

export type LaneKey = "gateway" | "wan" | "dns" | "https";
export const LANE_ORDER: LaneKey[] = ["gateway", "wan", "dns", "https"];
export const LANE_LABEL: Record<LaneKey, string> = { gateway: "Gateway (LAN)", wan: "WAN", dns: "DNS", https: "HTTPS" };

/** none = sem medição; ok; warn = falha parcial, perda ou latência acima da base; bad = todas falharam. */
export type CellState = "none" | "ok" | "warn" | "bad";

export type StageKey = "dnsMs" | "connectMs" | "tlsMs" | "ttfbMs" | "totalMs";
export const STAGE_KEYS: StageKey[] = ["dnsMs", "connectMs", "tlsMs", "ttfbMs", "totalMs"];
export const STAGE_LABEL: Record<StageKey, string> = { dnsMs: "DNS", connectMs: "TCP", tlsMs: "TLS", ttfbMs: "TTFB", totalMs: "total" };
/** Etapas que podem ser "a culpada" (o total é a soma). */
const BLAME_STAGES: StageKey[] = ["dnsMs", "connectMs", "tlsMs", "ttfbMs"];

/** Uma medição crua de uma faixa. */
export interface LaneSample {
  at: number;
  ok: boolean;
  latencyMs: number | null;
  lossPct?: number | null;
  error?: string | null;
  /** Só HTTPS. */
  stages?: Partial<Record<StageKey, number | null>>;
  httpStatus?: number | null;
  /** Só DNS composto. */
  answers?: DnsAnswer[] | null;
  rcode?: string | null;
  ttlSec?: number | null;
}

export interface ResolverCell {
  resolver: string;
  ms: number | null;
  rcode: DnsRcode;
  ttlSec: number | null;
}

/** Um passo de uma faixa. */
export interface TimelineCell {
  state: CellState;
  samples: number;
  failures: number;
  /** Mediana das latências do passo. */
  ms: number | null;
  lossPct: number | null;
  /** Estatística da janela deslizante na última medição do passo. */
  p95Ms: number | null;
  baselineMs: number | null;
  degraded: boolean;
  /** Primeiro erro do passo. */
  error: string | null;
  /** HTTPS: mediana de cada etapa no passo. */
  stages?: Partial<Record<StageKey, number | null>>;
  httpStatus?: number | null;
  /** DNS composto: a última resposta de cada resolvedor no passo. */
  resolvers?: ResolverCell[];
}

export interface ResolverSummary {
  resolver: string;
  answered: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Contagem por código de erro no período. */
  errors: Partial<Record<DnsRcode, number>>;
  lastTtlSec: number | null;
  /** TTL esperado − TTL devolvido (mediana): quanto a resposta envelheceu no cache. */
  ttlDriftSec: number | null;
}

export interface StageSummary {
  stage: StageKey;
  /** Mediana da janela (últimas N medições). */
  currentMs: number | null;
  /** Mediana das últimas 100. */
  baselineMs: number | null;
  ratio: number | null;
}

export interface LaneSummary {
  lane: LaneKey;
  /** Há medições desta faixa no período. */
  available: boolean;
  /** O que a faixa mede, por extenso. */
  source: string;
  stats: WindowStats;
  failures: number;
  samples: number;
  /** Estado da faixa agora (último passo com medição, se for dos 3 últimos). */
  state: CellState;
  /** DNS composto. */
  resolvers?: ResolverSummary[];
  /** Maior TTL visto no período (aproxima o TTL configurado pelo dono do domínio). */
  expectedTtlSec?: number | null;
  /** HTTPS. */
  stages?: StageSummary[];
  /** HTTPS: a etapa que mais cresceu sobre a base (≥ 1,5×), se houver. */
  blamed?: StageSummary | null;
}

export interface Timeline {
  start: number;
  end: number;
  stepMs: number;
  /** Início de cada passo (ms desde 1970). */
  steps: number[];
  lanes: Record<LaneKey, TimelineCell[]>;
  summary: Record<LaneKey, LaneSummary>;
  windowSize: number;
  /** Frase de diagnóstico do estado atual. */
  diagnosis: string;
}

export interface LaneInput {
  samples: LaneSample[];
  source: string;
}

/** Tamanho do passo para o período: 1 h → 1 min, 3 h → 2 min, 6 h → 5 min, 24 h → 15 min. */
export function stepForHours(hours: number): number {
  if (hours <= 1) return 60_000;
  if (hours <= 3) return 2 * 60_000;
  if (hours <= 6) return 5 * 60_000;
  return 15 * 60_000;
}

export const TIMELINE_HOURS = [1, 3, 6, 24] as const;
export function normalizeHours(value: unknown): number {
  const n = Number(value);
  return (TIMELINE_HOURS as readonly number[]).includes(n) ? n : 3;
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const medianOf = (values: (number | null | undefined)[]): number | null => median(values.filter(finite));

function cellState(samples: number, failures: number, lossPct: number | null, degraded: boolean): CellState {
  if (!samples) return "none";
  if (failures >= samples) return "bad";
  if (failures > 0 || degraded || (lossPct !== null && lossPct > 0)) return "warn";
  return "ok";
}

function buildCells(samples: LaneSample[], rolling: WindowStats[], steps: number[], stepMs: number, lane: LaneKey): TimelineCell[] {
  const cells: TimelineCell[] = [];
  let i = 0;
  for (const stepStart of steps) {
    const stepEnd = stepStart + stepMs;
    while (i < samples.length && samples[i].at < stepStart) i++;
    const from = i;
    while (i < samples.length && samples[i].at < stepEnd) i++;
    const inStep = samples.slice(from, i);
    const last = i > from ? rolling[i - 1] : null;
    const failures = inStep.filter((s) => !s.ok).length;
    const okSamples = inStep.filter((s) => s.ok);
    const losses = okSamples.map((s) => s.lossPct).filter(finite);
    const lossPct = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null;
    const degraded = last?.degraded ?? false;
    const cell: TimelineCell = {
      state: cellState(inStep.length, failures, lossPct, degraded),
      samples: inStep.length,
      failures,
      ms: medianOf(okSamples.map((s) => s.latencyMs)),
      lossPct,
      p95Ms: last?.p95Ms ?? null,
      baselineMs: last?.baselineMs ?? null,
      degraded,
      error: inStep.find((s) => !s.ok && s.error)?.error ?? null,
    };
    if (lane === "https" && inStep.length) {
      cell.stages = Object.fromEntries(STAGE_KEYS.map((k) => [k, medianOf(inStep.map((s) => s.stages?.[k]))]));
      cell.httpStatus = inStep.at(-1)?.httpStatus ?? null;
    }
    if (lane === "dns" && inStep.length) {
      const answers = inStep.at(-1)?.answers;
      if (answers?.length) cell.resolvers = answers.map((a) => ({ resolver: a.resolver, ms: a.ms, rcode: a.rcode, ttlSec: a.ttlSec }));
    }
    cells.push(cell);
  }
  return cells;
}

function resolverSummaries(samples: LaneSample[], options: WindowOptions): { resolvers: ResolverSummary[]; expectedTtlSec: number | null } {
  const byResolver = new Map<string, DnsAnswer[]>();
  for (const s of samples) for (const a of s.answers ?? []) byResolver.set(a.resolver, [...(byResolver.get(a.resolver) ?? []), a]);
  const allTtls = [...byResolver.values()].flat().map((a) => a.ttlSec).filter(finite);
  const expectedTtlSec = allTtls.length ? Math.max(...allTtls) : null;
  const resolvers = [...byResolver.entries()].map(([resolver, answers]): ResolverSummary => {
    const stats = windowStats(answers.map((a) => ({ ok: a.ok, latencyMs: a.ms })), options);
    const errors: Partial<Record<DnsRcode, number>> = {};
    for (const a of answers) if (!a.ok) errors[a.rcode] = (errors[a.rcode] ?? 0) + 1;
    const ttls = answers.map((a) => a.ttlSec).filter(finite);
    const ttlMedian = median(ttls);
    return {
      resolver,
      answered: answers.filter((a) => a.ok).length,
      p50Ms: stats.p50Ms,
      p95Ms: stats.p95Ms,
      errors,
      lastTtlSec: [...answers].reverse().find((a) => finite(a.ttlSec))?.ttlSec ?? null,
      ttlDriftSec: expectedTtlSec !== null && ttlMedian !== null ? Math.max(0, expectedTtlSec - ttlMedian) : null,
    };
  });
  return { resolvers, expectedTtlSec };
}

function stageSummaries(samples: LaneSample[], size: number): { stages: StageSummary[]; blamed: StageSummary | null } {
  const ok = samples.filter((s) => s.ok);
  const stages = STAGE_KEYS.map((stage): StageSummary => {
    const values = ok.map((s) => s.stages?.[stage]).filter(finite);
    const currentMs = median(values.slice(-size));
    const baselineMs = median(values.slice(-100));
    return { stage, currentMs, baselineMs, ratio: currentMs !== null && baselineMs ? currentMs / baselineMs : null };
  });
  // A culpada: a etapa com maior crescimento acima de 1,5× e de pelo menos 10 ms (uma etapa de 1 ms que vai a 2 ms não é notícia).
  const blamed =
    stages
      .filter((s) => BLAME_STAGES.includes(s.stage) && s.ratio !== null && s.ratio >= 1.5 && (s.currentMs ?? 0) - (s.baselineMs ?? 0) >= 10)
      .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0] ?? null;
  return { stages, blamed };
}

/** Estado atual de uma faixa: o último passo com medição, desde que seja um dos 3 últimos. */
function currentState(cells: TimelineCell[]): CellState {
  for (let k = cells.length - 1; k >= Math.max(0, cells.length - 3); k--) if (cells[k].state !== "none") return cells[k].state;
  return "none";
}

const fmtMs = (ms: number | null | undefined) => (finite(ms) ? `${ms < 10 ? ms.toFixed(1).replace(".", ",") : Math.round(ms)} ms` : "—");
const fmtRatio = (r: number) => `${r.toFixed(1).replace(".", ",")}×`;

/** Frase de uma faixa num passo: "estável (12 ms)", "sem resposta", "lenta: p95 3,1× a base". */
export function describeCell(lane: LaneKey, cell: TimelineCell): string {
  if (cell.state === "none") return "sem medição";
  if (cell.state === "bad") return cell.error ? `falhou (${cell.error})` : "sem resposta";
  const parts: string[] = [];
  if (cell.failures) parts.push(`${cell.failures} de ${cell.samples} falharam`);
  if (cell.lossPct) parts.push(`perda de ${Math.round(cell.lossPct)}%`);
  if (cell.degraded && cell.p95Ms !== null && cell.baselineMs) parts.push(`p95 ${fmtRatio(cell.p95Ms / cell.baselineMs)} a base`);
  if (lane === "https" && cell.stages) {
    const s = cell.stages;
    parts.push(`DNS ${fmtMs(s.dnsMs)} · TCP ${fmtMs(s.connectMs)} · TLS ${fmtMs(s.tlsMs)} · TTFB ${fmtMs(s.ttfbMs)}`);
  } else if (lane === "dns" && cell.resolvers?.length) {
    parts.push(cell.resolvers.map((r) => `${r.resolver === "system" ? "sistema" : r.resolver} ${r.rcode === "NOERROR" ? fmtMs(r.ms) : r.rcode}`).join(" · "));
  } else {
    parts.push(fmtMs(cell.ms));
  }
  return `${cell.state === "ok" ? "estável" : "instável"}: ${parts.join(", ")}`;
}

/** Onde está o problema, pela primeira faixa ruim na ordem LAN → WAN → DNS → HTTPS. */
export function diagnose(states: Record<LaneKey, CellState>, blamed?: StageSummary | null, serviceName = "o serviço"): string {
  const first = LANE_ORDER.find((lane) => states[lane] === "bad" || states[lane] === "warn");
  if (!first) {
    if (LANE_ORDER.every((lane) => states[lane] === "none")) return "Ainda sem medições neste período.";
    return "As quatro leituras estão estáveis: LAN, WAN, DNS e HTTPS normais.";
  }
  const severe = states[first] === "bad";
  switch (first) {
    case "gateway":
      return severe ? "O gateway da LAN não responde: o problema está na rede local, antes da Internet." : "A LAN está instável (perda ou latência no gateway): comece pela rede local.";
    case "wan":
      return severe ? "LAN normal, mas a Internet não responde: o problema está na saída (operadora ou modem)." : "LAN normal, WAN instável: a saída para a Internet está com perda ou atraso.";
    case "dns":
      return severe ? `LAN e WAN normais, mas o nome de ${serviceName} não resolve: o problema é de DNS.` : `LAN e WAN normais; o DNS de ${serviceName} está lento ou falhando em parte.`;
    default: {
      const stage = blamed ? ` A etapa que mais cresceu foi ${STAGE_LABEL[blamed.stage]} (${fmtRatio(blamed.ratio ?? 1)} o normal, ${fmtMs(blamed.currentMs)}).` : "";
      const where = blamed?.stage === "ttfbMs" ? " O atraso é no servidor do serviço." : "";
      return severe ? `LAN, WAN e DNS normais, mas ${serviceName} não responde por HTTPS: o problema é do serviço.${stage}` : `LAN, WAN e DNS normais; o HTTPS de ${serviceName} está lento ou instável.${stage}${where}`;
    }
  }
}

/**
 * Monta a linha do tempo. `lanes` traz as medições de cada faixa (qualquer ordem; podem começar antes de
 * `start`, para a janela e a base já estarem cheias no primeiro passo).
 */
export function buildTimeline(
  lanes: Record<LaneKey, LaneInput>,
  range: { start: number; end: number; stepMs: number },
  options: WindowOptions & { serviceName?: string } = {},
): Timeline {
  const stepMs = Math.max(1000, range.stepMs);
  const first = Math.floor(range.start / stepMs) * stepMs;
  const steps: number[] = [];
  for (let t = first; t < range.end; t += stepMs) steps.push(t);
  const size = options.size ?? 20;

  const cells = {} as Record<LaneKey, TimelineCell[]>;
  const summary = {} as Record<LaneKey, LaneSummary>;
  for (const lane of LANE_ORDER) {
    const samples = [...lanes[lane].samples].filter((s) => s.at <= range.end).sort((a, b) => a.at - b.at);
    const rolling = rollingWindowStats(samples, options);
    cells[lane] = buildCells(samples, rolling, steps, stepMs, lane);
    const inRange = samples.filter((s) => s.at >= first);
    const base: LaneSummary = {
      lane,
      available: inRange.length > 0,
      source: lanes[lane].source,
      stats: windowStats(samples, options),
      failures: inRange.filter((s) => !s.ok).length,
      samples: inRange.length,
      state: currentState(cells[lane]),
    };
    if (lane === "dns") Object.assign(base, resolverSummaries(inRange, options));
    if (lane === "https") Object.assign(base, stageSummaries(samples, size));
    summary[lane] = base;
  }
  const states = Object.fromEntries(LANE_ORDER.map((l) => [l, summary[l].state])) as Record<LaneKey, CellState>;
  return { start: first, end: range.end, stepMs, steps, lanes: cells, summary, windowSize: size, diagnosis: diagnose(states, summary.https.blamed, options.serviceName) };
}
