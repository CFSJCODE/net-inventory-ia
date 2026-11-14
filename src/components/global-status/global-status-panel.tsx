"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  getGlobalStatus,
  getGlobalStatusDetail,
  refreshGlobalStatusNow,
  type GlobalStatusData,
  type StatusComponentRow,
  type StatusIncidentRow,
  type StatusServiceRow,
  type StatusTargetRow,
} from "@/app/actions/global-status-actions";
import { useCan } from "@/components/auth/user-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "@/lib/global-status/catalog";
import type { LocalConnectivity, ServiceCategory, ServiceStatus } from "@/lib/global-status/types";
import { formatDateTime, formatRelativeTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import { formatLatency, formatPercent, formatUptime, isWorseThanOfficial } from "./format";
import { InternetHealthBar } from "./internet-health-bar";
import { Sparkline } from "./sparkline";
import { HTTP_PHASE_STYLE, IMPACT_LABEL, IMPACT_STATUS, SERVICE_STATUS_STYLE, incidentStateLabel } from "./status-style";

/** Os serviços desta categoria medem a conexão do próprio servidor: ficam na faixa "Sua Internet", não nos cards. */
const INTERNET_CATEGORY: ServiceCategory = "INTERNET";

function StatusPill({ status, className }: { status: ServiceStatus; className?: string }) {
  const style = SERVICE_STATUS_STYLE[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", style.badge, className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", style.dot, status !== "OK" && status !== "UNKNOWN" && "animate-pulse")} />
      {style.label}
    </Badge>
  );
}

/**
 * Avisa na tela quando um serviço muda para pior (ou volta) entre duas consultas, e quando a conexão
 * do próprio servidor cai ou volta.
 */
function useTransitionToasts(data: GlobalStatusData | undefined) {
  const previous = useRef<{ states: Map<string, ServiceStatus>; connection: LocalConnectivity["state"] } | null>(null);
  useEffect(() => {
    if (!data) return;
    const before = previous.current;
    const connection = data.connectivity.state;
    if (before) {
      const wasOk = before.connection === "ok";
      const isOk = connection === "ok";
      if (wasOk && !isOk) toast.error("Sua Internet está fora", { description: data.connectivity.reason ?? undefined, duration: 15_000 });
      else if (!wasOk && isOk) toast.success("Sua Internet voltou");
      // Com a conexão fora, ou recém-mudada, as medições estão pausadas e viram "Sem dados": isso não é notícia do serviço.
      if (wasOk && isOk) {
        for (const s of data.services) {
          if (s.category === INTERNET_CATEGORY) continue;
          const was = before.states.get(s.slug);
          if (!was || was === s.status || s.status === "UNKNOWN" || was === "UNKNOWN") continue;
          const description = s.measuredReason ?? s.officialStatus ?? undefined;
          if (s.status === "DOWN") toast.error(`${s.name}: fora do ar`, { description, duration: 15_000 });
          else if (s.status === "DEGRADED" && was === "OK") toast.warning(`${s.name}: degradado`, { description });
          else if (s.status === "OK") toast.success(`${s.name}: normalizado`);
        }
      }
    }
    previous.current = { states: new Map(data.services.map((s) => [s.slug, s.status])), connection };
  }, [data]);
}

const COUNTERS: { label: string; statuses: ServiceStatus[]; tone: ServiceStatus }[] = [
  { label: "Operando", statuses: ["OK"], tone: "OK" },
  { label: "Degradados", statuses: ["DEGRADED"], tone: "DEGRADED" },
  { label: "Fora do ar", statuses: ["DOWN"], tone: "DOWN" },
  { label: "Manutenção ou sem dados", statuses: ["MAINTENANCE", "UNKNOWN"], tone: "MAINTENANCE" },
];

