"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { getProbeTimeline } from "@/app/actions/probe-timeline-actions";
import type { StatusServiceDetail } from "@/app/actions/global-status-actions";
import { Button } from "@/components/ui/button";
import { rcodeText, resolverLabel } from "@/lib/global-status/dns-composite-labels";
import { LANE_LABEL, LANE_ORDER, STAGE_LABEL, TIMELINE_HOURS, describeCell, type CellState, type LaneKey, type Timeline } from "@/lib/global-status/timeline";
import type { DnsRcode } from "@/lib/global-status/types";
import { cn } from "@/lib/utils";
import { formatLatency, formatPercent } from "./format";

/**
 * Linha do tempo NOC (fase 6) no detalhe do serviço: gateway, WAN, DNS e HTTPS no mesmo eixo de tempo.
 * Um ponto vermelho (tudo falhou) ou amarelo (falha parcial, perda ou p95 acima de 1,5× a base) mostra
 * em qual camada o problema está; tocar num passo mostra as quatro leituras daquele momento.
 * Mesmos blocos das outras seções do detalhe (título text-sm, caixa com borda, leituras em text-xs).
 */

const CELL_STYLE: Record<CellState, string> = {
  none: "bg-zinc-800",
  ok: "bg-emerald-500/70",
  warn: "bg-amber-500",
  bad: "bg-red-500",
};
const STATE_TEXT: Record<CellState, string> = {
  none: "text-muted-foreground",
  ok: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-red-400",
};

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const ratioText = (r: number | null) => (r === null ? "—" : `${r.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}×`);

function Reading({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label} <span className="font-medium text-foreground tabular-nums">{value}</span>
    </span>
  );
}

function LaneRow({ lane, timeline, selected, onSelect }: { lane: LaneKey; timeline: Timeline; selected: number | null; onSelect: (i: number) => void }) {
  const cells = timeline.lanes[lane];
  return (
    <div className="flex items-center gap-2">
      <span className={cn("w-24 shrink-0 truncate", STATE_TEXT[timeline.summary[lane].state])}>{LANE_LABEL[lane]}</span>
      <div className="flex h-4 min-w-0 flex-1 gap-px" role="img" aria-label={`${LANE_LABEL[lane]}: ${describeCell(lane, cells.at(-1)!)}`}>
        {cells.map((cell, i) => (
          <button
            key={i}
            type="button"
            title={`${timeOf(timeline.steps[i])} · ${describeCell(lane, cell)}`}
            onClick={() => onSelect(i)}
            className={cn("h-full min-w-0 flex-1 rounded-[1px]", CELL_STYLE[cell.state], selected === i && "ring-1 ring-foreground")}
          />
        ))}
      </div>
    </div>
  );
}

function StepDetail({ timeline, index }: { timeline: Timeline; index: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-2">
      <span className="font-medium text-foreground">
        {timeOf(timeline.steps[index])}–{timeOf(timeline.steps[index] + timeline.stepMs)}
      </span>
      {LANE_ORDER.map((lane) => {
        const cell = timeline.lanes[lane][index];
        return (
          <span key={lane} className="text-muted-foreground">
            <span className={STATE_TEXT[cell.state]}>{LANE_LABEL[lane]}</span> {describeCell(lane, cell)}
          </span>
        );
      })}
    </div>
  );
}

