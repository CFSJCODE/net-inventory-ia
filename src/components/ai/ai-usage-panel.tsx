"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { getAiProviderUsage, getAiUsage } from "@/app/actions/ai-actions";
import { useCan } from "@/components/auth/user-provider";
import { SimpleSelect } from "@/components/tools/tool-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { USAGE_PERIODS, type UsagePeriod } from "@/lib/ai/usage-types";
import { PROVIDERS } from "@/lib/ai/providers";
import { formatDateTime } from "@/lib/format-time";
import { useAiStatus } from "./ai-common";

const number = (value: number | null | undefined) => value == null ? "Não informado" : value.toLocaleString("pt-BR");
const money = (value: number | null | undefined) => value == null ? "Não informado" : value.toLocaleString("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });
const FEATURES: Record<string, string> = { assistant: "Chat", identify: "Identificação de dispositivos", "security-device": "Segurança do dispositivo", "security-network": "Segurança da rede", summary: "Resumo de eventos", "connection-test": "Teste de conexão" };
const DASHBOARDS: Record<string, string> = { openrouter: "https://openrouter.ai/settings/credits", openai: "https://platform.openai.com/usage", gemini: "https://aistudio.google.com/usage", groq: "https://console.groq.com/dashboard/usage" };

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <Card className="gap-3 py-4"><CardHeader className="px-4"><CardDescription>{label}</CardDescription><CardTitle className="break-words text-2xl font-semibold tabular-nums tracking-tight">{value}</CardTitle></CardHeader><CardContent className="px-4 text-xs leading-relaxed text-muted-foreground">{detail}</CardContent></Card>;
}

