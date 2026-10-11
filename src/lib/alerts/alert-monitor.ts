import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/ai/settings";
import { displayName } from "@/lib/device-name";
import { mapWithConcurrency } from "@/lib/network/concurrency";
import { readHealthMetrics, type HealthMetrics } from "@/lib/network/equipment-status";
import { getEmailAlertConfig, recordDelivery, type EmailAlertConfig } from "./email-settings";
import { renderEmail, sendResendEmail } from "./resend";
import { EMPTY_STATE, evaluate, formatDuration, lossPct, parsePingOutput, type CheckState, type PingStats, type RuleOptions } from "./rules";

/**
 * Vigia os equipamentos de rede configurados e manda e-mail (Resend) quando um fica fora do ar, com
 * desempenho degradado (latência ou perda de pacotes) ou, nos equipamentos SNMP cadastrados, com CPU,
 * memória ou temperatura acima do limite. Também avisa quando o problema passa.
 *
 * Os e-mails passam por uma fila guardada no banco: se o modem cai, a internet cai junto e o alerta não
 * sai na hora — ele é reenviado assim que a conexão voltar (junto com o aviso de recuperação).
 */

export const ALERT_CHECK_INTERVAL_MS = 60_000;
const PINGS = 4;
const OUTBOX_MAX_AGE_MS = 24 * 3600_000;
const OUTBOX_MAX = 50;

type CheckKind = "offline" | "degraded" | "cpu" | "mem" | "temp";

/** Checagens seguidas (1 por minuto) para alertar / para considerar recuperado. */
const RULES: Record<CheckKind, Omit<RuleOptions, "cooldownMs">> = {
  offline: { badToFire: 2, goodToClear: 1 },
  degraded: { badToFire: 3, goodToClear: 2 },
  cpu: { badToFire: 3, goodToClear: 2 },
  mem: { badToFire: 3, goodToClear: 2 },
  temp: { badToFire: 2, goodToClear: 2 },
};

interface QueuedEmail {
  key: string;
  kind: "alert" | "recovery";
  subject: string;
  html: string;
  text: string;
  createdAt: number;
}

interface PersistedState {
  checks: Record<string, CheckState>;
  outbox: QueuedEmail[];
}

const KEY_STATE = "alerts.state";

const g = globalThis as typeof globalThis & {
  __alertTimer?: NodeJS.Timeout;
  __alertRun?: Promise<void>;
  __alertState?: PersistedState;
};

async function loadState(): Promise<PersistedState> {
  if (g.__alertState) return g.__alertState;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY_STATE } });
  let state: PersistedState = { checks: {}, outbox: [] };
  try {
    if (row) state = { checks: {}, outbox: [], ...(JSON.parse(row.value) as Partial<PersistedState>) };
  } catch {
    // Estado corrompido: recomeça do zero.
  }
  g.__alertState = state;
  return state;
}

async function saveState(state: PersistedState): Promise<void> {
  const value = JSON.stringify(state);
  await prisma.appSetting.upsert({ where: { key: KEY_STATE }, update: { value }, create: { key: KEY_STATE, value } });
}

const execFileAsync = promisify(execFile);

async function pingStats(host: string): Promise<PingStats> {
  const args = process.platform === "win32" ? ["-n", String(PINGS), "-w", "1000", host] : ["-c", String(PINGS), "-i", "0.2", "-W", "1", host];
  try {
    const { stdout } = await execFileAsync("ping", args, { timeout: PINGS * 1500 + 2000 });
    return parsePingOutput(stdout, PINGS);
  } catch (err) {
    // Sem resposta nenhuma o ping sai com código 1, mas a saída ainda vale.
    const stdout = (err as { stdout?: string }).stdout ?? "";
    return parsePingOutput(stdout, PINGS);
  }
}

const now = () => Date.now();
const fmtTime = (ms: number) => new Date(ms).toLocaleString("pt-BR");

interface Target {
  host: string;
  name: string;
  equipment: { community: string; version: "1" | "2c" } | null;
}

/** Equipamentos vigiados: os da lista + os cadastrados em Equipamentos (para CPU/memória/temperatura). */
async function resolveTargets(config: EmailAlertConfig): Promise<Target[]> {
  const equipment = await prisma.equipment.findMany();
  const hosts = Array.from(new Set([...config.targets, ...equipment.map((e) => e.ip)]));
  const devices = await prisma.device.findMany({ where: { ip: { in: hosts } }, select: { ip: true, alias: true, hostname: true } });
  return hosts.map((host) => {
    const eq = equipment.find((e) => e.ip === host);
    const dev = devices.find((d) => d.ip === host);
    const name = (dev && displayName(dev, null)) || eq?.name || null;
    const community = eq ? decrypt(eq.community) : null;
    return {
      host,
      name: name ? `${name} (${host})` : host,
      equipment: eq && community ? { community, version: eq.snmpVersion === "1" ? "1" : "2c" } : null,
    };
  });
}

