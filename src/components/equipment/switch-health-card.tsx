"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCan } from "@/components/auth/user-provider";
import { Field, SimpleSelect } from "@/components/tools/tool-shell";
import { getSwitchHealth, updateSwitchHealthSettings, type SwitchHealthView } from "@/app/actions/switch-health-actions";
import { portHealth, type Correlation, type PortHealth, type PortRates } from "@/lib/network/switch-health/counters";
import type { SeriesPoint, SwitchHealthRange } from "@/lib/network/switch-health/series";
import type { SwitchHealthSettings } from "@/lib/network/switch-health/settings";
import type { ToolResult } from "@/app/actions/tool-actions";

async function unwrap<T>(promise: Promise<ToolResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

const RANGES: Record<`${SwitchHealthRange}`, string> = { "1": "Última hora", "6": "Últimas 6 h", "24": "Últimas 24 h", "168": "Últimos 7 dias" };

const HEALTH_STYLE: Record<PortHealth, string> = {
  ok: "border-emerald-900 bg-emerald-950 text-emerald-400",
  warning: "border-amber-900 bg-amber-950 text-amber-400",
  critical: "border-red-900 bg-red-950 text-red-400",
  unknown: "border-border text-muted-foreground",
};
const HEALTH_LABEL: Record<PortHealth, string> = { ok: "Sem erros", warning: "Atenção", critical: "Erros acima do limite", unknown: "Aguardando leitura" };

const fmt = (n: number | null, digits = 1) => (n === null ? "—" : n.toLocaleString("pt-BR", { maximumFractionDigits: digits }));
function fmtBps(bps: number | null): string {
  if (bps === null) return "—";
  if (bps >= 1e9) return `${fmt(bps / 1e9, 2)} Gbps`;
  if (bps >= 1e6) return `${fmt(bps / 1e6, 1)} Mbps`;
  if (bps >= 1e3) return `${fmt(bps / 1e3, 0)} kbps`;
  return `${fmt(bps, 0)} bps`;
}
const time = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dateTime = (ms: number) => new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: PortHealth }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-2xl font-semibold tabular-nums", tone === "critical" && "text-red-400", tone === "warning" && "text-amber-400")}>{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- gráfico

const W = 720;
const H = 160;
const PLOT_H = 140;

/**
 * Erros por minuto (barras, escala da esquerda) e latência à switch e ao gateway (linhas, escala da
 * direita) no mesmo relógio: um pico de latência junto com uma barra aponta para a porta com erro.
 */
