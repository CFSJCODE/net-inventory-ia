"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2, Route } from "lucide-react";
import { traceServiceRoute, type StatusServiceDetail } from "@/app/actions/global-status-actions";
import { useCan } from "@/components/auth/user-provider";
import { Button } from "@/components/ui/button";
import type { PhaseSeries } from "@/lib/global-status/series";
import { formatDateTime, formatRelativeTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import { formatLatency, formatUptime } from "./format";
import { Sparkline, sparkScaleTop } from "./sparkline";
import { HTTP_PHASE_STYLE, SERVICE_STATUS_STYLE } from "./status-style";

/**
 * Seções da fase 3 no detalhe do serviço: o mesmo alvo medido do servidor e do PC (agente Windows), as
 * etapas do HTTP ao longo do dia e o traceroute sob demanda. Mesmos blocos e tipografia das seções que
 * já existem no detalhe (título text-sm, caixas com borda, leituras em text-xs).
 */

function InlineReading({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label} <span className="font-medium text-foreground tabular-nums">{value}</span>
    </span>
  );
}

/** Uma linha por ponto de medição do alvo principal: o servidor e cada PC com o agente. */
export function VantageList({ vantages }: { vantages: NonNullable<StatusServiceDetail["vantages"]> }) {
  const agents = vantages.rows.filter((row) => !row.server).length;
  // Mesma escala em todos os pontos: a diferença de altura entre os gráficos é a diferença de latência.
  const tops = vantages.rows.flatMap((row) => (row.spark ? [sparkScaleTop(row.spark)] : []));
  const scaleTopMs = tops.length ? Math.max(...tops) : undefined;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Do servidor e do seu PC</h3>
      <p className="text-xs text-muted-foreground">
        {vantages.targetLabel} medido de cada ponto. Os dois saem pela mesma Internet: quando só um piora, o problema está perto dele.
      </p>
      {vantages.rows.map((row) => (
        <div key={row.id} className="flex flex-col gap-2 rounded-lg border p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium text-foreground">{row.label}</span>
            {row.lastAt && (
              <span className="shrink-0 text-muted-foreground" title={formatDateTime(row.lastAt)}>
                medido {formatRelativeTime(row.lastAt)}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
            <InlineReading label="mediana 24 h" value={formatLatency(row.p50Ms)} />
            <InlineReading label="p95 24 h" value={formatLatency(row.p95Ms)} />
            <InlineReading label="disponibilidade 24 h" value={formatUptime(row.uptime24h)} />
            <InlineReading label="30 dias" value={formatUptime(row.uptime30d)} />
          </div>
          {row.spark ? (
            <Sparkline series={row.spark} label={`Latência de ${vantages.targetLabel} medida de ${row.label} nas últimas 24 h`} className="h-10" scaleTopMs={scaleTopMs} />
          ) : (
            <p className="text-muted-foreground">Coletando medições…</p>
          )}
        </div>
      ))}
      {agents === 0 && (
        <p className="text-xs text-muted-foreground">
          Nenhum PC medindo este serviço ainda. Com o agente Windows atualizado, o PC passa a medir os mesmos destinos a cada minuto.
        </p>
      )}
    </section>
  );
}

// Unidades do viewBox do gráfico de etapas: uma coluna por passo.
const PHASE_HEIGHT = 40;

/** Etapas do HTTP empilhadas, uma coluna por passo de 30 min: onde o tempo foi gasto ao longo do dia. */
export function PhaseChart({ phases }: { phases: PhaseSeries }) {
  const steps = phases.dnsMs.length;
  const columns = Array.from({ length: steps }, (_, step) => HTTP_PHASE_STYLE.map((p) => Math.max(phases[p.key][step] ?? 0, 0)));
  const totals = columns.map((parts) => parts.reduce((sum, v) => sum + v, 0));
  const peak = Math.max(...totals, 1);
  const startMs = Date.parse(phases.start);
  const medians = HTTP_PHASE_STYLE.map((p, index) => {
    const values = columns.map((parts) => parts[index]).filter((v) => v > 0).sort((a, b) => a - b);
    return { ...p, ms: values.length ? values[Math.floor(values.length / 2)] : null };
  });
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Etapas do HTTP (24 h)</h3>
      <div className="rounded-lg border p-3 text-xs">
        <svg viewBox={`0 0 ${Math.max(steps, 1)} ${PHASE_HEIGHT}`} preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label="Tempo de DNS, TCP, TLS e servidor do HTTP nas últimas 24 h, a cada 30 min">
          {columns.map((parts, step) => {
            let y = PHASE_HEIGHT;
            const title = Number.isNaN(startMs) ? "" : formatDateTime(new Date(startMs + step * phases.stepMin * 60_000));
            return (
              <g key={step}>
                {title && <title>{`${title} · ${formatLatency(totals[step] || null)}`}</title>}
                {parts.map((ms, index) => {
                  if (ms <= 0) return null;
                  const h = (ms / peak) * PHASE_HEIGHT;
                  y -= h;
                  // O intervalo entre as colunas e as parcelas separa as cores vizinhas, como na barra da última medição.
                  return <rect key={index} x={step + 0.1} y={y} width={0.8} height={Math.max(h - 0.3, 0.2)} className={HTTP_PHASE_STYLE[index].fill} />;
                })}
              </g>
            );
          })}
        </svg>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          {medians.map((p) => (
            <span key={p.key} className="flex items-center gap-1.5">
              <span className={cn("h-1.5 w-3 shrink-0 rounded-full", p.bar)} />
              <InlineReading label={`${p.label} mediana`} value={formatLatency(p.ms)} />
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/** A rota BGP do endereço medido, na última coleta do RIPEstat (uma vez por hora). */
export function BgpRoute({ bgp }: { bgp: NonNullable<StatusServiceDetail["bgp"]> }) {
  const style = SERVICE_STATUS_STYLE[bgp.status];
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Rota BGP</h3>
      <div className="flex items-start justify-between gap-3 rounded-lg border p-3 text-xs">
        <span className="min-w-0 break-words tabular-nums text-foreground">{bgp.text}</span>
        <span className={cn("shrink-0", style.text)}>{bgp.status === "OK" ? "Visível" : style.label}</span>
      </div>
      <p className="text-xs text-muted-foreground">Prefixo anunciado e quantos coletores do RIPE RIS, espalhados pelo mundo, enxergam essa rota.</p>
    </section>
  );
}

/** Traceroute sob demanda do servidor até o destino. O resultado não fica gravado. */
export function RouteSection({ slug }: { slug: string }) {
  const canTrace = useCan("network.operate");
  const trace = useMutation({ mutationFn: () => traceServiceRoute(slug) });
  const result = trace.data;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Rota até o destino</h3>
        {canTrace && (
          <Button variant="outline" size="xs" onClick={() => trace.mutate()} disabled={trace.isPending}>
            {trace.isPending ? <Loader2 className="size-3 animate-spin" /> : <Route className="size-3" />}
            {trace.isPending ? "Rastreando…" : result ? "Rastrear de novo" : "Rastrear rota"}
          </Button>
        )}
      </div>
      {!result && !trace.isPending && (
        <p className="text-xs text-muted-foreground">
          {canTrace ? "Mostra cada roteador entre o servidor e o destino. Leva até um minuto." : "Só quem opera a rede pode rastrear a rota."}
        </p>
      )}
      {trace.isError && <p className="text-xs text-destructive">Não foi possível rastrear a rota agora.</p>}
      {result && !result.ok && <p className="text-xs text-amber-400">{result.error}</p>}
      {result && result.ok && (
        <div className="rounded-lg border p-3 text-xs">
          <div className="mb-2 text-muted-foreground">
            {result.host} · {result.hops.length} salto{result.hops.length === 1 ? "" : "s"} · {result.reached ? "destino alcançado" : "o destino não respondeu ao rastreio"}
          </div>
          <ol className="flex flex-col gap-1">
            {result.hops.map((hop) => (
              <li key={hop.ttl} className="flex items-center gap-3 tabular-nums">
                <span className="w-5 shrink-0 text-right text-muted-foreground">{hop.ttl}</span>
                <span className={cn("min-w-0 flex-1 truncate", hop.ip ? "text-foreground" : "text-muted-foreground")}>{hop.ip ?? "sem resposta"}</span>
                <span className="shrink-0 text-muted-foreground">{formatLatency(hop.rttMs)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
