"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { LinkStatus } from "@prisma/client";
import { checkLinksNow, createLink, deleteLink, listLinks, type LinkStatusRow } from "@/app/actions/link-actions";
import { useCan } from "@/components/auth/user-provider";
import { useDevices } from "@/hooks/use-devices";
import { displayName } from "@/lib/device-name";
import { formatDateTime, formatRelativeTime } from "@/lib/format-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, SimpleSelect } from "@/components/tools/tool-shell";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<LinkStatus, { label: string; className: string }> = {
  UP: { label: "No ar", className: "border-emerald-900 bg-emerald-950 text-emerald-400" },
  DOWN: { label: "Caiu", className: "border-red-900 bg-red-950 text-red-400" },
  UNKNOWN: { label: "Verificando", className: "border-amber-900 bg-amber-950 text-amber-400" },
};

const NONE = "";

/** Status das ligações, atualizado a cada 10s (compartilhado entre o mapa e esta página pelo cache). */
export function useLinks() {
  return useQuery({ queryKey: ["links"], queryFn: () => listLinks(), refetchInterval: 10_000 });
}

/** Avisa na tela quando uma ligação muda de estado entre duas consultas. */
export function useLinkTransitionToasts(links: LinkStatusRow[] | undefined) {
  const previous = useRef<Map<string, LinkStatus> | null>(null);
  useEffect(() => {
    if (!links) return;
    const before = previous.current;
    if (before) {
      for (const l of links) {
        const was = before.get(l.id);
        const name = `${l.fromLabel} ↔ ${l.toLabel}`;
        if (was === "UP" && l.status === "DOWN") toast.error(`Ligação caiu: ${name}`, { description: l.downReason ?? undefined, duration: 15_000 });
        if (was === "DOWN" && l.status === "UP") toast.success(`Ligação voltou: ${name}`);
      }
    }
    previous.current = new Map(links.map((l) => [l.id, l.status]));
  }, [links]);
}

export function LinksPanel() {
  const queryClient = useQueryClient();
  const { data: links } = useLinks();
  const { data: devices } = useDevices();
  const [fromId, setFromId] = useState(NONE);
  const [toId, setToId] = useState(NONE);
  const [label, setLabel] = useState("");
  const canEdit = useCan("inventory.edit");
  const canTest = useCan("network.operate");
  useLinkTransitionToasts(links);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["links"] });
    queryClient.invalidateQueries({ queryKey: ["topology"] });
  };

  const create = useMutation({
    mutationFn: async () => {
      const result = await createLink(fromId, toId, label);
      if (!result.ok) throw new Error(result.error);
    },
    onSuccess: () => {
      toast.success("Ligação criada e testada");
      setToId(NONE);
      setLabel("");
      refresh();
    },
    onError: (err) => toast.error(err.message),
  });
  const remove = useMutation({ mutationFn: deleteLink, onSuccess: refresh });
  const testNow = useMutation({ mutationFn: checkLinksNow, onSuccess: refresh });

  // Ao abrir a página, testa as ligações na hora em vez de mostrar o resultado da última rodada
  // do monitor (que roda a cada 30s). O ref evita o disparo duplo do StrictMode em desenvolvimento.
  const testedOnOpen = useRef(false);
  const { mutate: runTest } = testNow;
  useEffect(() => {
    // Testar dispara pings na rede: quem só consulta vê o resultado da última rodada do monitor.
    if (testedOnOpen.current || !canTest) return;
    testedOnOpen.current = true;
    runTest();
  }, [runTest, canTest]);

  const sorted = [...(devices ?? [])].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  const options: Record<string, string> = {
    [NONE]: "Selecione…",
    ...Object.fromEntries(sorted.map((d) => [d.id, `${displayName(d, "Sem nome")} — ${d.ip}${d.status === "OFFLINE" ? " (offline)" : ""}`])),
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Suas ligações</CardTitle>
        <CardDescription>
          Cadastre as ligações da sua rede (ex: roteador principal → roteador/AP secundário). Cada uma é testada a cada 30 segundos
          pelo servidor; se uma das pontas parar de responder em 2 testes seguidos, a ligação fica vermelha no mapa e o evento vai
          para o Histórico.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
        >
          <Field label="De (lado mais perto do gateway)" htmlFor="link-from">
            <SimpleSelect id="link-from" value={fromId} onChange={setFromId} options={options} className="sm:w-72" />
          </Field>
          <ArrowRight className="hidden h-4 w-4 text-muted-foreground sm:mb-2 sm:block" />
          <Field label="Para" htmlFor="link-to">
            <SimpleSelect id="link-to" value={toId} onChange={setToId} options={options} className="sm:w-72" />
          </Field>
          <Field label="Nome (opcional)" htmlFor="link-label">
            <Input id="link-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex: cabo sala → escritório" className="sm:w-56" />
          </Field>
          <Button type="submit" disabled={create.isPending || !fromId || !toId} className="w-fit">
            {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {create.isPending ? "Testando…" : "Adicionar ligação"}
          </Button>
        </form>
        )}

        {testNow.isPending && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Testando as ligações agora…
          </p>
        )}
        {!links?.length ? (
          <p className="text-sm text-muted-foreground">Nenhuma ligação cadastrada ainda.</p>
        ) : (
          <>
            <ul className="flex flex-col divide-y rounded-md border">
              {links.map((l) => {
                const style = STATUS_STYLE[l.status];
                return (
                  <li key={l.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                    <Badge variant="outline" className={cn("w-fit gap-1.5 font-normal", style.className)}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", l.status === "UP" ? "bg-emerald-500" : l.status === "DOWN" ? "animate-pulse bg-red-500" : "bg-amber-500")} />
                      {style.label}
                    </Badge>
                    <span className="text-sm font-medium">
                      {l.fromLabel} <span className="text-muted-foreground">↔</span> {l.toLabel}
                      {l.label && <span className="ml-2 font-normal text-muted-foreground">({l.label})</span>}
                    </span>
                    <span className="text-xs text-muted-foreground sm:ml-auto" title={l.lastCheckAt ? `Último teste: ${formatDateTime(l.lastCheckAt)}` : undefined}>
                      {l.status === "DOWN" && (l.downReason ?? "Sem resposta")}
                      {l.status === "DOWN" && l.statusSince && ` · caiu ${formatRelativeTime(l.statusSince)}`}
                      {l.status === "UP" && `${l.latencyMs ?? "—"} ms${l.statusSince ? ` · no ar ${formatRelativeTime(l.statusSince)}` : ""}`}
                    </span>
                    {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => remove.mutate(l.id)}
                      disabled={remove.isPending}
                      aria-label={`Remover ligação ${l.fromLabel} ↔ ${l.toLabel}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {canTest && (
              <Button variant="outline" onClick={() => testNow.mutate()} disabled={testNow.isPending} className="w-fit">
                <RefreshCw className={cn("h-3.5 w-3.5", testNow.isPending && "animate-spin")} />
                {testNow.isPending ? "Testando…" : "Testar agora"}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
