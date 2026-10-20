"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { appendNestSample, nestBoolean, nestChanges, nestConnection, nestHistoryStats, nestSample, nestValue, NEST_FIELD_LABELS, type NestDetails, type NestEndpoint, type NestGroup, type NestSample } from "@/lib/network/nest-monitoring";

type Tone = "ok" | "warning" | "error" | "neutral";
const TONES: Record<Tone, string> = {
  ok: "border-emerald-900 bg-emerald-950 text-emerald-400",
  warning: "border-amber-900 bg-amber-950 text-amber-400",
  error: "border-red-900 bg-red-950 text-red-400",
  neutral: "border-border text-muted-foreground",
};
function State({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <Badge variant="outline" className={`w-fit gap-1.5 font-normal ${TONES[tone]}`}>{children}</Badge>;
}
function Metric({ label, children, hint, large = false }: { label: string; children: ReactNode; hint?: string; large?: boolean }) {
  return <div className="flex min-w-0 flex-col gap-0.5"><span className="text-xs text-muted-foreground">{label}</span><span className={`break-words tabular-nums ${large ? "text-2xl font-semibold" : "text-base font-medium"}`}>{children}</span>{hint && <span className="text-xs text-muted-foreground">{hint}</span>}</div>;
}
function BooleanState({ value, yes, no, yesTone = "ok", noTone = "neutral" }: { value: boolean | null; yes: string; no: string; yesTone?: Tone; noTone?: Tone }) {
  return <State tone={value === true ? yesTone : value === false ? noTone : "neutral"}>{value === true ? yes : value === false ? no : "Não informado"}</State>;
}
function InfoCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <Card><CardHeader className="pb-3"><CardTitle className="text-base">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent>{children}</CardContent></Card>;
}
function GroupFields({ group }: { group?: NestGroup }) {
  return <dl className="grid gap-3 gap-x-6 sm:grid-cols-2">{group?.fields.map(field => <div key={field.name} className="flex min-w-0 flex-col gap-0.5"><dt className="text-xs text-muted-foreground">{NEST_FIELD_LABELS[field.name] ?? field.name}</dt><dd className="break-all text-sm">{field.value}</dd></div>)}</dl>;
}
function History({ samples }: { samples: NestSample[] }) {
  const stats = nestHistoryStats(samples);
  const changes = nestChanges(samples);
  const max = Math.max(1, stats.maxMs ?? 1);
  const point = (sample: NestSample, index: number) => `${samples.length <= 1 ? 10 : 10 + index / (samples.length - 1) * 580},${90 - (sample.durationMs ?? 0) / max * 70}`;
  return <InfoCard title="Histórico desta sessão" description="Até 60 consultas enquanto esta página está aberta. Ao sair ou recarregar, esta janela recomeça.">
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-8">
        <Metric large label="Disponibilidade da API" hint={`${stats.successful} de ${stats.count} consultas válidas`}>{stats.availablePct === null ? "—" : `${stats.availablePct}%`}</Metric>
        <Metric large label="Resposta média" hint={`Mín. ${stats.minMs ?? "—"} · máx. ${stats.maxMs ?? "—"} ms`}>{stats.averageMs === null ? "—" : `${stats.averageMs} ms`}</Metric>
        <Metric large label="Consultas com falha">{stats.errors}</Metric>
      </div>
      {samples.length > 1 ? <div className="rounded-md border bg-muted/20 p-3"><p className="mb-2 text-xs text-muted-foreground">Tempo de resposta das consultas válidas · escala até {max} ms</p><svg viewBox="0 0 600 110" className="h-32 w-full" role="img" aria-label="Evolução do tempo de resposta da API nesta sessão"><line x1="10" y1="90" x2="590" y2="90" stroke="currentColor" opacity="0.2" />{samples.map((sample, index) => {
        const previous = samples[index - 1];
        const [x, y] = point(sample, index).split(",");
        return <g key={sample.readAt}>{previous?.ok && sample.ok && previous.durationMs !== null && sample.durationMs !== null && <polyline points={`${point(previous, index - 1)} ${point(sample, index)}`} fill="none" stroke="currentColor" className="text-primary" strokeWidth="2" />}<circle cx={x} cy={sample.ok && sample.durationMs !== null ? y : "100"} r="3" fill="currentColor" className={sample.ok ? "text-primary" : "text-destructive"}><title>{new Date(sample.readAt).toLocaleTimeString("pt-BR")} · {sample.ok ? `${sample.durationMs ?? "—"} ms` : "Falha na consulta"}</title></circle></g>;
      })}</svg><p className="text-xs text-muted-foreground">Pontos vermelhos indicam consultas com falha. A disponibilidade mede acesso à API.</p></div> : <p className="text-sm text-muted-foreground">O gráfico aparecerá a partir da segunda consulta. Use a leitura automática ou Atualizar agora.</p>}
      {changes.length > 0 && <div className="flex flex-col gap-2 rounded-md border p-3"><p className="text-sm font-medium">Mudanças observadas</p>{changes.map(change => <p key={change} className="text-sm text-muted-foreground">{change}</p>)}</div>}
      <details><summary className="cursor-pointer text-sm font-medium">Últimas consultas ({Math.min(samples.length, 8)})</summary><div className="mt-3 overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Horário</TableHead><TableHead>API</TableHead><TableHead>Resposta</TableHead><TableHead>Conexão informada</TableHead></TableRow></TableHeader><TableBody>{samples.slice(-8).reverse().map(sample => <TableRow key={sample.readAt}><TableCell className="text-xs">{new Date(sample.readAt).toLocaleTimeString("pt-BR")}</TableCell><TableCell><State tone={sample.ok ? "ok" : "error"}>{sample.ok ? `HTTP ${sample.httpStatus}` : "Falha"}</State></TableCell><TableCell className="font-mono text-xs">{sample.durationMs === null ? "—" : `${sample.durationMs} ms`}</TableCell><TableCell className="text-xs">{sample.connected === true ? "Conectado" : sample.connected === false ? "Desconectado" : "Não informado"}</TableCell></TableRow>)}</TableBody></Table></div></details>
    </div>
  </InfoCard>;
}