interface Observation {
  kind: CheckKind;
  bad: boolean;
  value: number | null;
  /** Texto do problema para o e-mail de alerta. */
  detail: string;
}

function observe(target: Target, config: EmailAlertConfig, ping: PingStats, metrics: HealthMetrics | null, watched: boolean): Observation[] {
  const t = config.thresholds;
  const obs: Observation[] = [];
  // Responder ao SNMP também prova que está no ar (equipamento que bloqueia ping).
  const online = ping.received > 0 || metrics !== null;
  if (watched) {
    obs.push({ kind: "offline", bad: !online, value: null, detail: `Sem resposta a ${PINGS} pings seguidos` });
    if (ping.received > 0) {
      const loss = lossPct(ping);
      const avg = ping.avgMs ?? 0;
      obs.push({
        kind: "degraded",
        bad: avg > t.latencyMs || loss >= t.lossPct,
        value: avg,
        detail: `Latência média ${avg} ms (limite ${t.latencyMs} ms), perda de pacotes ${loss}% (limite ${t.lossPct}%)`,
      });
    }
  }
  if (metrics) {
    if (metrics.cpuPct !== null) obs.push({ kind: "cpu", bad: metrics.cpuPct >= t.cpuPct, value: metrics.cpuPct, detail: `CPU em ${metrics.cpuPct}% (limite ${t.cpuPct}%)` });
    if (metrics.memPct !== null) obs.push({ kind: "mem", bad: metrics.memPct >= t.memPct, value: metrics.memPct, detail: `Memória em ${metrics.memPct}% (limite ${t.memPct}%)` });
    if (metrics.tempC !== null) obs.push({ kind: "temp", bad: metrics.tempC >= t.tempC, value: metrics.tempC, detail: `Temperatura em ${metrics.tempC} °C (limite ${t.tempC} °C)` });
  }
  return obs;
}

const ALERT_TITLE: Record<CheckKind, string> = {
  offline: "FORA DO AR",
  degraded: "DESEMPENHO DEGRADADO",
  cpu: "CPU ALTA",
  mem: "MEMÓRIA ALTA",
  temp: "TEMPERATURA ALTA",
};

const RECOVERY_TITLE: Record<CheckKind, string> = {
  offline: "VOLTOU AO AR",
  degraded: "DESEMPENHO NORMALIZADO",
  cpu: "CPU NORMALIZADA",
  mem: "MEMÓRIA NORMALIZADA",
  temp: "TEMPERATURA NORMALIZADA",
};

function alertEmail(key: string, target: Target, o: Observation, at: number): QueuedEmail {
  const title = `${ALERT_TITLE[o.kind]}: ${target.name}`;
  const { html, text } = renderEmail({
    title,
    color: o.kind === "offline" || o.kind === "temp" ? "#c62828" : "#e65100",
    lines: [
      ["Equipamento", target.name],
      ["Problema", o.detail],
      ["Detectado em", fmtTime(at)],
    ],
    footer: "Você receberá outro e-mail quando o problema passar. Enviado pelo NetInventory.",
  });
  return { key, kind: "alert", subject: `🔴 ${title}`, html, text, createdAt: at };
}

function recoveryEmail(key: string, target: Target, o: Observation, since: number | null, at: number, alertUndelivered: boolean): QueuedEmail {
  const title = `${RECOVERY_TITLE[o.kind]}: ${target.name}`;
  const lines: [string, string][] = [["Equipamento", target.name]];
  if (since) lines.push(["Problema desde", fmtTime(since)], ["Normalizado em", fmtTime(at)], ["Duração", formatDuration(at - since)]);
  if (o.kind !== "offline") lines.push(["Agora", o.detail]);
  const footer = alertUndelivered
    ? "O alerta não pôde ser enviado na hora (provavelmente a internet caiu junto). Enviado pelo NetInventory."
    : "Enviado pelo NetInventory.";
  const { html, text } = renderEmail({ title, color: "#2e7d32", lines, footer });
  return { key, kind: "recovery", subject: `🟢 ${title}`, html, text, createdAt: at };
}

