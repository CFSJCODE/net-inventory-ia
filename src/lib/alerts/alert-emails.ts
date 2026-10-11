/**
 * Conteúdo dos e-mails de alerta, de recuperação e de teste: o que cada um diz e quais leituras e
 * limites mostra. Puro (sem rede nem banco): recebe a última leitura do equipamento e os limites e
 * devolve assunto, HTML e texto. A medição fica em alert-monitor.ts e o visual em email-template.ts.
 */

import type { AlertThresholds, EmailAlertSettings } from "./email-defaults";
import { renderEmail, type EmailContent, type EmailReading, type EmailSection, type EmailTone } from "./email-template";
import { formatDuration } from "./rules";

export type CheckKind = "offline" | "degraded" | "cpu" | "mem" | "temp";

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
  /** Última vez que respondeu e a latência dessa resposta (ficam quando o equipamento cai). */
  lastSeen: number | null;
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
    }
  }
  if (reading.cpuPct !== null) obs.push({ kind: "cpu", bad: reading.cpuPct >= t.cpuPct, value: reading.cpuPct, detail: `CPU em ${reading.cpuPct}% (limite ${t.cpuPct}%)` });
  if (reading.memPct !== null) obs.push({ kind: "mem", bad: reading.memPct >= t.memPct, value: reading.memPct, detail: `Memória em ${reading.memPct}% (limite ${t.memPct}%)` });
  if (reading.tempC !== null) obs.push({ kind: "temp", bad: reading.tempC >= t.tempC, value: reading.tempC, detail: `Temperatura em ${reading.tempC} °C (limite ${t.tempC} °C)` });
  return obs;
}