/** Reutiliza o cabeçalho, os controles de atualização e a leitura automática do painel do switch. */
export function NestMonitoringPanel({ endpoint }: { endpoint: NestEndpoint }) {
  const current = endpoint.ok ? endpoint.details : null;
  const [lastValid, setLastValid] = useState<{ details: NestDetails; readAt: string } | null>(current ? { details: current, readAt: endpoint.readAt } : null);
  const [history, setHistory] = useState<NestSample[]>(() => [nestSample(endpoint)]);
  useEffect(() => {
    setHistory(previous => appendNestSample(previous, nestSample(endpoint)));
    if (endpoint.ok && endpoint.details) setLastValid({ details: endpoint.details, readAt: endpoint.readAt });
  }, [endpoint]);
  const data = current ?? lastValid?.details ?? null;
  const readAt = current ? endpoint.readAt : lastValid?.readAt;
  const samples = appendNestSample(history, nestSample(endpoint));
  const group = (title: string) => data?.groups.find(item => item.title === title);
  const connected = nestBoolean(data, "connected");
  const hasUpdate = nestBoolean(data, "has_update");
  const configured = nestBoolean(data, "wpa_configured");
  const capabilities = group("Recursos suportados")?.fields ?? [];
  const coverage = data?.groups.flatMap(item => item.fields) ?? [];

  return <div className="flex min-w-0 flex-col gap-4" aria-label="Painel de monitoramento do Nest">
    <InfoCard title="Visão geral do Nest" description={`${endpoint.name} · ${new Date(endpoint.readAt).toLocaleString("pt-BR")} · última tentativa de consulta.`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2"><State tone={endpoint.ok ? "ok" : "error"}>{endpoint.ok ? `API disponível · HTTP ${endpoint.httpStatus}` : "API indisponível nesta consulta"}</State>{!current && lastValid && <State tone="warning">Dados da última leitura válida</State>}<BooleanState value={connected} yes="Nest informa conexão ativa" no="Nest informa desconexão" noTone="error" /><State>{nestConnection(data)}</State><BooleanState value={hasUpdate} yes="Atualização sinalizada" no="Nenhuma atualização sinalizada" yesTone="warning" /></div>
        {!current && <div role="status" className="rounded-md border p-3 text-sm"><p className="text-destructive">{endpoint.error ?? "Esta consulta não trouxe informações do Nest."}</p><p className="mt-1 text-muted-foreground">{readAt ? `Mostrando a última leitura válida de ${new Date(readAt).toLocaleString("pt-BR")}.` : "Ainda não há uma leitura válida para exibir."} Falha de acesso à API não confirma que o aparelho esteja desligado.</p></div>}
        <div className="flex flex-wrap gap-8"><Metric label="Aparelho">{nestValue(data, "name")}</Metric><Metric label="Ligado há" hint="Informado pelo aparelho na leitura">{nestValue(data, "uptime").replace(/ \([\d.,]+ s\)$/, "")}</Metric><Metric label="Endereço IP">{nestValue(data, "ip_address")}</Metric><Metric label="Última resposta da API">{Number.isFinite(endpoint.durationMs) ? `${endpoint.durationMs} ms` : "Não informado"}</Metric></div>
        {(connected === false || configured === false) && <p className="text-sm text-destructive">{connected === false ? "O campo connected veio como false. Verifique a conexão do aparelho." : "O aparelho informou wpa_configured como false. Verifique sua configuração Wi-Fi."}{!current && " Este aviso pertence à última leitura válida."}</p>}
      </div>
    </InfoCard>

    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <InfoCard title="Rede e conexão" description="Conexão e identificação do Wi-Fi informadas pelo Nest."><div className="flex flex-col gap-4"><div className="flex flex-wrap gap-2"><BooleanState value={nestBoolean(data, "ethernet_connected")} yes="Ethernet conectada" no="Ethernet não conectada" /><BooleanState value={configured} yes="Wi-Fi configurado" no="Wi-Fi não configurado" noTone="warning" /></div><GroupFields group={group("Rede Wi-Fi")} /></div></InfoCard>
      <InfoCard title="Firmware e sistema" description="Compilação, versão Cast e preferências do aparelho."><div className="flex flex-col gap-4"><GroupFields group={group("Firmware")} /><GroupFields group={group("Idioma e horário")} /><p className="text-xs text-muted-foreground">A sinalização de atualização é local. Códigos de horário e WPA são mantidos como informados pelo firmware.</p></div></InfoCard>
    </div>

    <History samples={samples} />

    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <InfoCard title="Recursos do aparelho" description="Capacidades declaradas pelo firmware nesta leitura."><div className="flex flex-col gap-3">{capabilities.length ? capabilities.map(field => <div key={field.name} className="flex flex-wrap items-center justify-between gap-2"><span className="break-all text-sm">{NEST_FIELD_LABELS[field.name] ?? field.name.replace("device_info.capabilities.", "")}</span><BooleanState value={nestBoolean(data, field.name)} yes="Suportado" no="Não suportado" /></div>) : <p className="text-sm text-muted-foreground">Nenhuma capacidade informada.</p>}</div></InfoCard>
      <InfoCard title="Diagnósticos e configuração" description="Participação em relatórios e contadores internos de configuração."><div className="flex flex-col gap-4"><div className="flex flex-wrap gap-2"><BooleanState value={nestBoolean(data, "opt_in.crash")} yes="Relatórios de falhas: participa" no="Relatórios de falhas: não participa" yesTone="neutral" /><BooleanState value={nestBoolean(data, "opt_in.stats")} yes="Estatísticas: participa" no="Estatísticas: não participa" yesTone="neutral" /></div><GroupFields group={group("Configuração inicial")} /><p className="text-xs text-muted-foreground">Participar dos relatórios não indica falhas ativas. Os contadores representam eventos de configuração; não medem tráfego ou qualidade do Wi-Fi.</p></div></InfoCard>
    </div>

    <InfoCard title="Identificação e detalhes técnicos" description={`${coverage.filter(field => field.present).length} de ${coverage.length} campos presentes na última leitura válida.`}>
      <div className="flex flex-col gap-4"><GroupFields group={group("Identificação do aparelho")} /><GroupFields group={group("Outros indicadores")} /><details><summary className="cursor-pointer text-sm font-medium">Ver todos os campos informados pelo aparelho</summary><div className="mt-3 overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Informação</TableHead><TableHead>Campo</TableHead><TableHead>Valor informado</TableHead></TableRow></TableHeader><TableBody>{data?.groups.flatMap(item => item.fields.map(field => <TableRow key={`${item.title}-${field.name}`}><TableCell className="whitespace-normal align-top">{item.title}</TableCell><TableCell className="break-all whitespace-normal align-top font-mono text-xs">{field.name}</TableCell><TableCell className="min-w-48 break-all whitespace-normal align-top">{field.value}</TableCell></TableRow>))}</TableBody></Table></div></details></div>
    </InfoCard>
    <p className="text-xs text-muted-foreground">CPU, memória, temperatura e intensidade do sinal Wi-Fi não foram informados por esta API. As consultas seguem a leitura automática configurada no cabeçalho.</p>
  </div>;
}
