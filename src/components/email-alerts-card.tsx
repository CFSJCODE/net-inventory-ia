"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import {
  deleteResendKey,
  getEmailAlertStatus,
  saveEmailAlertSettings,
  sendTestAlertEmail,
  type EmailAlertStatus,
} from "@/app/actions/alert-email-actions";
import { Field, SimpleSelect } from "@/components/tools/tool-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BellIcon } from "@/components/ui/bell";
import { DEFAULT_SETTINGS, type AlertThresholds, type EmailAlertSettings } from "@/lib/alerts/email-defaults";
import { formatDateTime } from "@/lib/format-time";

const COOLDOWNS = { "5": "5 minutos", "15": "15 minutos", "30": "30 minutos", "60": "1 hora", "180": "3 horas" };
type CooldownKey = keyof typeof COOLDOWNS;

const PROBLEM_LABELS: Record<string, string> = {
  offline: "fora do ar",
  degraded: "desempenho degradado",
  cpu: "CPU alta",
  mem: "memória alta",
  temp: "temperatura alta",
};

const THRESHOLD_FIELDS: { key: keyof AlertThresholds; label: string; min: number; max: number }[] = [
  { key: "cpuPct", label: "CPU (%)", min: 1, max: 100 },
  { key: "memPct", label: "Memória (%)", min: 1, max: 100 },
  { key: "tempC", label: "Temperatura (°C)", min: 20, max: 150 },
  { key: "latencyMs", label: "Latência (ms)", min: 1, max: 10000 },
  { key: "lossPct", label: "Perda de pacotes (%)", min: 1, max: 100 },
];