const KINDS: Record<CheckKind, { alert: string; recovery: string; tone: EmailTone; emoji: string }> = {
  offline: { alert: "Fora do ar", recovery: "Voltou ao ar", tone: "critical", emoji: "🔴" },
  degraded: { alert: "Desempenho degradado", recovery: "Desempenho normalizado", tone: "warning", emoji: "🟠" },
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

/** Linhas da leitura: status, tempo de atividade, última resposta, pings. */
function readingRows(r: HostReading): [string, string][] {
  const rows: [string, string][] = [];
  const ago = (since: number) => `há ${formatDuration(r.at - since)}, desde ${formatDateTime(since)}`;
  if (r.online) {
    rows.push(["Status", "No ar"]);
    if (r.uptimeMin !== null) rows.push(["Tempo de atividade", `${formatDuration(r.uptimeMin * 60_000)} (sysUpTime via SNMP)`]);
    else if (r.onlineSince !== null) rows.push(["Tempo de atividade", `respondendo ${ago(r.onlineSince)}`]);
  } else {
    rows.push(["Status", r.offlineSince !== null ? `Fora do ar ${ago(r.offlineSince)}` : "Fora do ar"]);
    if (r.lastSeen !== null) rows.push(["Última resposta", `${formatDateTime(r.lastSeen)}${r.lastLatencyMs !== null ? `, latência ${ms(r.lastLatencyMs)}` : ""}`]);
    else rows.push(["Última resposta", "nenhuma desde que passou a ser vigiado"]);
  }
  rows.push(["Ping", `${r.pingsReceived} de ${r.pingsSent} respondidos${r.latencyMs !== null ? `, média ${ms(r.latencyMs)}` : ""}`]);
  if (r.cpuPct === null && r.memPct === null && r.tempC === null) rows.push(["CPU, memória e temperatura", "não lidos (sem SNMP cadastrado em Equipamentos, ou sem resposta SNMP)"]);
  rows.push(["Leitura em", formatDateTime(r.at)]);
  return rows;
}

export function readingSection(title: string, r: HostReading | null, t: AlertThresholds): EmailSection {
  if (!r) return { title, rows: [["Status", "ainda sem leitura (a primeira verificação acontece em até 1 min)"]] };
  return { title, readings: readingGauges(r, t), rows: readingRows(r) };
}

export function limitsSection(s: Pick<EmailAlertSettings, "thresholds" | "cooldownMinutes">, intervalMs: number): EmailSection {
  const t = s.thresholds;
  return {
    title: "Limites configurados",
    rows: [
      ["CPU", `alerta a partir de ${pct(t.cpuPct)}`],
      ["Memória", `alerta a partir de ${pct(t.memPct)}`],
      ["Temperatura", `alerta a partir de ${celsius(t.tempC)}`],
      ["Latência média", `alerta acima de ${ms(t.latencyMs)}`],
      ["Perda de pacotes", `alerta a partir de ${pct(t.lossPct)}`],
      ["Verificação", `a cada ${formatDuration(intervalMs)}`],
      ["Intervalo mínimo entre alertas", `${s.cooldownMinutes} min para o mesmo problema`],
    ],
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
}

export interface AlertEmailInput extends Common {
  /** Leituras seguidas com problema que confirmaram o alerta. */
  checks: number;
}

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
  const run = `nas últimas ${i.checks} verificações seguidas`;
  switch (o.kind) {
    case "offline":
      return `${name} não respondeu a nenhum dos ${r.pingsSent} pings ${run}. O equipamento pode estar desligado, sem energia, travado ou com o cabo de rede desconectado.`;
    case "degraded": {
      const parts: string[] = [];
      if (r.latencyMs !== null && r.latencyMs > t.latencyMs) parts.push(`latência média de ${ms(r.latencyMs)} (limite ${ms(t.latencyMs)})`);
      if (r.lossPct >= t.lossPct) parts.push(`perda de ${pct(r.lossPct)} dos pacotes (limite ${pct(t.lossPct)})`);
      return `A conexão com ${name} está lenta ou instável ${run}: ${parts.join(" e ") || o.detail}.`;
    }
    case "cpu":
      return `O uso de CPU de ${name} está em ${pct(r.cpuPct ?? 0)}, acima do limite de ${pct(t.cpuPct)}, ${run}.`;
    case "mem":
      return `O uso de memória de ${name} está em ${pct(r.memPct ?? 0)}, acima do limite de ${pct(t.memPct)}, ${run}.`;
    case "temp":
      return `A temperatura de ${name} chegou a ${celsius(r.tempC ?? 0)}, acima do limite de ${celsius(t.tempC)}, ${run}. Confira a ventilação e a temperatura do ambiente.`;
  }
}

export function buildAlertEmail(i: AlertEmailInput): BuiltEmail {
  const k = KINDS[i.observation.kind];
  const name = targetName(i.target);
  const detail = subjectDetail(i.observation, i.reading, i.settings.thresholds);
  const content: EmailContent = {
    tone: k.tone,
    label: "ALERTA",
    title: k.alert,
    subtitle: name,
    summary: alertSummary(i),
    sections: [
      readingSection("Leituras atuais", i.reading, i.settings.thresholds),
      {
        title: "Detalhes do alerta",
        rows: [
          ["Equipamento", i.target.label ?? i.target.host],
          ["Endereço IP", i.target.host],
          ["Problema", `${k.alert}: ${i.observation.detail}`],
          ["Detectado em", formatDateTime(i.at)],
          ["Confirmação", `${i.checks} leituras seguidas com problema, uma a cada ${formatDuration(i.intervalMs)}`],
        ],
      },
      limitsSection(i.settings, i.intervalMs),
    ],
    notes: [
      "Você receberá outro e-mail quando o problema passar.",
      `Para não lotar sua caixa de entrada, um novo alerta deste mesmo problema só é enviado depois de ${i.settings.cooldownMinutes} min.`,
    ],
  };
  return { subject: `${k.emoji} ${k.alert}${detail ? ` (${detail})` : ""}: ${name}`, ...renderEmail(content) };
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
    case "cpu":
      return `O uso de CPU de ${name} voltou ao normal${after ? `${after} acima do limite` : ""}: ${pct(r.cpuPct ?? 0)} (limite ${pct(t.cpuPct)}).`;
    case "mem":
      return `O uso de memória de ${name} voltou ao normal${after ? `${after} acima do limite` : ""}: ${pct(r.memPct ?? 0)} (limite ${pct(t.memPct)}).`;
    case "temp":
      return `A temperatura de ${name} voltou ao normal${after ? `${after} acima do limite` : ""}: ${celsius(r.tempC ?? 0)} (limite ${celsius(t.tempC)}).`;
  }
}

