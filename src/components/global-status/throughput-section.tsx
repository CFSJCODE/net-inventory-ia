"use client";

import { useQuery } from "@tanstack/react-query";
import { getThroughput } from "@/app/actions/global-status-actions";
import { formatDateTime, formatRelativeTime } from "@/lib/format-time";
import { formatMbps, type ThroughputTestView } from "@/lib/global-status/throughput";
import { cn } from "@/lib/utils";

const rate = (v: number | null) => (v === null ? "—" : formatMbps(v));

/** Barras pequenas dos testes recentes (do mais velho para o mais novo), na escala do maior download. */
function RecentBars({ tests }: { tests: ThroughputTestView[] }) {
  const ordered = [...tests].reverse();
  const top = Math.max(1, ...ordered.map((t) => Math.max(t.downloadMbps ?? 0, t.uploadMbps ?? 0)));
  return (
    <div className="flex h-8 items-end gap-0.5" aria-hidden>
      {ordered.map((t) => (
        <span
          key={t.at}
          title={`${formatDateTime(t.at)}: ${t.error ?? `download ${rate(t.downloadMbps)}, upload ${rate(t.uploadMbps)}`}`}
          className={cn("w-1.5 rounded-sm", t.error ? "h-1 bg-red-500" : "bg-chart-2")}
          style={t.error ? undefined : { height: `${Math.max(8, ((t.downloadMbps ?? 0) / top) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/**
 * "Banda da rede local (iperf3)": o teste que cada agente faz contra o servidor iperf3 da máquina do
 * painel, com o habitual da semana e um aviso quando cai pela metade. Some quando não há testes.
 */
export function ThroughputSection() {
  const { data } = useQuery({ queryKey: ["global-status-throughput"], queryFn: () => getThroughput(), refetchInterval: 120_000 });
  if (!data?.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">Banda da rede local (iperf3)</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.map((s) => (
          <div key={s.vantage} className="flex flex-col gap-2 rounded-lg border p-3 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium text-foreground">{s.label}</span>
              <span className="shrink-0 text-muted-foreground">{formatRelativeTime(s.latest.at)}</span>
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="flex gap-4">
                <div>
                  <div className="text-muted-foreground">Download</div>
                  <div className="text-sm font-medium text-foreground tabular-nums">{rate(s.latest.downloadMbps)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Upload</div>
                  <div className="text-sm font-medium text-foreground tabular-nums">{rate(s.latest.uploadMbps)}</div>
                </div>
              </div>
              <RecentBars tests={s.recent} />
            </div>
            <p className="text-muted-foreground">
              Até {s.server}
              {s.usualDownloadMbps !== null && ` · costuma ser ${formatMbps(s.usualDownloadMbps)} de download`}
              {s.latest.retransmits ? ` · ${s.latest.retransmits} retransmissões` : ""}
            </p>
            {s.warning && <p className="text-amber-400">{s.warning}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