function Counters({ services }: { services: StatusServiceRow[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {COUNTERS.map((c) => {
        const n = services.filter((s) => c.statuses.includes(s.status)).length;
        const style = SERVICE_STATUS_STYLE[c.tone];
        return (
          <Card key={c.label} size="sm">
            <CardContent className="flex items-center gap-3">
              <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", n ? style.dot : "bg-zinc-700")} />
              <div className="min-w-0">
                <div className={cn("font-mono text-2xl leading-none font-semibold tabular-nums", n ? style.text : "text-muted-foreground")}>{n}</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{c.label}</div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/** Faixa "ao vivo" com os incidentes abertos; rola sozinha e para ao passar o mouse. */
function IncidentTicker({ incidents, onOpen }: { incidents: StatusIncidentRow[]; onOpen: (slug: string) => void }) {
  if (!incidents.length) {
    return (
      <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-2.5 text-sm text-muted-foreground">
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
        Nenhum incidente aberto nos provedores monitorados.
      </div>
    );
  }
  const item = (i: StatusIncidentRow, copy: number) => {
    const style = SERVICE_STATUS_STYLE[IMPACT_STATUS[i.impact] ?? "DEGRADED"];
    return (
      <button
        key={`${copy}-${i.id}`}
        type="button"
        onClick={() => onOpen(i.serviceSlug)}
        className="flex shrink-0 items-center gap-2 px-4 text-left hover:text-foreground"
        tabIndex={copy ? -1 : 0}
        aria-hidden={copy ? true : undefined}
      >
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} />
        <span className="font-medium text-foreground">{i.serviceName}</span>
        <span className="max-w-[28rem] truncate">{i.title}</span>
        <span className="text-xs">· {formatRelativeTime(i.startedAt)}</span>
      </button>
    );
  };
  // Conteúdo duplicado para a rolagem emendar; a duração cresce com o número de itens.
  const duration = Math.max(30, incidents.length * 12);
  return (
    <div className="flex items-center overflow-hidden rounded-xl border bg-card text-sm text-muted-foreground">
      <span className="z-10 flex shrink-0 items-center gap-2 self-stretch border-r bg-card px-3 text-xs font-semibold tracking-wide text-red-400">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
        AO VIVO · {incidents.length}
      </span>
      <div className="group relative min-w-0 flex-1 overflow-hidden py-2.5 motion-reduce:overflow-x-auto">
        <div
          className="flex w-max [animation:status-ticker_var(--ticker-duration)_linear_infinite] group-hover:[animation-play-state:paused] motion-reduce:[animation:none]"
          style={{ "--ticker-duration": `${duration}s` } as CSSProperties}
        >
          {incidents.map((i) => item(i, 0))}
          {incidents.map((i) => item(i, 1))}
        </div>
      </div>
    </div>
  );
}

/** Um número medido: o rótulo em cima, o valor com a unidade embaixo. */
function Reading({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={cn("shrink-0", className)}>
      <div>{label}</div>
      <div className="text-sm font-medium text-foreground tabular-nums">{value}</div>
    </div>
  );
}

/** Frase sob o nome do serviço: a do provedor quando há fonte oficial, senão o que as medições dizem. */
function cardDescription(service: StatusServiceRow): string {
  if (service.hasSource) return service.lastError && service.status === "UNKNOWN" ? service.lastError : service.officialStatus ?? "Aguardando a primeira consulta…";
  if (!service.measuredStatus) return "Aguardando a primeira medição…";
  if (service.measuredStatus === "OK") return "Respondendo às medições deste servidor.";
  return service.measuredReason ?? SERVICE_STATUS_STYLE[service.measuredStatus].label;
}

function ServiceCard({ service, onOpen }: { service: StatusServiceRow; onOpen: () => void }) {
  const counts = service.componentCounts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const affected = total - counts.OK;
  const style = SERVICE_STATUS_STYLE[service.status];
  const measured = service.measuredStatus;
  const official = service.officialState ?? "UNKNOWN";
  return (
    <Card size="sm" className={cn("relative transition-colors hover:ring-primary/40", service.status === "DOWN" && "ring-red-900")}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <button type="button" onClick={onOpen} className="truncate text-left after:absolute after:inset-0">
            {service.name}
          </button>
          <StatusPill status={service.status} />
        </CardTitle>
        <CardDescription className="line-clamp-1">{cardDescription(service)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs text-muted-foreground">
        <div className="flex items-end gap-2">
          <Reading label="Latência" value={formatLatency(service.latencyMs)} />
          {service.spark ? (
            <Sparkline series={service.spark} label={`Latência de ${service.name} nas últimas 24 h`} className="h-8 min-w-0 flex-1" />
          ) : (
            <span className="flex h-8 min-w-0 flex-1 items-center justify-center text-center">Coletando medições…</span>
          )}
          <Reading label="Disponibilidade 24 h" value={formatUptime(service.uptime24h)} className="text-right" />
        </div>
        {service.hasSource && measured && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              oficial: <span className={SERVICE_STATUS_STYLE[official].text}>{SERVICE_STATUS_STYLE[official].label}</span> · medido:{" "}
              <span className={SERVICE_STATUS_STYLE[measured].text}>{SERVICE_STATUS_STYLE[measured].label}</span>
            </span>
            {isWorseThanOfficial(service.officialState, measured) && (
              <Badge variant="outline" className={cn("font-normal", SERVICE_STATUS_STYLE.DEGRADED.badge)}>
                Sem aviso oficial
              </Badge>
            )}
          </div>
        )}
        {/* Sem fonte oficial o motivo já está na frase sob o nome; aqui ele não se repete. */}
        {service.hasSource && measured && measured !== "OK" && service.measuredReason && (
          <p className={cn("line-clamp-2", measured !== "UNKNOWN" && SERVICE_STATUS_STYLE[measured].text)}>{service.measuredReason}</p>
        )}
        {total > 0 && (
          <div className="flex items-center gap-2">
            {/* Barra proporcional: verde = componentes normais, demais cores = afetados. */}
            <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
              {(["OK", "MAINTENANCE", "DEGRADED", "DOWN"] as ServiceStatus[]).map((s) =>
                counts[s] ? <span key={s} className={SERVICE_STATUS_STYLE[s].dot} style={{ width: `${(counts[s] / total) * 100}%` }} /> : null,
              )}
            </div>
            <span className="shrink-0 tabular-nums">{affected ? `${affected} de ${total} afetados` : `${total} componentes ok`}</span>
          </div>
        )}
        {service.problemComponents.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {service.problemComponents.slice(0, 3).map((c) => (
              <li key={`${c.groupName}-${c.name}`} className="flex items-center gap-1.5 truncate">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", SERVICE_STATUS_STYLE[c.status].dot)} />
                <span className="truncate">{c.name}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          {service.hasSource ? (
            <span className={cn(service.openIncidents ? style.text : undefined)}>
              {service.openIncidents ? `${service.openIncidents} incidente${service.openIncidents > 1 ? "s" : ""} aberto${service.openIncidents > 1 ? "s" : ""}` : "Sem incidentes abertos"}
            </span>
          ) : (
            <span>Só medições deste servidor</span>
          )}
          <span title={service.lastCheckAt ? formatDateTime(service.lastCheckAt) : undefined}>
            {service.lastCheckAt ? formatRelativeTime(service.lastCheckAt) : "—"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/** Um número medido dentro de uma linha: "mediana 24 h 12 ms". */
function InlineReading({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label} <span className="font-medium text-foreground tabular-nums">{value}</span>
    </span>
  );
}

/** Parcelas da última medição HTTP numa barra só: onde o tempo foi gasto até o primeiro byte. */
function HttpPhases({ last }: { last: NonNullable<StatusTargetRow["last"]> }) {
  const phases = HTTP_PHASE_STYLE.map((p) => ({ ...p, ms: last[p.key] }));
  const total = phases.reduce((sum, p) => sum + Math.max(p.ms ?? 0, 0), 0);
  if (!phases.some((p) => p.ms !== null) && last.httpStatus === null) return null;
  return (
    <div className="flex flex-col gap-2">
      {total > 0 && (
        // As cores de gráfico do tema são tons vizinhos: o intervalo entre as parcelas é o que as separa.
        <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted" aria-hidden>
          {phases.map((p) => (p.ms && p.ms > 0 ? <span key={p.key} className={p.bar} style={{ width: `${(p.ms / total) * 100}%` }} /> : null))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        {phases.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5">
            {/* Um pedaço da barra, não o ponto redondo: nesta página o ponto é sempre um estado. */}
            <span className={cn("h-1.5 w-3 shrink-0 rounded-full", p.bar)} />
            <InlineReading label={p.label} value={formatLatency(p.ms)} />
          </span>
        ))}
        {last.httpStatus !== null && <span className="tabular-nums">HTTP {last.httpStatus}</span>}
      </div>
    </div>
  );
}

function certificateText(days: number): string {
  if (days < 0) return "Certificado vencido";
  const whole = Math.floor(days);
  return `Certificado vence em ${whole.toLocaleString("pt-BR")} dia${whole === 1 ? "" : "s"}`;
}

/** Medições feitas por este servidor, um item por alvo, na ordem do catálogo. */
function TargetList({ targets }: { targets: StatusTargetRow[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Medições daqui</h3>
      {!targets.length && <p className="text-xs text-muted-foreground">Nenhuma medição configurada para este serviço.</p>}
      {targets.map((t) => {
        const style = SERVICE_STATUS_STYLE[t.status];
        const reason = t.status !== "OK" ? t.statusReason ?? t.lastError : null;
        return (
          <div key={t.key} className="flex flex-col gap-2 rounded-lg border p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-medium text-foreground">{t.label}</span>
                <span className="truncate text-muted-foreground" title={t.address}>
                  {t.address}
                </span>
              </div>
              <span className={cn("shrink-0", style.text)}>{style.label}</span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
              <InlineReading label="agora" value={formatLatency(t.lastLatencyMs)} />
              <InlineReading label="mediana 24 h" value={formatLatency(t.p50Ms)} />
              <InlineReading label="p95 24 h" value={formatLatency(t.p95Ms)} />
              <InlineReading label="disponibilidade 24 h" value={formatUptime(t.uptime24h)} />
            </div>
            {t.spark ? (
              <Sparkline series={t.spark} label={`Latência de ${t.label} (${t.address}) nas últimas 24 h`} className="h-10" />
            ) : (
              <p className="text-muted-foreground">Coletando medições…</p>
            )}
            {t.kind === "HTTP" && t.last && <HttpPhases last={t.last} />}
            {t.kind === "ICMP" && t.last && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                <InlineReading label="perda" value={formatPercent(t.last.lossPct, 1)} />
                <InlineReading label="jitter" value={formatLatency(t.last.jitterMs)} />
              </div>
            )}
            {t.last && t.last.certDays !== null && <p className="text-muted-foreground">{certificateText(t.last.certDays)}</p>}
            {reason && <p className={cn(t.status === "UNKNOWN" ? "text-muted-foreground" : style.text)}>{reason}</p>}
            {t.last && (
              <p className="text-muted-foreground" title={formatDateTime(t.last.at)}>
                medido {formatRelativeTime(t.last.at)}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

function IncidentList({ incidents }: { incidents: StatusIncidentRow[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Incidentes (últimos 30 dias)</h3>
      {!incidents.length && <p className="text-xs text-muted-foreground">Nenhum incidente registrado.</p>}
      {incidents.map((i) => (
        <div key={i.id} className="rounded-lg border p-3 text-xs">
          <div className="flex items-start justify-between gap-2">
            <span className="font-medium text-foreground">{i.url ? <a href={i.url} target="_blank" rel="noreferrer" className="hover:underline">{i.title}</a> : i.title}</span>
            <StatusPill status={i.resolvedAt ? "OK" : IMPACT_STATUS[i.impact] ?? "DEGRADED"} className="shrink-0" />
          </div>
          <div className="mt-1 text-muted-foreground">
            {IMPACT_LABEL[i.impact] ?? i.impact} · {incidentStateLabel(i.state)} · início {formatDateTime(i.startedAt)}
            {i.resolvedAt && <> · resolvido {formatDateTime(i.resolvedAt)}</>}
          </div>
          {i.affected && <div className="mt-1 line-clamp-2 text-muted-foreground">{i.affected}</div>}
        </div>
      ))}
    </section>
  );
}

/** Componentes agrupados; por padrão só os afetados (a Cloudflare tem centenas). */
function ComponentList({ components }: { components: StatusComponentRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const problems = components.filter((c) => c.status !== "OK");
  const visible = showAll ? components : problems;
  const groups = new Map<string, StatusComponentRow[]>();
  for (const c of visible) {
    const key = c.groupName ?? "";
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          Componentes {components.length ? `(${problems.length} de ${components.length} afetados)` : ""}
        </h3>
        {components.length > 0 && (
          <Button variant="ghost" size="xs" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Só os afetados" : "Mostrar todos"}
          </Button>
        )}
      </div>
      {!components.length && <p className="text-xs text-muted-foreground">Esta fonte não publica componentes.</p>}
      {components.length > 0 && !visible.length && <p className="text-xs text-muted-foreground">Todos os componentes operando normalmente.</p>}
      {Array.from(groups.entries()).map(([group, items]) => (
        <div key={group} className="flex flex-col gap-1">
          {group && <div className="text-xs font-medium text-muted-foreground">{group}</div>}
          {items.map((c) => (
            <div key={`${group}-${c.name}`} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate">{c.name}</span>
              <span className={cn("shrink-0", SERVICE_STATUS_STYLE[c.status].text)}>{SERVICE_STATUS_STYLE[c.status].label}</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function ServiceDetailSheet({ service, onClose }: { service: StatusServiceRow | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["global-status-detail", service?.slug],
    queryFn: () => getGlobalStatusDetail(service!.slug),
    enabled: !!service,
    refetchInterval: 30_000,
  });

  return (
    <Sheet open={!!service} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {service && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {service.name}
                <StatusPill status={service.status} />
              </SheetTitle>
              <SheetDescription>
                {service.hasSource ? (
                  <>
                    {service.officialStatus ?? "Sem resposta da fonte oficial ainda."}
                    {service.lastCheckAt && <> · consultado {formatRelativeTime(service.lastCheckAt)}</>}
                  </>
                ) : (
                  "Sem fonte oficial de status: o estado vem das medições deste servidor."
                )}
              </SheetDescription>
              {service.pageUrl && (
                <a href={service.pageUrl} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline">
                  Página oficial de status <ExternalLink className="size-3" />
                </a>
              )}
              {service.lastError && <p className="text-xs text-amber-400">Última consulta falhou: {service.lastError}</p>}
            </SheetHeader>

            <div className="flex flex-col gap-6 px-4 pb-6">
              {isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              {data && (
                <>
                  <TargetList targets={data.targets} />
                  {/* Sem fonte oficial não há incidentes nem componentes publicados para listar. */}
                  {service.hasSource && (
                    <>
                      <IncidentList incidents={data.incidents} />
                      {/* key: volta para "só os afetados" ao trocar de serviço. */}
                      <ComponentList key={service.slug} components={data.components} />
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function GlobalStatusPanel() {
  const queryClient = useQueryClient();
  const canRefresh = useCan("network.operate");
  const { data, isLoading } = useQuery({ queryKey: ["global-status"], queryFn: () => getGlobalStatus(), refetchInterval: 30_000 });
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  useTransitionToasts(data);

  const refresh = useMutation({
    mutationFn: refreshGlobalStatusNow,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["global-status"] });
      queryClient.invalidateQueries({ queryKey: ["global-status-detail"] });
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Carregando status…
      </div>
    );
  }

  const services = data.services;
  const lastCheck = services.map((s) => s.lastCheckAt).filter(Boolean).sort().at(-1);
  const internet = services.filter((s) => s.category === INTERNET_CATEGORY);
  // Contadores e cards só dos provedores: a conexão do servidor aparece na faixa "Sua Internet".
  const providers = services.filter((s) => s.category !== INTERNET_CATEGORY);
  const byCategory = CATEGORY_ORDER.map((cat) => [cat, providers.filter((s) => s.category === cat)] as [ServiceCategory, StatusServiceRow[]]).filter(([, list]) => list.length);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Status oficial de cada provedor, consultado a cada 2 minutos, e medições feitas por este servidor (HTTP, TCP, ping e DNS).
          {lastCheck && <> Última consulta {formatRelativeTime(lastCheck)}.</>}
        </p>
        {canRefresh && (
          <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending} className="shrink-0">
            {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Atualizar agora
          </Button>
        )}
      </div>

      <InternetHealthBar services={internet} connectivity={data.connectivity} onOpen={setOpenSlug} />
      <Counters services={providers} />
      <IncidentTicker incidents={data.incidents} onOpen={setOpenSlug} />

      {byCategory.map(([category, list]) => (
        <section key={category} className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">{CATEGORY_LABEL[category]}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((s) => (
              <ServiceCard key={s.slug} service={s} onOpen={() => setOpenSlug(s.slug)} />
            ))}
          </div>
        </section>
      ))}

      <ServiceDetailSheet service={services.find((s) => s.slug === openSlug) ?? null} onClose={() => setOpenSlug(null)} />
    </>
  );
}