export function EmailAlertsCard() {
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ["email-alerts"],
    queryFn: async () => {
      const r = await getEmailAlertStatus();
      if (!r.ok) throw new Error(r.error);
      return r.data;
    },
    refetchInterval: 60_000,
  });

  const [settings, setSettings] = useState<EmailAlertSettings>(DEFAULT_SETTINGS);
  const [targetsText, setTargetsText] = useState(DEFAULT_SETTINGS.targets.join(", "));
  const [apiKey, setApiKey] = useState("");
  const hydrated = useRef(false);

  const applySettings = (s: EmailAlertSettings) => {
    setSettings(s);
    setTargetsText(s.targets.join(", "));
  };

  // Preenche o formulário só na primeira carga: a consulta é refeita a cada minuto (último envio,
  // problemas ativos) e não pode apagar o que o usuário está editando.
  useEffect(() => {
    if (status && !hydrated.current) {
      hydrated.current = true;
      applySettings(status.settings);
    }
  }, [status]);

  const onStatus = (next: EmailAlertStatus) => {
    queryClient.setQueryData(["email-alerts"], next);
    applySettings(next.settings);
    setApiKey("");
  };

  const save = useMutation({
    mutationFn: () =>
      saveEmailAlertSettings({ ...settings, targets: targetsText.split(/[,;\s]+/).filter(Boolean) }, apiKey.trim() || undefined),
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.error);
      onStatus(result.data);
      toast.success("Configuração dos alertas salva");
    },
    onError: (err) => toast.error(err.message),
  });

  const test = useMutation({
    mutationFn: () => sendTestAlertEmail(),
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.error);
      queryClient.invalidateQueries({ queryKey: ["email-alerts"] });
      toast.success("E-mail de teste enviado. Confira a caixa de entrada (e o spam).");
    },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteResendKey(),
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.error);
      onStatus(result.data);
      toast.success("Chave removida");
    },
    onError: (err) => toast.error(err.message),
  });

  const setThreshold = (key: keyof AlertThresholds, value: string) =>
    setSettings((s) => ({ ...s, thresholds: { ...s.thresholds, [key]: Number(value) } }));

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  const keepsCurrentKey = Boolean(status?.hasKey);
  // Destinatário e chave só são obrigatórios para ativar; desativado, dá para salvar o resto.
  const canSave = !!status && !save.isPending && (!settings.enabled || (!!settings.to.trim() && (keepsCurrentKey || !!apiKey.trim())));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellIcon size={16} className="text-primary" />
          Alertas por e-mail
        </CardTitle>
        <CardDescription>
          Avisa por e-mail (via Resend) quando um equipamento vigiado fica fora do ar ou com desempenho degradado, e quando um
          equipamento SNMP cadastrado em Equipamentos passa dos limites de CPU, memória ou temperatura. Checa a cada minuto no
          servidor e manda outro e-mail quando o problema passa.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {!status ? (
          <p className="text-muted-foreground">Verificando…</p>
        ) : status.settings.enabled && status.hasKey ? (
          <p>
            <span className="text-primary">● Ativos</span> — para {status.settings.to}
            {status.keyHint && (
              <>
                , chave terminada em <code className="font-mono">…{status.keyHint}</code>
              </>
            )}
            .
            {status.lastDelivery && (
              <>
                {" "}
                Último e-mail {formatDateTime(status.lastDelivery.at)}:{" "}
                {status.lastDelivery.ok ? (
                  <span className="text-emerald-600">enviado</span>
                ) : (
                  <span className="text-destructive">falhou ({status.lastDelivery.error})</span>
                )}
                .
              </>
            )}
            {status.pending > 0 && ` ${status.pending} e-mail(s) aguardando a internet voltar.`}
          </p>
        ) : (
          <p className="text-muted-foreground">
            <span className="text-foreground">● Desativados.</span> Cadastre a chave da API do Resend (crie em{" "}
            <a href="https://resend.com/api-keys" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              resend.com/api-keys
            </a>
            ), informe o e-mail que recebe os alertas e marque &ldquo;Ativar alertas&rdquo;.
          </p>
        )}

        {!!status?.active.length && (
          <ul className="flex flex-col gap-1 text-destructive">
            {status.active.map((p) => {
              const [host, kind] = p.key.split("|");
              return (
                <li key={p.key}>
                  ● {host}: {PROBLEM_LABELS[kind] ?? kind}
                  {p.since && ` desde ${formatDateTime(new Date(p.since))}`}
                </li>
              );
            })}
          </ul>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label={keepsCurrentKey ? "Nova chave do Resend (deixe vazio para manter)" : "Chave da API do Resend"} htmlFor="resend-key" className="sm:flex-1">
              <Input
                id="resend-key"
                type="password"
                autoComplete="off"
                placeholder="re_..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Remetente" htmlFor="alert-from" className="sm:w-72">
              <Input id="alert-from" value={settings.from} onChange={(e) => setSettings({ ...settings, from: e.target.value })} placeholder={DEFAULT_SETTINGS.from} />
            </Field>
            <Field label="Enviar alertas para" htmlFor="alert-to" className="sm:w-72">
              <Input
                id="alert-to"
                type="email"
                multiple
                value={settings.to}
                onChange={(e) => setSettings({ ...settings, to: e.target.value })}
                placeholder="voce@exemplo.com"
              />
            </Field>
          </div>

          <Field label="Equipamentos vigiados (fora do ar e desempenho) — IPs separados por vírgula" htmlFor="alert-targets">
            <Input
              id="alert-targets"
              value={targetsText}
              onChange={(e) => setTargetsText(e.target.value)}
              placeholder="192.168.0.1, 192.168.0.2, 192.168.0.3"
              className="font-mono"
            />
          </Field>

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            {THRESHOLD_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`alert-${f.key}`} className="sm:w-36">
                <Input
                  id={`alert-${f.key}`}
                  type="number"
                  min={f.min}
                  max={f.max}
                  value={settings.thresholds[f.key]}
                  onChange={(e) => setThreshold(f.key, e.target.value)}
                />
              </Field>
            ))}
            <Field label="Intervalo mínimo entre alertas" htmlFor="alert-cooldown">
              <SimpleSelect
                id="alert-cooldown"
                value={String(settings.cooldownMinutes) as CooldownKey}
                onChange={(v) => setSettings({ ...settings, cooldownMinutes: Number(v) })}
                options={COOLDOWNS}
                className="sm:w-40"
              />
            </Field>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Label className="flex items-center gap-2 text-sm font-normal">
              <input
                type="checkbox"
                className="accent-primary"
                checked={settings.enabled}
                onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
              />
              Ativar alertas
            </Label>
            <Button type="submit" disabled={!canSave} className="w-fit">
              {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Salvar
            </Button>
            <Button type="button" variant="outline" onClick={() => test.mutate()} disabled={!status?.hasKey || test.isPending} className="w-fit">
              {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Enviar e-mail de teste
            </Button>
            {status?.hasKey && (
              <Button type="button" variant="outline" onClick={() => remove.mutate()} disabled={remove.isPending} className="w-fit">
                Remover chave
              </Button>
            )}
          </div>
        </form>

        <p className="text-xs text-muted-foreground">
          CPU, memória e temperatura são lidos por SNMP dos equipamentos cadastrados em Equipamentos
          {status?.snmpEquipment.length ? ` (${status.snmpEquipment.map((e) => `${e.name} ${e.ip}`).join(", ")})` : " (nenhum cadastrado ainda)"}.
          O remetente padrão <code className="font-mono">onboarding@resend.dev</code> só entrega para o e-mail da conta Resend; para
          outros destinatários, verifique um domínio no Resend e use um remetente dele. A chave fica criptografada no banco e nunca
          volta ao navegador.
        </p>
      </CardContent>
    </Card>
  );
}
