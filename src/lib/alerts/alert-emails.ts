/**
 * Conteúdo dos e-mails de alerta, de recuperação e de teste: o que cada um diz e quais leituras e
 * limites mostra. Puro (sem rede nem banco): recebe a última leitura do equipamento e os limites e
 * devolve assunto, HTML e texto. A medição fica em alert-monitor.ts e o visual em email-template.ts.
 */

import type { AlertThresholds, EmailAlertSettings } from "./email-defaults";
import { renderEmail, type EmailContent, type EmailReading, type EmailSection, type EmailTone } from "./email-template";
import { formatDuration } from "./rules";

export type CheckKind = "offline" | "degraded" | "criticalLatency" | "cpu" | "mem" | "temp";

/** Última leitura de um equipamento, guardada a cada rodada para os e-mails mostrarem a situação atual. */
export interface HostReading {
  /** Quando foi medida. */
  at: number;
  /** Respondeu ao ping ou ao SNMP. */
  online: boolean;
  pingsSent: number;
  pingsReceived: number;
  /** Latência média desta rodada (null sem resposta). */
  latencyMs: number | null;
  lossPct: number;
  cpuPct: number | null;
  memPct: number | null;
  tempC: number | null;
  /** sysUpTime do equipamento (SNMP), em minutos. */
  uptimeMin: number | null;
  /** Desde quando responde / não responde, segundo as verificações do NetInventory. */
  onlineSince: number | null;
  offlineSince: number | null;
  /** Última vez que respondeu (ping ou SNMP); fica quando o equipamento cai. */
  lastSeen: number | null;
  /** Último ping respondido e a latência dele (o SNMP pode responder sem o ping, por isso são separados). */
  lastPingAt: number | null;
  lastLatencyMs: number | null;
}

export interface WatchedTarget {
  host: string;
  /** Apelido ou hostname, sem o IP; null quando não há. */
  label: string | null;
}

export const targetName = (t: WatchedTarget) => (t.label ? `${t.label} (${t.host})` : t.host);

export interface Observation {
  kind: CheckKind;
  bad: boolean;
  /** Valor principal (latência, %, °C), guardado no estado da checagem. */
  value: number | null;
  /** Resumo de uma linha, para o log e para o assunto. */
  detail: string;
}

/** O que cada equipamento tem a dizer nesta rodada: fora do ar e degradado só para os da lista vigiada. */
export function observe(reading: HostReading, t: AlertThresholds, watched: boolean): Observation[] {
  const obs: Observation[] = [];
  if (watched) {
    obs.push({ kind: "offline", bad: !reading.online, value: null, detail: `Sem resposta a ${reading.pingsSent} pings seguidos` });
    if (reading.pingsReceived > 0) {
      const avg = reading.latencyMs ?? 0;
      obs.push({
        kind: "degraded",
        bad: avg > t.latencyMs || reading.lossPct >= t.lossPct,
        value: avg,
        detail: `Latência média ${avg} ms (limite ${t.latencyMs} ms), perda de pacotes ${reading.lossPct}% (limite ${t.lossPct}%)`,
      });
      obs.push({
        kind: "criticalLatency",
        bad: avg > t.criticalLatencyMs,
        value: avg,
        detail: `Latência média ${avg} ms (limite crítico ${t.criticalLatencyMs} ms)`,
      });
    }
  }
  if (reading.cpuPct !== null) obs.push({ kind: "cpu", bad: reading.cpuPct >= t.cpuPct, value: reading.cpuPct, detail: `CPU em ${reading.cpuPct}% (limite ${t.cpuPct}%)` });
  if (reading.memPct !== null) obs.push({ kind: "mem", bad: reading.memPct >= t.memPct, value: reading.memPct, detail: `Memória em ${reading.memPct}% (limite ${t.memPct}%)` });
  if (reading.tempC !== null) obs.push({ kind: "temp", bad: reading.tempC >= t.tempC, value: reading.tempC, detail: `Temperatura em ${reading.tempC} °C (limite ${t.tempC} °C)` });
  return obs;
}

