"use client";

import { useQuery } from "@tanstack/react-query";
import { getRouteOverview } from "@/app/actions/global-status-actions";
import { cn } from "@/lib/utils";

const pct = (share: number) => `${Math.round(share * 100)}%`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "Rotas e trânsito" (fases 8 e 9): onde cada serviço é servido, por onde o tráfego sai do país, os pontos
 * de interconexão, o IX.br e os vizinhos BGP da operadora. Lê as rotas que o servidor já grava; não
 * rastreia nada sozinha.
 */
export function TransitSection({ onOpen }: { onOpen: (slug: string) => void }) {
  const { data } = useQuery({ queryKey: ["global-status-routes"], queryFn: () => getRouteOverview(), refetchInterval: 120_000 });
  if (!data || data.summary.total === 0) return null;
  const { summary } = data;
  const parts = [
    summary.cdnEdge && `${summary.cdnEdge} na borda de um CDN no Brasil`,
    summary.domestic && `${summary.domestic} em servidores no Brasil`,
    summary.operatorCache && `${summary.operatorCache} dentro da operadora`,
    summary.international && `${summary.international} de fora do país`,
  ].filter(Boolean);
  const ispName = data.isp ? `${data.isp.name ?? `AS${data.isp.asn}`} (AS${data.isp.asn})` : "a operadora";
  const exitOperators = new Set(summary.exits.map((e) => e.label.split(" ")[0]));

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">Rotas e trânsito</h2>
      <div className="flex flex-col gap-3 rounded-lg border p-3 text-xs">
        <p className="text-muted-foreground">
          {plural(summary.total, "serviço com rota rastreada", "serviços com rota rastreada")}: {parts.join(", ")}.
        </p>
        {data.singleExit && (
          <p className="text-amber-500">
            {pct(data.singleExit.share)} do que vem de fora sai por {data.singleExit.label}: um problema nessa saída afeta{" "}
            {plural(data.singleExit.count, "serviço", "serviços")} de uma vez.
          </p>
        )}

        {data.places.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="font-medium">Onde cada serviço é atendido</span>
            <ul className="flex flex-col gap-1">
              {data.places.map((p) => (
                <li key={p.label} className="flex flex-wrap items-baseline gap-x-2">
                  <span className={cn("font-medium", p.kind === "EXIT" ? "text-sky-400" : "text-emerald-400")}>{p.label}</span>
                  <span className="text-muted-foreground">
                    {p.services.map((s, i) => (
                      <span key={s.slug}>
                        {i > 0 && ", "}
                        <button type="button" className="hover:underline" onClick={() => onOpen(s.slug)}>
                          {s.name}
                        </button>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {summary.exits.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-medium">Saídas internacionais</span>
            <ul className="flex flex-col gap-0.5 text-muted-foreground">
              {summary.exits.map((e) => (
                <li key={e.label} className="flex justify-between gap-3">
                  <span className="truncate">{e.label}</span>
                  <span className="shrink-0 tabular-nums">
                    {e.count} de {summary.international}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {summary.peerings.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-medium">Interconexões vistas</span>
            <ul className="flex flex-col gap-0.5 text-muted-foreground">
              {summary.peerings.slice(0, 8).map((p) => (
                <li key={p.label} className="flex justify-between gap-3">
                  <span className="truncate">{p.label}</span>
                  <span className="shrink-0 tabular-nums">{plural(p.count, "rota", "rotas")}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-col gap-1 border-t pt-2 text-muted-foreground">
          <span>
            {data.ixPrefixCount
              ? `IX.br e outros pontos de troca: ${summary.viaIx.length} de ${summary.total} rotas passam por um${summary.viaIx.length ? ` (${summary.viaIx.join(", ")})` : ""}.`
              : `Pontos de troca (IX.br): a lista de blocos da PeeringDB ainda não chegou${data.ixError ? ` (${data.ixError})` : ""}.`}
          </span>
          {data.upstreams.length > 0 && (
            <span>
              Vizinhos BGP de {ispName} (trânsito e peering): {data.upstreams.map((u) => `${u.name ?? "AS"} (AS${u.asn})`).join(", ")}.
              {exitOperators.size === 1 && summary.international > 0 && data.upstreams.length > 1 && ` As rotas medidas saem do país só por ${[...exitOperators][0]}.`}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
