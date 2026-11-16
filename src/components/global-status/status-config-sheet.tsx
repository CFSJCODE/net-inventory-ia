"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getGlobalStatusConfig, saveGlobalStatusConfig, type GlobalStatusConfig } from "@/app/actions/global-status-actions";
import { Field, SimpleSelect } from "@/components/tools/tool-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatRelativeTime } from "@/lib/format-time";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "@/lib/global-status/catalog";
import type { GlobalStatusSettings } from "@/lib/global-status/settings";
import type { ServiceCategory } from "@/lib/global-status/types";

const LEVELS: Record<GlobalStatusSettings["alerts"]["level"], string> = {
  DOWN: "Só quando um serviço sai do ar",
  DEGRADED: "Também quando fica degradado",
};

interface Draft {
  settings: GlobalStatusSettings;
  asnText: string;
  enabled: Record<string, boolean>;
}

function draftOf(config: GlobalStatusConfig): Draft {
  return {
    settings: config.settings,
    asnText: config.settings.ispAsn ? String(config.settings.ispAsn) : "",
    enabled: Object.fromEntries(config.services.map((s) => [s.slug, s.enabled])),
  };
}

/**
 * Configuração do painel "Status global" (fase 4): o alerta opcional por e-mail, a operadora usada no
 * IODA e quais serviços são acompanhados. Mesmos campos e caixas de marcar da tela de alertas por e-mail.
 */
export function StatusConfigSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["global-status-config"], queryFn: () => getGlobalStatusConfig(), enabled: open });
  const [draft, setDraft] = useState<Draft | null>(null);

  // Preenche o formulário ao abrir; reabrir descarta o que não foi salvo.
  useEffect(() => {
    if (open && config) setDraft(draftOf(config));
    if (!open) setDraft(null);
  }, [open, config]);

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const asn = d.asnText.trim().replace(/^AS/i, "");
      return saveGlobalStatusConfig({ settings: { ...d.settings, ispAsn: asn ? Number(asn) : null }, enabled: d.enabled });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["global-status-config"], next);
      queryClient.invalidateQueries({ queryKey: ["global-status"] });
      toast.success("Configuração do Status global salva");
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  const asnInvalid = !!draft && draft.asnText.trim() !== "" && !/^(AS)?\d{1,10}$/i.test(draft.asnText.trim());
  const grouped = config
    ? CATEGORY_ORDER.map((cat) => [cat, config.services.filter((s) => s.category === cat)] as [ServiceCategory, GlobalStatusConfig["services"]]).filter(([, list]) => list.length)
    : [];

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Configurar Status global</SheetTitle>
          <SheetDescription>Alerta por e-mail, operadora usada nos alertas do IODA, janela da linha do tempo e os serviços acompanhados.</SheetDescription>
        </SheetHeader>

        {!config || !draft ? (
          <Loader2 className="mx-4 size-4 animate-spin text-muted-foreground" />
        ) : (
          <form
            className="flex flex-col gap-6 px-4 pb-6 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(draft);
            }}
          >
            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Alerta por e-mail</h3>
              <p className="text-xs text-muted-foreground">
                Avisa quando um serviço muda de estado e fica assim por 5 minutos, e quando volta ao normal. No máximo um e-mail a cada 10
                minutos, com todas as mudanças juntas. Usa a chave do Resend e o destinatário de Alertas → Configurar e-mails; os alertas dos
                equipamentos continuam como estão.
              </p>
              {config.email.ready ? (
                <p className="text-xs text-muted-foreground">
                  Envia para <span className="text-foreground">{config.email.to}</span>.
                </p>
              ) : (
                <p className="text-xs text-amber-400">Cadastre a chave do Resend e o destinatário em Alertas → Configurar e-mails para receber estes avisos.</p>
              )}
              <Field label="Quando avisar" htmlFor="status-alert-level">
                <SimpleSelect
                  id="status-alert-level"
                  value={draft.settings.alerts.level}
                  onChange={(level) => setDraft({ ...draft, settings: { ...draft.settings, alerts: { ...draft.settings.alerts, level } } })}
                  options={LEVELS}
                />
              </Field>
              <Label className="flex items-center gap-2 text-sm font-normal">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={draft.settings.alerts.enabled}
                  onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, alerts: { ...draft.settings.alerts, enabled: e.target.checked } } })}
                />
                Ativar alerta por e-mail do Status global
              </Label>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Sua operadora</h3>
              <p className="text-xs text-muted-foreground">
                {config.isp
                  ? `Descoberta pelo IP público do servidor: AS${config.isp.asn}${config.isp.name ? ` · ${config.isp.name}` : ""}.`
                  : "Ainda não descoberta: o servidor consulta o RIPEstat na próxima rodada."}{" "}
                Deixe o campo vazio para usar a descoberta automática.
              </p>
              <Field label="ASN da operadora (opcional)" htmlFor="status-isp-asn">
                <Input
                  id="status-isp-asn"
                  value={draft.asnText}
                  onChange={(e) => setDraft({ ...draft, asnText: e.target.value })}
                  placeholder={config.isp ? `AS${config.isp.asn}` : "AS28573"}
                  className="font-mono"
                  aria-invalid={asnInvalid || undefined}
                />
              </Field>
              {asnInvalid && <p className="text-xs text-destructive">Use só o número do ASN, com ou sem &ldquo;AS&rdquo; na frente.</p>}
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Linha do tempo</h3>
              <p className="text-xs text-muted-foreground">
                Quantas medições recentes entram no p50, p95, p99, jitter e perda de cada faixa (de 5 a 200). Com 20, cerca de 20 minutos. A
                faixa fica amarela, e o card do serviço degradado, quando o p95 dessa janela passa de 1,5× a mediana das 100
                medições anteriores (e da variação normal delas).
              </p>
              <Field label="Medições na janela" htmlFor="status-probe-window">
                <Input
                  id="status-probe-window"
                  type="number"
                  min={5}
                  max={200}
                  value={draft.settings.probeWindow}
                  onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, probeWindow: Number(e.target.value) } })}
                  className="w-28 font-mono"
                />
              </Field>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Rota até os serviços</h3>
              <RouteToolStatus config={config} />
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Serviços acompanhados</h3>
              <p className="text-xs text-muted-foreground">Os desmarcados saem da página e deixam de ser consultados e medidos. O histórico fica guardado.</p>
              {grouped.map(([category, list]) => (
                <div key={category} className="flex flex-col gap-1.5">
                  <div className="text-xs font-medium text-muted-foreground">{CATEGORY_LABEL[category]}</div>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {list.map((s) => (
                      <Label key={s.slug} className="flex items-center gap-2 text-sm font-normal">
                        <input
                          type="checkbox"
                          className="accent-primary"
                          checked={draft.enabled[s.slug] ?? false}
                          onChange={(e) => setDraft({ ...draft, enabled: { ...draft.enabled, [s.slug]: e.target.checked } })}
                        />
                        <span className="truncate">{s.name}</span>
                      </Label>
                    ))}
                  </div>
                </div>
              ))}
            </section>

            <div className="flex gap-3">
              <Button type="submit" disabled={save.isPending || asnInvalid} className="w-fit">
                {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Salvar
              </Button>
              <Button type="button" variant="outline" onClick={onClose} className="w-fit">
                Cancelar
              </Button>
            </div>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}