export function buildRecoveryEmail(i: RecoveryEmailInput): BuiltEmail {
  const k = KINDS[i.observation.kind];
  const name = targetName(i.target);
  const duration = i.since !== null ? formatDuration(i.at - i.since) : null;
  const rows: [string, string][] = [
    ["Equipamento", i.target.label ?? i.target.host],
    ["Endereço IP", i.target.host],
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
    sections: [readingSection("Leituras atuais", i.reading, i.settings.thresholds), { title: "Detalhes", rows }, limitsSection(i.settings, i.intervalMs)],
    notes: i.alertUndelivered
      ? ["O alerta deste problema não pôde ser enviado na hora, provavelmente porque a internet caiu junto com o equipamento. Ele foi substituído por este aviso."]
      : [],
  };
  return { subject: `🟢 ${k.recovery}: ${name}${duration ? ` (após ${duration})` : ""}`, ...renderEmail(content) };
}

export interface TestEmailInput {
  settings: EmailAlertSettings;
  /** Todos os equipamentos medidos (lista vigiada + SNMP cadastrados), com a leitura de agora. */
  equipment: { target: WatchedTarget; reading: HostReading | null; snmp: boolean }[];
  /** Problemas confirmados neste momento. */
  activeProblems: number;
  intervalMs: number;
  at: number;
}

export function buildTestEmail(i: TestEmailInput): BuiltEmail {
  const s = i.settings;
  const watched = i.equipment.filter((e) => s.targets.includes(e.target.host));
  const snmp = i.equipment.filter((e) => e.snmp);
  const online = i.equipment.filter((e) => e.reading?.online).length;
  const measured = i.equipment.filter((e) => e.reading).length;
  const list = (items: typeof i.equipment) => items.map((e) => targetName(e.target)).join(", ");
  const notes: string[] = [];
  if (!s.enabled) notes.push("Atenção: os alertas ainda estão desativados. Em Configurações → Alertas por e-mail, marque “Ativar alertas” e salve para começar a vigiar os equipamentos.");
  const content: EmailContent = {
    tone: "info",
    label: "TESTE",
    title: "Os alertas por e-mail estão funcionando",
    subtitle: `${online} de ${measured} equipamentos no ar agora`,
    summary: `Se este e-mail chegou, a chave do Resend, o remetente e o destinatário estão corretos. Os alertas abaixo serão enviados para este endereço, e cada um traz as últimas leituras do equipamento e os limites configurados.`,
    sections: [
      {
        title: "Configuração",
        rows: [
          ["Enviar alertas para", s.to || "ninguém (informe o e-mail)"],
          ["Remetente", s.from],
          ["Alertas", s.enabled ? "ativados" : "desativados"],
          ["Fora do ar e desempenho (ping)", list(watched) || "nenhum equipamento na lista"],
          ["CPU, memória e temperatura (SNMP)", list(snmp) || "nenhum equipamento cadastrado em Equipamentos"],
          ["Situação agora", i.activeProblems ? `${i.activeProblems} problema${i.activeProblems > 1 ? "s" : ""} confirmado${i.activeProblems > 1 ? "s" : ""}` : "nenhum problema confirmado"],
          ["Enviado em", formatDateTime(i.at)],
        ],
      },
      limitsSection(s, i.intervalMs),
      ...i.equipment.map((e) => readingSection(`Leituras atuais: ${targetName(e.target)}`, e.reading, s.thresholds)),
      {
        title: "O que você vai receber",
        items: [
          "🔴 Fora do ar: o equipamento parou de responder ao ping (e ao SNMP, quando cadastrado).",
          "🟠 Desempenho degradado: latência média ou perda de pacotes acima do limite.",
          "🟠 CPU alta e 🟠 Memória alta: nos equipamentos SNMP cadastrados.",
          "🔴 Temperatura alta: nos equipamentos SNMP cadastrados.",
          "🟢 Recuperação: quando o problema passa, com a duração e as leituras de agora.",
        ],
      },
    ],
    notes,
  };
  return { subject: `✅ Teste dos alertas do NetInventory: ${online} de ${measured} equipamentos no ar`, ...renderEmail(content) };
}