export function AiUsagePanel() {
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const canManage = useCan("settings.manage");
  const { data: ai } = useAiStatus();
  const local = useQuery({ queryKey: ["ai-usage", period], queryFn: async () => {
    const result = await getAiUsage(period);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  } });
  const remote = useQuery({ queryKey: ["ai-provider-usage", ai?.provider, ai?.model, ai?.configured], enabled: canManage && !!ai,
    staleTime: 60_000, retry: false, queryFn: async () => {
      const result = await getAiProviderUsage();
      if (!result.ok) throw new Error(result.error);
      return result.data;
    } });
  const data = local.data;
  const provider = remote.data;
  const fetching = local.isFetching || remote.isFetching;
  const dashboard = ai ? DASHBOARDS[ai.provider] : undefined;

  return <div className="flex min-w-0 flex-col gap-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div><h2 className="text-lg font-semibold">Uso e limites</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Consumo desta instalação e disponibilidade no provedor de IA.</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="ai-usage-period" className="sr-only">Período do consumo local</label>
        <SimpleSelect id="ai-usage-period" value={period} onChange={setPeriod} options={USAGE_PERIODS} />
        <Button variant="outline" disabled={fetching} onClick={() => { void local.refetch(); if (canManage) void remote.refetch(); }}>
          {fetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Atualizar
        </Button>
      </div>
    </div>

    <Card>
      <CardHeader><CardTitle className="text-base">Créditos e limites do provedor</CardTitle><CardDescription>{ai?.providerName ?? "Carregando provedor…"}{ai?.model && <span className="mt-1 block break-all font-mono text-xs">{ai.model}</span>}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!canManage ? <p className="text-sm text-muted-foreground">Somente administradores podem consultar os créditos e limites da chave. O consumo local está disponível abaixo.</p> : <>
          {remote.isPending && <p className="text-sm text-muted-foreground" role="status">Consultando o provedor…</p>}
          {remote.error && <p role="alert" className="text-sm text-destructive">{remote.error.message}</p>}
          {provider && <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Créditos restantes na conta" value={money(provider.accountBalance)} detail="Saldo da conta no provedor, em USD." />
              <Metric label="Disponível no limite da chave" value={money(provider.keyRemaining)} detail={provider.keyLimit === null ? "Limite não informado ou sem teto definido." : `Teto da chave: ${money(provider.keyLimit)}.`} />
              <Metric label="Consumo acumulado da chave" value={money(provider.keyUsage)} detail="Inclui uso da mesma chave fora desta instalação." />
              <Metric label="Requisições gratuitas restantes" value={number(provider.freeRequestsRemaining)} detail={provider.freeRequestsLimit === null ? "Cota diária não informada pelo provedor." : `${number(provider.freeRequestsUsed)} de ${number(provider.freeRequestsLimit)} usadas no dia UTC.`} />
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground" role="status">{provider.message}</p>
            {provider.state === "available" && <dl className="grid gap-4 text-sm sm:grid-cols-3">
              <div><dt className="text-muted-foreground">Consumo da chave hoje (UTC)</dt><dd className="mt-1 font-medium">{money(provider.dailyUsage)}</dd></div>
              <div><dt className="text-muted-foreground">Consumo da chave no mês (UTC)</dt><dd className="mt-1 font-medium">{money(provider.monthlyUsage)}</dd></div>
              <div><dt className="text-muted-foreground">Renovação do limite da chave</dt><dd className="mt-1 font-medium">{({ daily: "Diária", weekly: "Semanal", monthly: "Mensal" } as Record<string, string>)[provider.reset ?? ""] ?? "Não informada"}</dd></div>
            </dl>}
            <p className="text-xs text-muted-foreground">Consulta em {formatDateTime(provider.checkedAt)}. O filtro de período abaixo se aplica apenas ao consumo local.</p>
          </>}
        </>}
        {canManage && dashboard && <a href={dashboard} target="_blank" rel="noreferrer" className="flex w-fit items-center gap-2 text-sm text-primary underline underline-offset-4">Abrir painel do provedor<ExternalLink className="size-3.5" /></a>}
      </CardContent>
    </Card>

    <section aria-label="Métricas de consumo local" className="flex flex-col gap-4">
      <div><h3 className="text-base font-semibold">Consumo nesta instalação</h3><p className="mt-2 text-sm text-muted-foreground">{USAGE_PERIODS[period]}. Inclui todos os provedores, análises, chat e testes de conexão.</p></div>
      {local.isPending && <p role="status" className="text-sm text-muted-foreground">Carregando métricas…</p>}
      {local.error && <p role="alert" className="text-sm text-destructive">Não foi possível carregar as métricas. Verifique se a atualização do aplicativo foi concluída e tente atualizar o painel.</p>}
      {data && <>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Tokens gastos" value={number(data.totalTokens)} detail={`${number(data.inputTokens)} de entrada · ${number(data.outputTokens)} de saída`} />
          <Metric label="Chamadas ao provedor" value={number(data.requests)} detail={`${number(data.successful)} concluídas · ${number(data.errors)} com falha`} />
          <Metric label="Custo informado" value={money(data.costUsd)} detail={`${number(data.costReports)} de ${number(data.requests)} chamadas informaram custo em USD.`} />
          <Metric label="Respostas reutilizadas" value={number(data.cacheHits)} detail="Análises servidas pelo cache local, sem nova chamada ao provedor." />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <p>Tempo médio por chamada: <strong className="font-medium text-foreground">{data.averageDurationMs == null ? "Não informado" : `${(data.averageDurationMs / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} s`}</strong></p>
          <p>Chamadas com tokens informados: <strong className="font-medium text-foreground">{number(data.tokenReports)} / {number(data.requests)}</strong></p>
        </div>
        <Card><CardHeader><CardTitle className="text-base">Consumo por recurso e modelo</CardTitle><CardDescription>Uma pergunta no chat pode gerar várias chamadas para consultar o inventário. Os registros em cache também entram na coluna de registros.</CardDescription></CardHeader>
          <CardContent>
            {!data.features.length ? <p className="text-sm text-muted-foreground">Nenhum uso registrado neste período. As métricas começam a ser coletadas com esta atualização.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-xs text-muted-foreground"><th scope="col" className="pb-3 pr-4 font-medium">Recurso / modelo</th><th scope="col" className="pb-3 pr-4 text-right font-medium">Registros</th><th scope="col" className="pb-3 pr-4 text-right font-medium">Tokens</th><th scope="col" className="pb-3 text-right font-medium">Custo (USD)</th></tr></thead><tbody>{data.features.map((row) => <tr key={`${row.feature}:${row.provider}:${row.model}`} className="border-b last:border-0"><td className="max-w-72 py-4 pr-4"><span className="font-medium">{FEATURES[row.feature] ?? row.feature}</span><span className="mt-1 block break-all text-xs text-muted-foreground">{PROVIDERS[row.provider as keyof typeof PROVIDERS]?.name ?? row.provider} · {row.model}</span></td><td className="py-4 pr-4 text-right tabular-nums">{number(row.events)}</td><td className="py-4 pr-4 text-right tabular-nums">{number(row.totalTokens)}</td><td className="whitespace-nowrap py-4 text-right tabular-nums">{money(row.costUsd)}</td></tr>)}</tbody></table></div>}
          </CardContent>
        </Card>
        <p className="text-xs leading-relaxed text-muted-foreground">{data.trackingSince ? `Coleta iniciada em ${formatDateTime(data.trackingSince)}.` : "A coleta começa na primeira chamada ou resposta reutilizada após esta atualização."} Não há recuperação do consumo anterior. Tokens e custos ausentes na resposta do provedor aparecem como não informados; totais podem ser parciais. O registro guarda somente metadados de consumo.</p>
      </>}
    </section>
  </div>;
}
