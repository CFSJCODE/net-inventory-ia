"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  getGlobalStatus,
  getGlobalStatusDetail,
  refreshGlobalStatusNow,
  type StatusComponentRow,
  type StatusIncidentRow,
  type StatusServiceRow,
} from "@/app/actions/global-status-actions";
import { useCan } from "@/components/auth/user-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "@/lib/global-status/catalog";
import type { ServiceCategory, ServiceStatus } from "@/lib/global-status/types";
import { formatDateTime, formatRelativeTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import { IMPACT_LABEL, IMPACT_STATUS, SERVICE_STATUS_STYLE, incidentStateLabel } from "./status-style";

function StatusPill({ status, className }: { status: ServiceStatus; className?: string }) {
  const style = SERVICE_STATUS_STYLE[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", style.badge, className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", style.dot, status !== "OK" && status !== "UNKNOWN" && "animate-pulse")} />
      {style.label}
    </Badge>
  );
}

/** Avisa na tela quando um serviço muda para pior (ou volta) entre duas consultas. */
function useTransitionToasts(services: StatusServiceRow[] | undefined) {
  const previous = useRef<Map<string, ServiceStatus> | null>(null);
  useEffect(() => {
    if (!services) return;
    const before = previous.current;
    if (before) {
      for (const s of services) {
        const was = before.get(s.slug);
        if (!was || was === s.status || s.status === "UNKNOWN" || was === "UNKNOWN") continue;
        if (s.status === "DOWN") toast.error(`${s.name}: fora do ar`, { description: s.officialStatus ?? undefined, duration: 15_000 });
        else if (s.status === "DEGRADED" && was === "OK") toast.warning(`${s.name}: degradado`, { description: s.officialStatus ?? undefined });
        else if (s.status === "OK") toast.success(`${s.name}: normalizado`);
      }
    }
    previous.current = new Map(services.map((s) => [s.slug, s.status]));
  }, [services]);
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

function ServiceCard({ service, onOpen }: { service: StatusServiceRow; onOpen: () => void }) {
  const counts = service.componentCounts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const affected = total - counts.OK;
  const style = SERVICE_STATUS_STYLE[service.status];
  return (
    <Card size="sm" className={cn("relative transition-colors hover:ring-primary/40", service.status === "DOWN" && "ring-red-900")}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <button type="button" onClick={onOpen} className="truncate text-left after:absolute after:inset-0">
            {service.name}
          </button>
          <StatusPill status={service.status} />
        </CardTitle>
        <CardDescription className="line-clamp-1">
          {service.lastError && service.status === "UNKNOWN" ? service.lastError : service.officialStatus ?? "Aguardando a primeira consulta…"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs text-muted-foreground">
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
          <span className={cn(service.openIncidents ? style.text : undefined)}>
            {service.openIncidents ? `${service.openIncidents} incidente${service.openIncidents > 1 ? "s" : ""} aberto${service.openIncidents > 1 ? "s" : ""}` : "Sem incidentes abertos"}
          </span>
          <span title={service.lastCheckAt ? formatDateTime(service.lastCheckAt) : undefined}>
            {service.lastCheckAt ? formatRelativeTime(service.lastCheckAt) : "—"}
          </span>
        </div>
      </CardContent>
    </Card>
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
                {service.officialStatus ?? "Sem resposta da fonte oficial ainda."}
                {service.lastCheckAt && <> · consultado {formatRelativeTime(service.lastCheckAt)}</>}
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
                  <IncidentList incidents={data.incidents} />
                  {/* key: volta para "só os afetados" ao trocar de serviço. */}
                  <ComponentList key={service.slug} components={data.components} />
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
  useTransitionToasts(data?.services);

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
  const byCategory = CATEGORY_ORDER.map((cat) => [cat, services.filter((s) => s.category === cat)] as [ServiceCategory, StatusServiceRow[]]).filter(([, list]) => list.length);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Status oficial publicado por cada provedor, consultado pelo servidor a cada 2 minutos.
          {lastCheck && <> Última consulta {formatRelativeTime(lastCheck)}.</>}
        </p>
        {canRefresh && (
          <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending} className="shrink-0">
            {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Atualizar agora
          </Button>
        )}
      </div>

      <Counters services={services} />
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
