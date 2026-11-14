"use client";

import type { SparkSeries } from "@/lib/global-status/series";
import { formatDateTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";

// Unidades do viewBox: a curva ocupa de PLOT_TOP a PLOT_BOTTOM; as falhas ficam numa faixa própria embaixo.
const HEIGHT = 32;
const PLOT_TOP = 2;
const PLOT_BOTTOM = 26;
const FAIL_TOP = 28;
/** Fundo de escala mínimo, em ms: uma linha parada em 1 ms não pode parecer ruído. */
const MIN_SCALE_MS = 5;
/** Folga acima do topo da escala, para o pico não encostar na borda. */
const HEADROOM = 1.15;
/**
 * A faixa do p95 estica a escala até este múltiplo da maior mediana; acima disso ela é cortada na borda.
 * Sem o limite, uma única medição lenta em 24 h (um SYN retransmitido leva 1 s) achataria a linha inteira.
 */
const BAND_LIMIT = 3;

interface Point {
  x: number;
  p50: number;
  p95: number;
}

/** Trechos contínuos de passos com valor: um passo sem amostra quebra a linha. */
function runsOf(series: SparkSeries): Point[][] {
  const runs: Point[][] = [];
  let current: { step: number; p50: number; p95: number }[] = [];
  const close = () => {
    if (!current.length) return;
    // Um passo isolado vira um traço da largura do passo; senão não apareceria.
    runs.push(
      current.length === 1
        ? [{ ...current[0], x: current[0].step }, { ...current[0], x: current[0].step + 1 }]
        : current.map((p) => ({ ...p, x: p.step + 0.5 })),
    );
    current = [];
  };
  series.p50.forEach((p50, step) => {
    if (p50 == null) return close();
    current.push({ step, p50, p95: Math.max(series.p95[step] ?? p50, p50) });
  });
  close();
  return runs;
}

/**
 * Latência ao longo do tempo: a linha é a mediana (p50), a faixa vai da mediana ao p95 e as marcas
 * embaixo são os passos com falha. Estica até o tamanho do elemento que o contém.
 */
export function Sparkline({ series, label, className }: { series: SparkSeries; label: string; className?: string }) {
  const width = Math.max(series.p50.length, series.fail.length, 1);
  const runs = runsOf(series);
  const points = runs.flat();
  const peakP50 = Math.max(0, ...points.map((p) => p.p50));
  const peakP95 = Math.max(0, ...points.map((p) => p.p95));
  const top = Math.max(Math.min(peakP95, peakP50 * BAND_LIMIT) * HEADROOM, MIN_SCALE_MS);
  const y = (ms: number) => Math.round((PLOT_BOTTOM - (Math.min(Math.max(ms, 0), top) / top) * (PLOT_BOTTOM - PLOT_TOP)) * 100) / 100;

  const line = runs.map((run) => run.map((p, n) => `${n ? "L" : "M"}${p.x} ${y(p.p50)}`).join(" ")).join(" ");
  const band = runs
    .map((run) => `M${run.map((p) => `${p.x} ${y(p.p95)}`).join(" L")} L${[...run].reverse().map((p) => `${p.x} ${y(p.p50)}`).join(" L")} Z`)
    .join(" ");

  const startMs = Date.parse(series.start);
  const failTitle = (count: number, step: number) => {
    const text = `${count.toLocaleString("pt-BR")} falha${count > 1 ? "s" : ""}`;
    return Number.isNaN(startMs) ? text : `${text} · ${formatDateTime(new Date(startMs + step * series.stepMin * 60_000))}`;
  };

  return (
    <svg viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" className={cn("w-full text-muted-foreground", className)} role="img" aria-label={label}>
      <line x1="0" y1={PLOT_BOTTOM} x2={width} y2={PLOT_BOTTOM} stroke="currentColor" opacity="0.2" vectorEffect="non-scaling-stroke" />
      {band && <path d={band} fill="currentColor" fillOpacity="0.2" className="text-primary" />}
      {line && <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className="text-primary" />}
      {series.fail.map((count, step) =>
        count > 0 ? (
          <rect key={step} x={step} y={FAIL_TOP} width="1" height={HEIGHT - FAIL_TOP} fill="currentColor" className="text-destructive">
            <title>{failTitle(count, step)}</title>
          </rect>
        ) : null,
      )}
    </svg>
  );
}