/** Filtros de métricas para os dois perfis configuráveis de envio. */
export function selectAlertObservations(observations: Observation[], mode: EmailAlertSettings["mode"]): Observation[] {
  return mode === "all"
    ? observations.filter((o) => o.kind !== "criticalLatency")
    : observations.filter((o) => o.kind === "offline" || o.kind === "criticalLatency");
}

const KINDS: Record<CheckKind, { alert: string; recovery: string; tone: EmailTone; emoji: string }> = {
  offline: { alert: "Fora do ar", recovery: "Voltou ao ar", tone: "critical", emoji: "🔴" },
  degraded: { alert: "Desempenho degradado", recovery: "Desempenho normalizado", tone: "warning", emoji: "🟠" },
  criticalLatency: { alert: "Latência crítica", recovery: "Latência normalizada", tone: "critical", emoji: "🔴" },
  cpu: { alert: "CPU alta", recovery: "CPU normalizada", tone: "warning", emoji: "🟠" },
  mem: { alert: "Memória alta", recovery: "Memória normalizada", tone: "warning", emoji: "🟠" },
  temp: { alert: "Temperatura alta", recovery: "Temperatura normalizada", tone: "critical", emoji: "🔴" },
};

export const alertTitle = (kind: CheckKind) => KINDS[kind].alert;
export const recoveryTitle = (kind: CheckKind) => KINDS[kind].recovery;

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${date} às ${time}`;
}

const pct = (n: number) => `${n}%`;
const ms = (n: number) => `${n} ms`;
const celsius = (n: number) => `${n} °C`;
/** "93%, acima do limite de 90%" ou "90%, igual ao limite de 90%": CPU, memória e temperatura alertam a partir do limite. */
const vsLimit = (value: number, limit: number, fmt: (n: number) => string) => `${fmt(value)}, ${value > limit ? "acima do" : "igual ao"} limite de ${fmt(limit)}`;
/** Rótulo do endereço vigiado: a lista aceita IPs e nomes. */
const addressLabel = (host: string) => (/^[\d.]+$|:/.test(host) ? "Endereço IP" : "Endereço");

/** Medidas da leitura, com barra e limite. Só o que o equipamento informa. */
function readingGauges(r: HostReading, t: AlertThresholds): EmailReading[] {
  const g: EmailReading[] = [];
  if (r.latencyMs !== null) {
    const max = Math.max(t.latencyMs * 2, r.latencyMs);
    g.push({ label: "Latência média", value: ms(r.latencyMs), limit: `> ${ms(t.latencyMs)}`, bar: { value: r.latencyMs / max, limit: t.latencyMs / max }, bad: r.latencyMs > t.latencyMs });
  }
  if (r.pingsReceived > 0) {
    g.push({ label: "Perda de pacotes", value: pct(r.lossPct), limit: `≥ ${pct(t.lossPct)}`, bar: { value: r.lossPct / 100, limit: t.lossPct / 100 }, bad: r.lossPct >= t.lossPct });
  }
  if (r.cpuPct !== null) g.push({ label: "CPU", value: pct(r.cpuPct), limit: `≥ ${pct(t.cpuPct)}`, bar: { value: r.cpuPct / 100, limit: t.cpuPct / 100 }, bad: r.cpuPct >= t.cpuPct });
  if (r.memPct !== null) g.push({ label: "Memória", value: pct(r.memPct), limit: `≥ ${pct(t.memPct)}`, bar: { value: r.memPct / 100, limit: t.memPct / 100 }, bad: r.memPct >= t.memPct });
  if (r.tempC !== null) {
    const max = Math.max(t.tempC * 1.25, r.tempC);
    g.push({ label: "Temperatura", value: celsius(r.tempC), limit: `≥ ${celsius(t.tempC)}`, bar: { value: r.tempC / max, limit: t.tempC / max }, bad: r.tempC >= t.tempC });
  }
  return g;
}

function hasSnmpHardwareMetrics(r: HostReading): boolean {
  return r.cpuPct !== null || r.memPct !== null || r.tempC !== null;
}

function hasSnmpData(r: HostReading): boolean {
  return hasSnmpHardwareMetrics(r) || r.uptimeMin !== null;
}

/** Linhas da leitura: status, tempo de atividade, última resposta, pings. */
function readingRows(r: HostReading, snmpConfigured?: boolean): [string, string][] {
  const rows: [string, string][] = [];
  const ago = (since: number) => `há ${formatDuration(r.at - since)}, desde ${formatDateTime(since)}`;
  if (r.online) {
    rows.push(["Status", "No ar"]);
    if (r.uptimeMin !== null) rows.push(["Tempo de atividade", `${formatDuration(r.uptimeMin * 60_000)} (sysUpTime via SNMP)`]);
    else if (r.onlineSince !== null) rows.push(["Tempo respondendo", `${ago(r.onlineSince)} (monitoramento do NetInventory)`]);
  } else {
    rows.push(["Status", r.offlineSince !== null ? `Fora do ar ${ago(r.offlineSince)}` : "Fora do ar"]);
    const ping = r.lastPingAt !== null && r.lastLatencyMs !== null ? `${formatDateTime(r.lastPingAt)}, latência ${ms(r.lastLatencyMs)}` : null;
    if (r.lastSeen === null) rows.push(["Última resposta", "nenhuma desde que passou a ser vigiado"]);
    else if (ping && r.lastPingAt === r.lastSeen) rows.push(["Última resposta", ping]);
    else {
      rows.push(["Última resposta", formatDateTime(r.lastSeen)]);
      if (ping) rows.push(["Último ping respondido", ping]);
    }
  }
  rows.push(["Ping", `${r.pingsReceived} de ${r.pingsSent} respondidos${r.latencyMs !== null ? `, média ${ms(r.latencyMs)}` : ""}`]);
  if ((snmpConfigured || r.uptimeMin !== null) && r.cpuPct === null && r.memPct === null && r.tempC === null) {
    // Com uptime o SNMP respondeu: o equipamento só não informa esses dados (são OIDs HP/H3C Comware).
    rows.push([
      "CPU, memória e temperatura",
      r.uptimeMin !== null
        ? "não informados por este equipamento (são lidos de switches HP/H3C Comware)"
        : "não lidos (sem SNMP cadastrado em Equipamentos, ou sem resposta SNMP)",
    ]);
  }
  rows.push(["Leitura em", formatDateTime(r.at)]);
  return rows;
}

export function readingSection(title: string, r: HostReading | null, t: AlertThresholds, snmpConfigured?: boolean): EmailSection {
  if (!r) return { title, rows: [["Status", "ainda sem leitura (a primeira verificação acontece em até 1 min)"]] };
  return { title, readings: readingGauges(r, t), rows: readingRows(r, snmpConfigured) };
}

export function limitsSection(s: Pick<EmailAlertSettings, "thresholds" | "cooldownMinutes">, intervalMs: number, includeSnmp: boolean): EmailSection {
  const t = s.thresholds;
  const rows: [string, string][] = [];
  if (includeSnmp) {
    rows.push(
      ["CPU", `alerta a partir de ${pct(t.cpuPct)}`],
      ["Memória", `alerta a partir de ${pct(t.memPct)}`],
      ["Temperatura", `alerta a partir de ${celsius(t.tempC)}`],
    );
  }
  rows.push(
    ["Latência média", `alerta acima de ${ms(t.latencyMs)}`],
    ["Latência crítica", `alerta acima de ${ms(t.criticalLatencyMs)}`],
    ["Perda de pacotes", `alerta a partir de ${pct(t.lossPct)}`],
    ["Verificação", `a cada ${formatDuration(intervalMs)}`],
    ["Intervalo mínimo entre alertas", `${s.cooldownMinutes} min para o mesmo problema`],
  );
  return {
    title: "Limites configurados",
    rows,
  };
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

interface Common {
  target: WatchedTarget;
  observation: Observation;
  reading: HostReading;
  at: number;
  intervalMs: number;
  settings: Pick<EmailAlertSettings, "thresholds" | "cooldownMinutes">;
  /** Há configuração SNMP cadastrada para o equipamento. */
  snmpConfigured?: boolean;
  /** Quando o problema foi confirmado; pode anteceder o envio por cooldown. */
  since?: number | null;
}

export interface AlertEmailInput extends Common {
  /** Leituras seguidas com problema que confirmam um alerta (regra da checagem). */
  checks: number;
  /** Outras métricas anormais detectadas no mesmo equipamento e rodada. */
  additionalObservations?: Observation[];
}

/** O aviso saiu depois da confirmação (esperou o intervalo mínimo entre alertas). */
const isDelayed = (i: AlertEmailInput) => i.since != null && i.at - i.since >= i.intervalMs;

/** Trecho do assunto com o valor que estourou: "(93%)", "(230 ms, 25% de perda)". */
function subjectDetail(o: Observation, r: HostReading, t: AlertThresholds): string {
  switch (o.kind) {
    case "offline":
      return "";
    case "degraded": {
      const parts: string[] = [];
      if (r.latencyMs !== null && r.latencyMs > t.latencyMs) parts.push(ms(r.latencyMs));
      if (r.lossPct >= t.lossPct) parts.push(`${pct(r.lossPct)} de perda`);
      return parts.join(", ");
    }
    case "criticalLatency":
      return r.latencyMs !== null ? ms(r.latencyMs) : "";
    case "cpu":
      return r.cpuPct !== null ? pct(r.cpuPct) : "";
    case "mem":
      return r.memPct !== null ? pct(r.memPct) : "";
    case "temp":
      return r.tempC !== null ? celsius(r.tempC) : "";
  }
}

function alertSummary(i: AlertEmailInput): string {
  const { observation: o, reading: r, settings } = i;
  const t = settings.thresholds;
  const name = targetName(i.target);
  const run = isDelayed(i)
    ? `desde ${formatDateTime(i.since!)} (confirmado com ${i.checks} leituras seguidas) e continua agora`
    : i.checks <= 1 ? "na leitura atual" : `nas últimas ${i.checks} verificações seguidas`;
  switch (o.kind) {
    case "offline":
      return `${name} não respondeu a nenhum dos ${r.pingsSent} pings ${run}. O equipamento pode estar desligado, sem energia, travado ou com o cabo de rede desconectado.`;
    case "degraded": {
      const parts: string[] = [];
      if (r.latencyMs !== null && r.latencyMs > t.latencyMs) parts.push(`latência média de ${ms(r.latencyMs)} (limite ${ms(t.latencyMs)})`);
      if (r.lossPct >= t.lossPct) parts.push(`perda de ${pct(r.lossPct)} dos pacotes (limite ${pct(t.lossPct)})`);
      return `A conexão com ${name} está lenta ou instável ${run}: ${parts.join(" e ") || o.detail}.`;
    }
    case "criticalLatency":
      return `${name} está com latência média de ${ms(r.latencyMs ?? 0)}, acima do limite crítico de ${ms(t.criticalLatencyMs)}, ${run}.`;
    case "cpu":
      return `O uso de CPU de ${name} está em ${vsLimit(r.cpuPct ?? 0, t.cpuPct, pct)}, ${run}.`;
    case "mem":
      return `O uso de memória de ${name} está em ${vsLimit(r.memPct ?? 0, t.memPct, pct)}, ${run}.`;
    case "temp":
      return `A temperatura de ${name} chegou a ${vsLimit(r.tempC ?? 0, t.tempC, celsius)}, ${run}. Confira a ventilação e a temperatura do ambiente.`;
  }
}

export function buildAlertEmail(i: AlertEmailInput): BuiltEmail {
  const alerts = [i.observation, ...(i.additionalObservations ?? [])];
  const k = KINDS[i.observation.kind];
  const name = targetName(i.target);
  const detail = subjectDetail(i.observation, i.reading, i.settings.thresholds);
  const delayed = isDelayed(i);
  const when: [string, string][] = delayed
    ? [
        ["Problema desde", formatDateTime(i.since!)],
        ["Avisado em", `${formatDateTime(i.at)} (esperou o intervalo mínimo de ${i.settings.cooldownMinutes} min entre alertas)`],
      ]
    : [["Detectado em", formatDateTime(i.at)]];
  const multi = alerts.length > 1;
  const title = multi ? `${alerts.length} métricas fora do limite` : k.alert;
  const tone = alerts.some((o) => KINDS[o.kind].tone === "critical") ? "critical" : k.tone;
  const anomalies = alerts.map((o) => {
    const value = subjectDetail(o, i.reading, i.settings.thresholds);
    return `${KINDS[o.kind].alert}${value ? ` (${value})` : ""}`;
  });
  const content: EmailContent = {
    tone,
    label: "ALERTA",
    title,
    subtitle: name,
    summary: multi
      ? `Uma ou mais métricas de ${name} ultrapassaram os limites configurados: ${anomalies.join("; ")}.`
      : alertSummary(i),
    sections: [
      readingSection("Leituras atuais", i.reading, i.settings.thresholds, i.snmpConfigured),
      {
        title: "Detalhes do alerta",
        rows: [
          ["Equipamento", i.target.label ?? i.target.host],
          [addressLabel(i.target.host), i.target.host],
          ["Problema", `${k.alert}: ${i.observation.detail}`],
          ...when,
          ["Confirmação", `${i.checks} leituras seguidas com problema, uma a cada ${formatDuration(i.intervalMs)}`],
          ...alerts.map((o) => [`Métrica anormal: ${KINDS[o.kind].alert}`, o.detail] as [string, string]),
        ],
      },
      limitsSection(i.settings, i.intervalMs, i.snmpConfigured ?? hasSnmpData(i.reading)),
    ],
    notes: [
      "Você receberá outro e-mail quando o problema passar.",
      `Para não lotar sua caixa de entrada, um novo alerta deste mesmo problema só é enviado depois de ${i.settings.cooldownMinutes} min.`,
    ],
  };
  const subjectAlerts = multi ? anomalies.join(" + ") : `${k.alert}${detail ? ` (${detail})` : ""}`;
  return { subject: `${tone === "critical" ? "🔴" : k.emoji} ${subjectAlerts}: ${name}`, ...renderEmail(content) };
}

export interface RecoveryEmailInput extends Common {
  /** Quando o problema foi confirmado (null se não se sabe). */
  since: number | null;
  /** O alerta deste problema nem chegou a sair (internet caiu junto) e foi substituído por este e-mail. */
  alertUndelivered: boolean;
}

function recoverySummary(i: RecoveryEmailInput): string {
  const { observation: o, reading: r, settings } = i;
  const t = settings.thresholds;
  const name = targetName(i.target);
  const after = i.since !== null ? ` depois de ${formatDuration(i.at - i.since)}` : "";
  switch (o.kind) {
    case "offline":
      return `${name} voltou a responder${after ? `${after} fora do ar` : ""}.`;
    case "degraded":
      return `A conexão com ${name} voltou ao normal${after}: latência média de ${ms(r.latencyMs ?? 0)} e perda de ${pct(r.lossPct)} dos pacotes.`;
    case "criticalLatency":
      return `A latência de ${name} voltou ao normal${after}: ${ms(r.latencyMs ?? 0)} (limite crítico ${ms(t.criticalLatencyMs)}).`;
    case "cpu":
      return `O uso de CPU de ${name} voltou ao normal${after ? `${after} com o problema` : ""}: ${pct(r.cpuPct ?? 0)} (limite ${pct(t.cpuPct)}).`;
    case "mem":
      return `O uso de memória de ${name} voltou ao normal${after ? `${after} com o problema` : ""}: ${pct(r.memPct ?? 0)} (limite ${pct(t.memPct)}).`;
    case "temp":
      return `A temperatura de ${name} voltou ao normal${after ? `${after} com o problema` : ""}: ${celsius(r.tempC ?? 0)} (limite ${celsius(t.tempC)}).`;
  }
}

export function buildRecoveryEmail(i: RecoveryEmailInput): BuiltEmail {
  const k = KINDS[i.observation.kind];
  const name = targetName(i.target);
  const duration = i.since !== null ? formatDuration(i.at - i.since) : null;
  const rows: [string, string][] = [
    ["Equipamento", i.target.label ?? i.target.host],
    [addressLabel(i.target.host), i.target.host],
    ["Problema", k.alert],
  ];
  if (i.since !== null) rows.push(["Problema desde", formatDateTime(i.since)]);
  rows.push(["Normalizado em", formatDateTime(i.at)]);
  if (duration) rows.push(["Duração", duration]);
  const content: EmailContent = {
    tone: "ok",
    label: "RECUPERADO",
    title: k.recovery,
    subtitle: name,
    summary: recoverySummary(i),
    sections: [readingSection("Leituras atuais", i.reading, i.settings.thresholds, i.snmpConfigured), { title: "Detalhes", rows }, limitsSection(i.settings, i.intervalMs, i.snmpConfigured ?? hasSnmpData(i.reading))],
    notes: i.alertUndelivered
      ? ["O alerta deste problema não pôde ser enviado na hora, provavelmente porque a internet caiu junto com o equipamento. Ele foi substituído por este aviso."]
      : [],
  };
  return { subject: `🟢 ${k.recovery}: ${name}${duration ? ` (após ${duration})` : ""}`, ...renderEmail(content) };
}

export interface TestEmailInput {
  settings: EmailAlertSettings;
  /** Todos os equipamentos medidos (lista vigiada + SNMP cadastrados), com a leitura de agora. */
  equipment: { target: WatchedTarget; reading: HostReading | null; snmpConfigured: boolean }[];
  /** Problemas confirmados neste momento. */
  activeProblems: number;
  intervalMs: number;
  at: number;
}

/**
 * O Gmail corta e-mails acima de ~100 KB: só os primeiros equipamentos ganham a seção completa de
 * leituras (~8 KB cada), os seguintes vão num resumo de uma linha (~0,5 KB cada) e o resto só é contado.
 */
const MAX_DETAILED_READINGS = 6;
const MAX_COMPACT_READINGS = 30;

/** Resumo de uma linha da leitura, para a lista dos demais equipamentos. */
function compactReading(r: HostReading | null): string {
  if (!r) return "ainda sem leitura";
  const parts = [r.online ? "No ar" : "Fora do ar"];
  if (r.latencyMs !== null) parts.push(ms(r.latencyMs));
  if (r.pingsReceived > 0 && r.lossPct > 0) parts.push(`${pct(r.lossPct)} de perda`);
  if (r.cpuPct !== null) parts.push(`CPU ${pct(r.cpuPct)}`);
  if (r.memPct !== null) parts.push(`memória ${pct(r.memPct)}`);
  if (r.tempC !== null) parts.push(celsius(r.tempC));
  return parts.join(" · ");
}

export function buildTestEmail(i: TestEmailInput): BuiltEmail {
  const s = i.settings;
  const detailed = i.equipment.slice(0, MAX_DETAILED_READINGS);
  const others = i.equipment.slice(MAX_DETAILED_READINGS, MAX_DETAILED_READINGS + MAX_COMPACT_READINGS);
  const uncounted = i.equipment.length - detailed.length - others.length;
  const watched = i.equipment.filter((e) => s.targets.includes(e.target.host));
  const snmp = i.equipment.filter((e) => e.snmpConfigured);
  const online = i.equipment.filter((e) => e.reading?.online).length;
  const measured = i.equipment.filter((e) => e.reading).length;
  // Listas de nomes limitadas: com dezenas de equipamentos a linha viraria um parágrafo.
  const list = (items: typeof i.equipment, max = 10) => {
    const names = items.slice(0, max).map((e) => targetName(e.target)).join(", ");
    return items.length > max ? `${names} e mais ${items.length - max}` : names;
  };
  const notes: string[] = [];
  if (!s.enabled) notes.push("Atenção: os alertas ainda estão desativados. No submenu Alertas → Configurar e-mails, marque “Ativar alertas” e salve para começar a vigiar os equipamentos.");
  const content: EmailContent = {
    tone: "info",
    label: "TESTE",
    title: "Os alertas por e-mail estão funcionando",
    subtitle: `${online} de ${measured} equipamentos no ar agora`,
    summary: `Se este e-mail chegou, a chave do Resend, o remetente e o destinatário estão corretos. O perfil escolhido determina quais avisos serão enviados.`,
    sections: [
      {
        title: "Configuração",
        rows: [
          ["Enviar alertas para", s.to || "ninguém (informe o e-mail)"],
          ["Remetente", s.from],
          ["Alertas", s.enabled ? "ativados" : "desativados"],
          ["Perfil de envio", s.mode === "all" ? "todas as métricas ao exceder limites" : "somente queda e latência crítica"],
          ["Fora do ar e desempenho (ping)", list(watched) || "nenhum equipamento na lista"],
          ...(snmp.length ? [["CPU, memória e temperatura (SNMP)", list(snmp)] as [string, string]] : []),
          ...(snmp.length ? [["CPU, memória e temperatura (SNMP)", list(snmp)] as [string, string]] : []),
          ["Situação agora", !s.enabled
            ? "verificação desligada (os problemas só são acompanhados com os alertas ativados)"
            : i.activeProblems
              ? `${i.activeProblems} problema${i.activeProblems > 1 ? "s" : ""} confirmado${i.activeProblems > 1 ? "s" : ""}`
              : "nenhum problema confirmado"],
          ["Enviado em", formatDateTime(i.at)],
        ],
      },
      limitsSection(s, i.intervalMs, snmp.length > 0),
      ...detailed.map((e) => readingSection(`Leituras atuais: ${targetName(e.target)}`, e.reading, s.thresholds, e.snmpConfigured)),
      ...(others.length
        ? [
            {
              title: `Outros ${others.length + uncounted} equipamentos (resumo)`,
              rows: [
                ...others.map((e): [string, string] => [targetName(e.target), compactReading(e.reading)]),
                ...(uncounted > 0 ? [[`Mais ${uncounted} equipamentos`, "não listados aqui; as leituras deles aparecem nos alertas"] as [string, string]] : []),
              ],
            },
          ]
        : []),
      {
        title: "O que você vai receber",
        items: [
          ...(s.mode === "all"
            ? [`🔴 Fora do ar e 🟠 latência/perda acima dos limites${snmp.length ? "; CPU, memória e temperatura acima dos limites para equipamentos com SNMP" : ""}.`]
            : [`🔴 Fora do ar ou latência média acima de ${s.thresholds.criticalLatencyMs} ms, detectados na primeira leitura fora do limite.`]),
          "🟢 Aviso de recuperação quando um problema passa, com duração e leituras atuais.",
        ],
      },
    ],
    notes,
  };
  return { subject: `✅ Teste dos alertas do NetInventory: ${online} de ${measured} equipamentos no ar`, ...renderEmail(content) };
}