function LaneStats({ timeline }: { timeline: Timeline }) {
  return (
    <div className="flex flex-col gap-1.5">
      {LANE_ORDER.filter((lane) => timeline.summary[lane].available).map((lane) => {
        const { stats, source, series } = timeline.summary[lane];
        return (
          <div key={lane} className="flex flex-col gap-0.5">
            <span className="text-foreground">
              {LANE_LABEL[lane]} <span className="text-muted-foreground">· {source}{series && ` · estatística de ${series}, o destino em pior situação`}</span>
            </span>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
              <Reading label="p50" value={formatLatency(stats.p50Ms)} />
              <Reading label="p95" value={formatLatency(stats.p95Ms)} />
              <Reading label="p99" value={formatLatency(stats.p99Ms)} />
              <Reading label="jitter" value={formatLatency(stats.jitterMs)} />
              <Reading label="perda" value={formatPercent(stats.lossPct, 1)} />
              <Reading label="base" value={formatLatency(stats.baselineMs)} />
              {stats.degraded && <span className="text-amber-400">p95 {ratioText(stats.ratio)} a base</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DnsResolvers({ timeline }: { timeline: Timeline }) {
  const dns = timeline.summary.dns;
  if (!dns.resolvers?.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-foreground">
        DNS por resolvedor{dns.expectedTtlSec != null && <span className="text-muted-foreground"> · TTL esperado {dns.expectedTtlSec} s</span>}
      </span>
      {dns.resolvers.map((r) => {
        const errors = Object.entries(r.errors).map(([code, n]) => `${n}× ${rcodeText(code as DnsRcode)}`);
        return (
          <div key={r.resolver} className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
            <span className="w-28 shrink-0 truncate text-foreground">{resolverLabel(r.resolver)}</span>
            <Reading label="p50" value={formatLatency(r.p50Ms)} />
            <Reading label="p95" value={formatLatency(r.p95Ms)} />
            <Reading label="TTL" value={r.lastTtlSec == null ? "—" : `${r.lastTtlSec} s`} />
            {r.ttlDriftSec ? <Reading label="no cache há" value={`${Math.round(r.ttlDriftSec)} s`} /> : null}
            {errors.length > 0 && <span className="text-amber-400">{errors.join(", ")}</span>}
          </div>
        );
      })}
    </div>
  );
}

function HttpsStages({ timeline }: { timeline: Timeline }) {
  const https = timeline.summary.https;
  if (!https.stages) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-foreground">Etapas do HTTPS (mediana das últimas {timeline.windowSize} contra as últimas 100)</span>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
        {https.stages.map((s) => (
          <span key={s.stage} className={cn(https.blamed?.stage === s.stage && "text-amber-400")}>
            {STAGE_LABEL[s.stage]} <span className="font-medium text-foreground tabular-nums">{formatLatency(s.currentMs)}</span> ({ratioText(s.ratio)})
          </span>
        ))}
      </div>
    </div>
  );
}

export function ProbeTimeline({ slug, vantages }: { slug: string; vantages: StatusServiceDetail["vantages"] }) {
  const [hours, setHours] = useState(3);
  const [vantage, setVantage] = useState("server");
  const [selected, setSelected] = useState<number | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["probe-timeline", slug, hours, vantage],
    queryFn: () => getProbeTimeline({ slug, hours, vantage }),
    refetchInterval: 60_000,
  });
  const timeline = data?.timeline ?? null;
  const points = vantages?.rows ?? [];

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Linha do tempo</h3>
        <div className="flex gap-1">
          {TIMELINE_HOURS.map((h) => (
            <Button
              key={h}
              variant={h === hours ? "secondary" : "ghost"}
              size="xs"
              onClick={() => {
                setHours(h);
                setSelected(null);
              }}
            >
              {h} h
            </Button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Gateway, WAN, DNS e HTTPS no mesmo relógio. A primeira faixa vermelha ou amarela, de cima para baixo, é por onde começar.</p>
      {points.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {points.map((p) => (
            <Button
              key={p.id}
              variant={p.id === vantage ? "secondary" : "ghost"}
              size="xs"
              onClick={() => {
                setVantage(p.id);
                setSelected(null);
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>
      )}
      {isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {data && !timeline && <p className="text-xs text-muted-foreground">Sem linha do tempo: {data.reason}.</p>}
      {timeline && (
        <div className="flex flex-col gap-3 rounded-lg border p-3 text-xs">
          <p className="text-foreground">{timeline.diagnosis}</p>
          <div className="flex flex-col gap-1.5">
            {LANE_ORDER.map((lane) => (
              <LaneRow key={lane} lane={lane} timeline={timeline} selected={selected} onSelect={setSelected} />
            ))}
            <div className="flex justify-between pl-26 text-muted-foreground tabular-nums">
              <span>{timeOf(timeline.start)}</span>
              <span>{timeOf(timeline.start + (timeline.end - timeline.start) / 2)}</span>
              <span>agora</span>
            </div>
          </div>
          {selected !== null && selected < timeline.steps.length && <StepDetail timeline={timeline} index={selected} />}
          <LaneStats timeline={timeline} />
          <DnsResolvers timeline={timeline} />
          <HttpsStages timeline={timeline} />
          <p className="text-muted-foreground">
            Janela de {timeline.windowSize} medições; amarelo quando o p95 passa de 1,5× a mediana das 100 medições anteriores e da variação
            normal delas. A mesma regra deixa o card do serviço degradado e entra no alerta por e-mail.
          </p>
        </div>
      )}
    </section>
  );
}