const TCP_TEXT: Record<string, string> = {
  ok: "Traceroute TCP 443 liberado: passa onde os roteadores filtram UDP e ICMP.",
  denied: "Traceroute TCP 443 sem permissão: no servidor, rode sudo netinventoryctl rota-tcp.",
  unavailable: "Traceroute TCP 443 indisponível: falta o pacote traceroute (sudo apt install traceroute).",
};

/** Estado da ferramenta de rota (fase 7): o que falta no servidor aparece aqui, não só no log. */
function RouteToolStatus({ config }: { config: GlobalStatusConfig }) {
  const tool = config.routeTool;
  if (!config.routesEnabled) return <p className="text-xs text-muted-foreground">Desligada no servidor (GLOBAL_STATUS_ROUTES=off ou medições desligadas).</p>;
  if (!tool) return <p className="text-xs text-muted-foreground">Nenhuma rota rastreada ainda: a primeira sai alguns minutos depois de o servidor subir.</p>;
  return (
    <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
      <li>
        {tool.lastRouteAt ? (
          <>
            Última rota {formatRelativeTime(tool.lastRouteAt)}
            {tool.tool ? <> com {tool.tool}</> : null}.
          </>
        ) : (
          (tool.error ?? "Nenhuma rota gravada.")
        )}
      </li>
      <li className={tool.tcp === "ok" || tool.tcp === null ? undefined : "text-amber-500"}>
        {tool.tcp ? TCP_TEXT[tool.tcp] : "O traceroute TCP 443 ainda não foi preciso: todas as rotas chegaram pelo UDP."}
      </li>
    </ul>
  );
}