function enqueue(state: PersistedState, email: QueuedEmail): void {
  // Recuperação de um alerta que nem saiu ainda: vira um e-mail só.
  if (email.kind === "recovery") state.outbox = state.outbox.filter((e) => !(e.key === email.key && e.kind === "alert"));
  state.outbox.push(email);
  if (state.outbox.length > OUTBOX_MAX) state.outbox = state.outbox.slice(-OUTBOX_MAX);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Envia um e-mail e registra o resultado (o último envio aparece em Configurações). */
export async function deliver(config: EmailAlertConfig, subject: string, html: string, text: string): Promise<void> {
  if (!config.apiKey) throw new Error("Cadastre a chave da API do Resend.");
  const to = config.to.split(/[,;\s]+/).filter(Boolean);
  if (!to.length) throw new Error("Informe o e-mail que recebe os alertas.");
  try {
    await sendResendEmail(config.apiKey, { from: config.from, to, subject, html, text });
    await recordDelivery({ at: new Date().toISOString(), ok: true, subject });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recordDelivery({ at: new Date().toISOString(), ok: false, subject, error });
    throw err;
  }
}

async function flushOutbox(state: PersistedState, config: EmailAlertConfig): Promise<void> {
  state.outbox = state.outbox.filter((e) => now() - e.createdAt < OUTBOX_MAX_AGE_MS);
  while (state.outbox.length) {
    const email = state.outbox[0];
    try {
      await deliver(config, email.subject, email.html, email.text);
    } catch (err) {
      console.error(`[alertas] e-mail não enviado, nova tentativa no próximo minuto: ${err instanceof Error ? err.message : err}`);
      return;
    }
    state.outbox.shift();
    // O Resend aceita poucos envios por segundo.
    if (state.outbox.length) await sleep(600);
  }
}

async function runChecks(): Promise<void> {
  const config = await getEmailAlertConfig();
  if (!config.enabled || !config.apiKey || !config.to) return;
  const state = await loadState();
  const targets = await resolveTargets(config);
  const watched = new Set(config.targets);
  const cooldownMs = config.cooldownMinutes * 60_000;

  const results = await mapWithConcurrency(targets, 6, async (target) => {
    const ping = await pingStats(target.host);
    // SNMP mesmo sem ping: há equipamento que bloqueia ICMP e responde SNMP.
    const metrics = target.equipment
      ? await readHealthMetrics(target.host, target.equipment.community, target.equipment.version).catch(() => null)
      : null;
    return { target, ping, metrics };
  });

  const at = now();
  const seen = new Set<string>();
  for (const { target, ping, metrics } of results) {
    for (const o of observe(target, config, ping, metrics, watched.has(target.host))) {
      const key = `${target.host}|${o.kind}`;
      seen.add(key);
      const prev = state.checks[key] ?? EMPTY_STATE;
      const { state: next, event } = evaluate(prev, o.bad, at, { ...RULES[o.kind], cooldownMs });
      next.value = o.value;
      state.checks[key] = next;
      if (event === "alert") {
        enqueue(state, alertEmail(key, target, o, at));
        console.log(`[alertas] ${ALERT_TITLE[o.kind]}: ${target.name} — ${o.detail}`);
      } else if (event === "recovery") {
        const undelivered = state.outbox.some((e) => e.key === key && e.kind === "alert");
        enqueue(state, recoveryEmail(key, target, o, prev.since, at, undelivered));
        console.log(`[alertas] ${RECOVERY_TITLE[o.kind]}: ${target.name}`);
      }
    }
  }

  // Checagem que deixou de existir (equipamento tirado da lista, SNMP descadastrado): esquece o estado,
  // senão ficaria como problema ativo para sempre.
  for (const key of Object.keys(state.checks)) if (!seen.has(key)) delete state.checks[key];

  await flushOutbox(state, config);
  await saveState(state);
}

/** Uma rodada de checagem; nunca duas ao mesmo tempo. */
export function checkAlertsNow(): Promise<void> {
  if (g.__alertRun) return g.__alertRun;
  g.__alertRun = runChecks()
    .catch((err) => console.error("[alertas] falha na checagem:", err))
    .finally(() => {
      g.__alertRun = undefined;
    });
  return g.__alertRun;
}

/** Inicia a checagem periódica (uma vez por processo, via instrumentation). */
export function startAlertMonitor(): void {
  if (g.__alertTimer) return;
  g.__alertTimer = setInterval(() => void checkAlertsNow(), ALERT_CHECK_INTERVAL_MS);
  console.log(`[alertas] verificando equipamentos a cada ${ALERT_CHECK_INTERVAL_MS / 1000}s (e-mail via Resend)`);
}

/** Problemas ativos agora, para a tela de Configurações. */
export async function activeProblems(): Promise<{ key: string; since: number | null }[]> {
  const state = await loadState();
  return Object.entries(state.checks)
    .filter(([, s]) => s.active)
    .map(([key, s]) => ({ key, since: s.since }));
}

export async function pendingEmails(): Promise<number> {
  return (await loadState()).outbox.length;
}
