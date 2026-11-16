"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Route } from "lucide-react";
import { traceServiceRoute, type StatusRouteDetail, type StatusServiceDetail } from "@/app/actions/global-status-actions";
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
 * etapas do HTTP ao longo do dia e a rota até o destino (fase 5). Mesmos blocos e tipografia das seções que
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

const VERDICT: Record<string, { label: string; className: string }> = {
  DOMESTIC: { label: "Servido no Brasil", className: "text-emerald-400" },
  CDN_EDGE: { label: "Servido pela borda do CDN no Brasil", className: "text-emerald-400" },
  OPERATOR_CACHE: { label: "Cache na sua operadora", className: "text-emerald-400" },
  INTERNATIONAL: { label: "Servido de fora do Brasil", className: "text-sky-400" },
  UNDETERMINED: { label: "Origem indefinida", className: "text-muted-foreground" },
};
const CONFIDENCE: Record<string, string> = { HIGH: "alta", MEDIUM: "média", LOW: "baixa" };
const ROLE: Record<string, string> = { PEERING: "peering", IX: "IX", INTL_EDGE: "borda internacional", CORE: "núcleo", AGGREGATION: "agregação", ACCESS: "acesso" };
const MODE: Record<string, string> = { udp: "UDP", paris: "UDP com fluxo fixo (Paris)", tcp: "TCP 443", union: "UDP, Paris e TCP 443 juntos" };

/** Rota que parou antes do destino: o último roteador que respondeu, e o que a sonda TCP diz do destino. */
function silenceText(route: StatusRouteDetail): string | null {
  if (route.reached || route.lastVisibleTtl === null) return null;
  const hop = route.hops.find((h) => h.ttl === route.lastVisibleTtl);
  if (!hop) return null;
  const name = hop.rdns ?? hop.ip ?? `salto ${hop.ttl}`;
  const where = hop.city ? ` (${hop.city})` : "";
  const dest = route.destRttMs !== null ? `; o destino responde no TCP em ${formatLatency(route.destRttMs)}` : "";
  return `Depois de ${name}${where} os roteadores não respondem ao rastreio, o que é comum depois da borda dos CDNs${dest}.`;
}

type RouteHopRow = StatusRouteDetail["hops"][number];

/** Saltos seguidos do mesmo ASN viram um grupo; os sem ASN público (rede local, CGNAT) ficam juntos. */
function groupByAsn(hops: RouteHopRow[]): { key: string; label: string; hops: RouteHopRow[] }[] {
  const groups: { key: string; label: string; hops: RouteHopRow[] }[] = [];
  for (const hop of hops) {
    const label = hop.asn ? `AS${hop.asn}${hop.asName ? ` · ${hop.asName}` : ""}` : hop.ip ? "Sem ASN público" : "Sem resposta";
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.hops.push(hop);
    else groups.push({ key: `${hop.ttl}`, label, hops: [hop] });
  }
  return groups;
}

const SEGMENT_COLORS = ["bg-zinc-500", "bg-emerald-500/70", "bg-sky-500/70", "bg-violet-500/70", "bg-amber-500/70", "bg-rose-500/70"];

/**
 * Rota em trechos (fase 9): quanto do tempo de ida e volta cada rede soma, pelo "piso" do RTT (o menor
 * RTT dali até o fim, que não sobe com os roteadores lentos para responder ao rastreio).
 */
export function routeSegments(hops: RouteHopRow[], destRttMs: number | null): { label: string; ms: number }[] {
  const floors = new Map<number, number>();
  let min = destRttMs ?? Infinity;
  for (let i = hops.length - 1; i >= 0; i--) {
    if (hops[i].rttMs !== null) min = Math.min(min, hops[i].rttMs!);
    floors.set(hops[i].ttl, min);
  }
  let prev = 0;
  const out: { label: string; ms: number }[] = [];
  for (const group of groupByAsn(hops)) {
    if (group.label === "Sem resposta") continue;
    const end = floors.get(group.hops[group.hops.length - 1].ttl) ?? Infinity;
    if (!Number.isFinite(end)) continue;
    const label = group.label === "Sem ASN público" ? (out.length ? "Sem ASN público" : "Rede local e CGNAT") : group.label.replace(/^AS\d+ · /, "");
    out.push({ label, ms: Math.max(0, Math.round((end - prev) * 10) / 10) });
    prev = Math.max(prev, end);
  }
  if (destRttMs !== null && destRttMs > prev + 0.5) out.push({ label: "Até o destino", ms: Math.round((destRttMs - prev) * 10) / 10 });
  return out;
}