function HealthChart({ points, from, to, threshold }: { points: SeriesPoint[]; from: number; to: number; threshold: number }) {
  const span = Math.max(1, to - from);
  const x = (at: number) => ((at - from) / span) * W;
  const maxErr = Math.max(threshold * 1.2, ...points.map((p) => Math.max(p.errorsPerMin ?? 0, p.crcPerMin ?? 0)), 1);
  const maxLat = Math.max(5, ...points.map((p) => Math.max(p.latencyMs ?? 0, p.gatewayLatencyMs ?? 0))) * 1.15;
  const yErr = (v: number) => PLOT_H - (v / maxErr) * PLOT_H;
  const yLat = (v: number) => PLOT_H - (v / maxLat) * PLOT_H;
  const barW = Math.max(1.5, (W / Math.max(points.length, 1)) * 0.7);
  const line = (key: "latencyMs" | "gatewayLatencyMs") => {
    const segs: string[] = [];
    let open = false;
    for (const p of points) {
      const v = p[key];
      if (v === null) { open = false; continue; }
      segs.push(`${open ? "L" : "M"}${x(p.at).toFixed(1)},${yLat(v).toFixed(1)}`);
      open = true;
    }
    return segs.join(" ");
  };

  if (!points.length) {
    return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Ainda sem rodadas gravadas nesta janela. O coletor grava a primeira taxa um intervalo depois de começar.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>erros/min (máx. {fmt(maxErr, 0)})</span>
        <span>latência (máx. {fmt(maxLat, 0)} ms)</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-40 w-full rounded-md border bg-muted/20" role="img" aria-label="Erros de interface por minuto e latência">
        <line x1={0} x2={W} y1={yErr(threshold)} y2={yErr(threshold)} className="stroke-red-500/50" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        {points.map((p) => {
          const v = p.errorsPerMin ?? 0;
          if (v <= 0) return null;
          return (
            <rect key={p.at} x={x(p.at)} y={yErr(v)} width={barW} height={PLOT_H - yErr(v)} className={v >= threshold ? "fill-red-500/80" : "fill-amber-500/80"}>
              <title>{`${dateTime(p.at)}: ${fmt(v)} erros/min, CRC ${fmt(p.crcPerMin)}/min, latência ${fmt(p.latencyMs)} ms`}</title>
            </rect>
          );
        })}
        <path d={line("gatewayLatencyMs")} fill="none" className="stroke-violet-400" strokeWidth={1.5} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />
        <path d={line("latencyMs")} fill="none" className="stroke-sky-400" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{dateTime(from)}</span>
        <span>{time(to)}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-amber-500/80" /> Erros/min</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-red-500/80" /> Acima do limite</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-sky-400" /> Latência até a switch</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 border-t border-dashed border-violet-400" /> Latência até o gateway</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- correlação

const VERDICT: Record<Correlation["verdict"], string> = {
  insufficient: "Poucas rodadas para concluir (mínimo 10).",
  none: "Sem relação: a latência não acompanha os erros.",
  inverse: "Relação inversa: a latência cai quando os erros sobem, então os erros não explicam a latência.",
  weak: "Relação fraca entre erros e latência.",
  moderate: "Relação moderada: os erros parecem pesar na latência.",
  strong: "Relação forte: a latência sobe junto com os erros.",
};

function CorrelationBlock({ title, c }: { title: string; c: Correlation }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3">
      <span className="text-xs text-muted-foreground">{title}</span>
      <span className="text-lg font-semibold tabular-nums">r = {c.r === null ? "—" : c.r.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      <span className="text-sm">{VERDICT[c.verdict]}</span>
      <span className="text-xs text-muted-foreground">
        {c.minutesWithErrors > 0
          ? `Latência média de ${fmt(c.latencyWithErrorsMs)} ms nas ${c.minutesWithErrors} rodadas com erro e de ${fmt(c.latencyWithoutErrorsMs)} ms nas demais (${c.samples} rodadas).`
          : `${c.samples} rodadas com latência medida, nenhuma com erro.`}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- configuração

function SettingsForm({ settings }: { settings: SwitchHealthSettings }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const save = useMutation({
    mutationFn: () => unwrap(updateSwitchHealthSettings(draft)),
    onSuccess: () => {
      toast.success("Configuração salva");
      queryClient.invalidateQueries({ queryKey: ["switch-health"] });
    },
    onError: (err) => toast.error(err.message),
  });
  const num = (key: "intervalSec" | "errorsPerMin" | "discardsPerMin") => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: Number(e.target.value) });

  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Coletor" htmlFor="sh-enabled" className="sm:w-40">
        <SimpleSelect id="sh-enabled" value={draft.enabled ? "on" : "off"} onChange={(v) => setDraft({ ...draft, enabled: v === "on" })} options={{ on: "Ligado", off: "Desligado" }} />
      </Field>
      <Field label="Intervalo (s)" htmlFor="sh-interval" className="sm:w-32">
        <Input id="sh-interval" type="number" min={30} max={900} value={draft.intervalSec} onChange={num("intervalSec")} />
      </Field>
      <Field label="Alerta: erros/min numa porta" htmlFor="sh-errors" className="sm:w-52">
        <Input id="sh-errors" type="number" min={1} value={draft.errorsPerMin} onChange={num("errorsPerMin")} />
      </Field>
      <Field label="Atenção: descartes/min" htmlFor="sh-discards" className="sm:w-44">
        <Input id="sh-discards" type="number" min={1} value={draft.discardsPerMin} onChange={num("discardsPerMin")} />
      </Field>
      <Button type="submit" disabled={save.isPending} className="w-fit">
        {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Salvar
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------- portas

function PortsTable({ view }: { view: SwitchHealthView }) {
  const t = view.settings;
  const live = new Map((view.latest?.ports ?? []).map((p) => [p.ifIndex, p]));
  const windowByPort = new Map(view.ports.map((p) => [p.ifIndex, p]));
  // Portas com link ou com algo contado na janela; as com erro primeiro.
  const rows = useMemo(() => {
    const ids = new Set<number>([...view.ports.map((p) => p.ifIndex), ...(view.latest?.ports ?? []).filter((p) => p.operUp).map((p) => p.ifIndex)]);
    return Array.from(ids)
      .map((id) => ({ id, live: live.get(id) ?? null, win: windowByPort.get(id) ?? null }))
      .sort((a, b) => (b.win ? b.win.inErrors + b.win.outErrors : 0) - (a.win ? a.win.inErrors + a.win.outErrors : 0) || (b.live?.errorsPerMin ?? 0) - (a.live?.errorsPerMin ?? 0) || a.id - b.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  if (!rows.length) return <p className="text-sm text-muted-foreground">Nenhuma porta com link ou com contagem nesta janela.</p>;

  const health = (p: PortRates | null) => (p ? portHealth(p, t) : "unknown");
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Porta</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead className="text-right">Erros/min</TableHead>
            <TableHead className="text-right">CRC/min</TableHead>
            <TableHead className="text-right">Descartes/min</TableHead>
            <TableHead className="text-right">Entrada</TableHead>
            <TableHead className="text-right">Saída</TableHead>
            <TableHead className="text-right">Uso</TableHead>
            <TableHead className="text-right">Erros na janela</TableHead>
            <TableHead className="text-right">CRC na janela</TableHead>
            <TableHead className="text-right">Pior minuto</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ id, live: p, win }) => {
            const h = health(p);
            return (
              <TableRow key={id}>
                <TableCell className="font-mono text-xs">{p?.name ?? win?.name ?? id}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={cn("font-normal", HEALTH_STYLE[h])}>{p && !p.operUp ? "Sem link" : HEALTH_LABEL[h]}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmt(p?.errorsPerMin ?? null)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(p?.crcPerMin ?? null)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(p?.discardsPerMin ?? null)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtBps(p?.inBps ?? null)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtBps(p?.outBps ?? null)}</TableCell>
                <TableCell className="text-right tabular-nums">{p?.utilPct != null ? `${fmt(p.utilPct)}%` : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{win ? fmt(win.inErrors + win.outErrors, 0) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{win ? fmt(win.crcErrors, 0) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{win ? fmt(win.peakErrorsPerMin) : "—"}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------- seção

/** Seção "Switch Health": erros de interface por porta ao longo do tempo, ao lado da latência. */
export function SwitchHealthCard({ equipmentId }: { equipmentId: string }) {
  const canManage = useCan("settings.manage");
  const [range, setRange] = useState<`${SwitchHealthRange}`>("1");
  const query = useQuery({
    queryKey: ["switch-health", equipmentId, range],
    queryFn: () => unwrap(getSwitchHealth(equipmentId, Number(range))),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });
  const view = query.data;
  const latest = view?.latest ?? null;
  const worst: PortHealth = latest && view
    ? latest.ports.reduce<PortHealth>((acc, p) => {
        const h = portHealth(p, view.settings);
        const rank = { unknown: 0, ok: 1, warning: 2, critical: 3 };
        return rank[h] > rank[acc] ? h : acc;
      }, "unknown")
    : "unknown";
  const to = Date.now();
  const from = to - Number(range) * 3_600_000;
  // Só se mostra para switches: impressoras e roteadores sem porta física não entram no coletor.
  const isSwitch = !!view && (view.samples > 0 || (latest?.ports.length ?? 0) > 0 || !!latest?.error);

  // Impressora, roteador sem porta física ou equipamento ainda não lido: a seção não se aplica.
  if (!view || !isSwitch) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" />
            Switch Health
            {latest && !latest.error && <Badge variant="outline" className={cn("font-normal", HEALTH_STYLE[worst])}>{HEALTH_LABEL[worst]}</Badge>}
          </CardTitle>
          <CardDescription>
            Erros de interface (IF-MIB), CRC e descartes de cada porta, lidos a cada {view?.settings.intervalSec ?? 60} s, ao lado da latência até a switch e até o gateway no mesmo instante.
          </CardDescription>
        </div>
        <Field label="Janela" htmlFor={`sh-range-${equipmentId}`}>
          <SimpleSelect id={`sh-range-${equipmentId}`} value={range} onChange={setRange} options={RANGES} className="sm:w-44" />
        </Field>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {query.isPending ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando…</p>
        ) : query.isError ? (
          <p className="text-sm text-destructive">{query.error.message}</p>
        ) : view ? (
          <>
            {!view.settings.enabled && <p className="text-sm text-muted-foreground">O coletor está desligado. Ligue abaixo para começar a gravar os contadores.</p>}
            {latest?.error && <p className="text-sm text-destructive">Última leitura falhou: {latest.error}</p>}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="Erros/min (todas as portas)" value={fmt(latest?.errorsPerMin ?? null)} hint={latest?.worstPort ? `pior: ${latest.worstPort}` : undefined} tone={worst} />
              <Metric label="CRC/min" value={fmt(latest?.crcPerMin ?? null)} />
              <Metric label="Descartes/min" value={fmt(latest?.discardsPerMin ?? null)} />
              <Metric label="Latência até a switch" value={latest?.latencyMs != null ? `${fmt(latest.latencyMs)} ms` : "—"} />
              <Metric label="Latência até o gateway" value={latest?.gatewayLatencyMs != null ? `${fmt(latest.gatewayLatencyMs)} ms` : "—"} />
              <Metric label="Tráfego (entrada/saída)" value={fmtBps(latest?.inBps ?? null)} hint={`saída ${fmtBps(latest?.outBps ?? null)}`} />
            </div>

            <HealthChart points={view.series} from={from} to={to} threshold={view.settings.errorsPerMin} />

            <div className="grid gap-3 md:grid-cols-2">
              <CorrelationBlock title="Erros × latência até a switch (LAN)" c={view.correlation.lan} />
              <CorrelationBlock title="Erros × latência até o gateway" c={view.correlation.gateway} />
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Portas</h3>
              <PortsTable view={view} />
              {view.rangeHours === 168 && <p className="text-xs text-muted-foreground">Os totais por porta cobrem as últimas 48 h (é o tempo que os dados por porta ficam guardados).</p>}
            </div>

            {canManage && (
              <div className="flex flex-col gap-2 border-t pt-4">
                <h3 className="text-sm font-medium">Configuração</h3>
                <p className="text-xs text-muted-foreground">O limite de erros vale para todas as switches e dispara o alerta por e-mail quando os alertas estão ligados em Alertas → Configurar e-mails (dois minutos seguidos acima do limite).</p>
                <SettingsForm settings={view.settings} />
              </div>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