function SegmentBar({ route }: { route: StatusRouteDetail }) {
  const segments = routeSegments(route.hops, route.destRttMs);
  const total = segments.reduce((sum, s) => sum + s.ms, 0);
  if (segments.length < 2 || total <= 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-2 overflow-hidden rounded-full" role="img" aria-label={segments.map((s) => `${s.label} ${formatLatency(s.ms)}`).join(", ")}>
        {segments.map((s, i) => (
          <span key={`${s.label}-${i}`} className={SEGMENT_COLORS[i % SEGMENT_COLORS.length]} style={{ width: `${Math.max(2, (s.ms / total) * 100)}%` }} title={`${s.label}: ${formatLatency(s.ms)}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
        {segments.map((s, i) => (
          <span key={`${s.label}-${i}`} className="inline-flex items-center gap-1">
            <span className={cn("size-2 rounded-full", SEGMENT_COLORS[i % SEGMENT_COLORS.length])} />
            {s.label} <span className="tabular-nums text-foreground">{formatLatency(s.ms)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function PathHistory({ route }: { route: StatusRouteDetail }) {
  if (route.history.length < 2) return null;
  return (
    <div className="flex flex-col gap-1 border-t pt-2">
      <span className="font-medium text-foreground">Caminho nos últimos 7 dias</span>
      <ol className="flex flex-col gap-0.5 text-muted-foreground">
        {route.history.map((h, i) => (
          <li key={h.from} className="flex justify-between gap-3">
            <span className="min-w-0 truncate" title={h.asPath ? `ASNs ${h.asPath}` : undefined}>
              {h.place}
              {h.asPath ? ` · AS ${h.asPath.replaceAll(" ", " → ")}` : ""}
            </span>
            <span className="shrink-0 tabular-nums">
              {formatDateTime(h.from)}
              {i === 0 ? " até agora" : ` a ${formatDateTime(h.to)}`}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Rota até o destino (fase 5): a rota gravada mais nova (o servidor rastreia cada serviço a cada 30 min),
 * com onde o serviço é servido, o cabo submarino provável e os saltos agrupados por ASN.
 */
export function RouteSection({ slug, route }: { slug: string; route: StatusRouteDetail | null }) {
  const canTrace = useCan("network.operate");
  const queryClient = useQueryClient();
  const trace = useMutation({
    mutationFn: async () => {
      const result = await traceServiceRoute(slug);
      if (!result) throw new Error("Sem traceroute no servidor ou serviço sem destino para rastrear.");
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["global-status-detail", slug] }),
  });
  const current = trace.data ?? route;
  const verdict = current ? (VERDICT[current.verdict] ?? VERDICT.UNDETERMINED) : null;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Rota até o destino</h3>
        {canTrace && (
          <Button variant="outline" size="xs" onClick={() => trace.mutate()} disabled={trace.isPending}>
            {trace.isPending ? <Loader2 className="size-3 animate-spin" /> : <Route className="size-3" />}
            {trace.isPending ? "Rastreando…" : current ? "Rastrear de novo" : "Rastrear rota"}
          </Button>
        )}
      </div>
      {!current && !trace.isPending && (
        <p className="text-xs text-muted-foreground">
          O servidor rastreia a rota de cada serviço a cada 30 minutos. {canTrace ? "Para ver agora, rastreie: com os três tipos de sonda leva até três minutos." : ""}
        </p>
      )}
      {trace.isError && <p className="text-xs text-destructive">{trace.error.message}</p>}
      {current && verdict && (
        <div className="flex flex-col gap-2 rounded-lg border p-3 text-xs">
          <div className="flex items-start justify-between gap-3">
            <span className={cn("font-medium", verdict.className)}>{verdict.label}</span>
            <span className="shrink-0 text-muted-foreground" title={formatDateTime(current.at)}>
              {formatRelativeTime(current.at)}
            </span>
          </div>
          {/* O cabo, a confiança e os outros candidatos aparecem logo abaixo, em leituras: a frase para antes deles. */}
          <p className="text-muted-foreground">{current.cableName ? current.summary.split(" Cabo provável:")[0] : current.summary}</p>
          {(current.edge || current.interconnections.length > 0) && (
            <div className="flex flex-col gap-1 text-muted-foreground">
              {current.edge && (
                <InlineReading
                  label="Borda que atendeu o HTTP"
                  value={`${current.edge.provider}${current.edge.city ? ` em ${current.edge.city}` : ""}${current.edge.pop ? ` (${current.edge.pop})` : ""}`}
                />
              )}
              {current.interconnections.map((text) => (
                <InlineReading key={text} label="Interconexão" value={text} />
              ))}
            </div>
          )}
          {current.cableName && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
              <InlineReading label="Cabo provável" value={current.cableName} />
              {current.confidence && <InlineReading label="Confiança" value={CONFIDENCE[current.confidence] ?? current.confidence} />}
              {current.candidates.length > 0 && <InlineReading label="Outros possíveis" value={current.candidates.join(", ")} />}
            </div>
          )}
          <SegmentBar route={current} />
          {current.hops.length > 0 && (
            <ol className="flex flex-col gap-2 border-t pt-2">
              {groupByAsn(current.hops).map((group) => (
                <li key={group.key} className="flex flex-col gap-1">
                  <span className="truncate font-medium text-foreground">{group.label}</span>
                  <ol className="flex flex-col gap-0.5">
                    {group.hops.map((hop) => (
                      <li key={hop.ttl} className="flex items-center gap-3 tabular-nums">
                        <span className="w-5 shrink-0 text-right text-muted-foreground">{hop.ttl}</span>
                        <span className={cn("min-w-0 flex-1 truncate", hop.ip ? "text-foreground" : "text-muted-foreground")} title={hop.rdns && hop.ip ? hop.ip : undefined}>
                          {hop.rdns ?? hop.ip ?? "sem resposta"}
                        </span>
                        {hop.altIps.length > 0 && (
                          <span className="shrink-0 text-muted-foreground" title={[hop.ip, ...hop.altIps].join("\n")}>
                            {hop.altIps.length + 1} caminhos
                          </span>
                        )}
                        {hop.role && <span className="shrink-0 text-muted-foreground">{ROLE[hop.role] ?? hop.role}</span>}
                        {hop.city && <span className="shrink-0 text-muted-foreground">{hop.city}</span>}
                        <span className="w-14 shrink-0 text-right text-muted-foreground">{formatLatency(hop.rttMs)}</span>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          )}
          {silenceText(current) && <p className="text-muted-foreground">{silenceText(current)}</p>}
          <PathHistory route={current} />
          <div className="border-t pt-2 text-muted-foreground">
            {current.host}
            {current.destIp && current.destIp !== current.host ? ` (${current.destIp})` : ""} · {current.hops.length} salto{current.hops.length === 1 ? "" : "s"} ·{" "}
            {current.reached ? "destino alcançado" : "o destino não respondeu ao rastreio"}
            {current.destRttMs !== null && <> · {formatLatency(current.destRttMs)} até o destino</>}
            {current.mode && MODE[current.mode] && <> · sondas {MODE[current.mode]}</>}
          </div>
        </div>
      )}
      {current?.cableName && (
        <p className="text-xs text-muted-foreground">
          Inferência pela rota e pelo tempo de resposta: o traceroute só enxerga roteadores, não o cabo. Dados dos cabos:{" "}
          <a href={current.cableSource} target="_blank" rel="noreferrer" className="hover:underline">
            TeleGeography, Submarine Cable Map
          </a>
          .
        </p>
      )}
    </section>
  );
}
