import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/ai/settings";
import { displayName } from "@/lib/device-name";
import { mapWithConcurrency } from "@/lib/network/concurrency";
import { readHealthMetrics } from "@/lib/network/equipment-status";
import { getEmailAlertConfig, recordDelivery, type EmailAlertConfig } from "./email-settings";
import { sendResendEmail } from "./resend";
import { EMPTY_STATE, evaluate, lossPct, parsePingOutput, type CheckState, type PingStats, type RuleOptions } from "./rules";
import {
  alertTitle,
  buildAlertEmail,
  buildRecoveryEmail,
  observe,
  recoveryTitle,
  targetName,
  type CheckKind,
  type HostReading,
  type WatchedTarget,
} from "./alert-emails";

/**
 * Vigia os equipamentos de rede configurados e manda e-mail (Resend) quando um fica fora do ar, com
 * desempenho degradado (latência ou perda de pacotes) ou, nos equipamentos SNMP cadastrados, com CPU,
 * memória ou temperatura acima do limite. Também avisa quando o problema passa.
 *
 * A cada rodada guarda a última leitura de cada equipamento (status, latência, CPU, memória,
 * temperatura, uptime), que vai nos e-mails. Os e-mails passam por uma fila guardada no banco: se o
 * modem cai, a internet cai junto e o alerta não sai na hora — ele é reenviado assim que a conexão
 * voltar (junto com o aviso de recuperação).
 */

export const ALERT_CHECK_INTERVAL_MS = 60_000;
const PINGS = 4;
const OUTBOX_MAX_AGE_MS = 24 * 3600_000;
const OUTBOX_MAX = 50;

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
  /** Última leitura de cada equipamento (por IP). */
  readings: Record<string, HostReading>;
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
  let state: PersistedState = { checks: {}, outbox: [], readings: {} };
  try {
    if (row) state = { checks: {}, outbox: [], readings: {}, ...(JSON.parse(row.value) as Partial<PersistedState>) };
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

export interface Target extends WatchedTarget {
  equipment: { community: string; version: "1" | "2c" } | null;
}

/** Equipamentos vigiados: os da lista + os cadastrados em Equipamentos (para CPU/memória/temperatura). */
export async function resolveTargets(config: EmailAlertConfig): Promise<Target[]> {
  const equipment = await prisma.equipment.findMany();
  const hosts = Array.from(new Set([...config.targets, ...equipment.map((e) => e.ip)]));
  const devices = await prisma.device.findMany({ where: { ip: { in: hosts } }, select: { ip: true, alias: true, hostname: true } });
  return hosts.map((host) => {
    const eq = equipment.find((e) => e.ip === host);
    const dev = devices.find((d) => d.ip === host);
    const community = eq ? decrypt(eq.community) : null;
    return {
      host,
      label: (dev && displayName(dev, null)) || eq?.name || null,
      equipment: eq && community ? { community, version: eq.snmpVersion === "1" ? "1" : "2c" } : null,
    };
  });
}

/** Ping + SNMP de um equipamento; o que não muda (desde quando responde, última resposta) vem da leitura anterior. */
async function measure(target: Target, prev: HostReading | undefined): Promise<HostReading> {
  const ping = await pingStats(target.host);
  // SNMP mesmo sem ping: há equipamento que bloqueia ICMP e responde SNMP.
  const metrics = target.equipment
    ? await readHealthMetrics(target.host, target.equipment.community, target.equipment.version).catch(() => null)
    : null;
  // Hora da medição deste equipamento (com muitos equipamentos, os últimos medem bem depois do início da rodada).
  const at = now();
  const online = ping.received > 0 || metrics !== null;
  const latencyMs = ping.received > 0 ? ping.avgMs : null;
  return {
    at,
    online,
    pingsSent: ping.sent,
    pingsReceived: ping.received,
    latencyMs,
    lossPct: lossPct(ping),
    cpuPct: metrics?.cpuPct ?? null,
    memPct: metrics?.memPct ?? null,
    tempC: metrics?.tempC ?? null,
    uptimeMin: metrics?.uptimeMin ?? null,
    onlineSince: online ? (prev?.online ? (prev.onlineSince ?? at) : at) : null,
    offlineSince: online ? null : prev && !prev.online ? (prev.offlineSince ?? at) : at,
    lastSeen: online ? at : (prev?.lastSeen ?? null),
    // Hora e latência do último ping respondido andam juntas (o SNMP pode responder sem o ping).
    lastPingAt: latencyMs !== null ? at : (prev?.lastPingAt ?? null),
    lastLatencyMs: latencyMs ?? prev?.lastLatencyMs ?? null,
  };
}

/** Mede todos os equipamentos agora e guarda as leituras (os e-mails e o teste mostram essas leituras). */
export async function collectReadings(config: EmailAlertConfig): Promise<{ target: Target; reading: HostReading }[]> {
  const state = await loadState();
  // Estado em memória criado pela versão anterior do módulo (next dev) não tem leituras.
  state.readings ??= {};
  const targets = await resolveTargets(config);
  const results = await mapWithConcurrency(targets, 6, async (target) => ({ target, reading: await measure(target, state.readings[target.host]) }));
  // Equipamento que saiu da lista some das leituras.
  state.readings = Object.fromEntries(results.map((r) => [r.target.host, r.reading]));
  await saveState(state);
  return results;
}

function enqueue(state: PersistedState, email: QueuedEmail): void {
  // Recuperação de um alerta que nem saiu ainda: vira um e-mail só.
  if (email.kind === "recovery") state.outbox = state.outbox.filter((e) => !(e.key === email.key && e.kind === "alert"));
  state.outbox.push(email);
  if (state.outbox.length > OUTBOX_MAX) state.outbox = state.outbox.slice(-OUTBOX_MAX);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Destinatários da configuração; erro com mensagem para o usuário quando falta chave ou e-mail. */
export function recipients(config: EmailAlertConfig): string[] {
  if (!config.apiKey) throw new Error("Cadastre a chave da API do Resend.");
  const to = config.to.split(/[,;\s]+/).filter(Boolean);
  if (!to.length) throw new Error("Informe o e-mail que recebe os alertas.");
  return to;
}

/** Envia um e-mail e registra o resultado (o último envio aparece em Configurações). */
export async function deliver(config: EmailAlertConfig, subject: string, html: string, text: string): Promise<void> {
  const to = recipients(config);
  try {
    await sendResendEmail(config.apiKey!, { from: config.from, to, subject, html, text });
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
  const watched = new Set(config.targets);
  const cooldownMs = config.cooldownMinutes * 60_000;
  const results = await collectReadings(config);

  const at = now();
  const seen = new Set<string>();
  for (const { target, reading } of results) {
    for (const o of observe(reading, config.thresholds, watched.has(target.host))) {
      const key = `${target.host}|${o.kind}`;
      seen.add(key);
      const prev = state.checks[key] ?? EMPTY_STATE;
      const { state: next, event } = evaluate(prev, o.bad, at, { ...RULES[o.kind], cooldownMs });
      next.value = o.value;
      state.checks[key] = next;
      const common = { target, observation: o, reading, at, intervalMs: ALERT_CHECK_INTERVAL_MS, settings: config };
      if (event === "alert") {
        // Leituras seguidas com problema de verdade: pode passar de badToFire quando o alerta esperou o intervalo mínimo.
        const email = buildAlertEmail({ ...common, checks: next.bad });
        enqueue(state, { key, kind: "alert", ...email, createdAt: at });
        console.log(`[alertas] ${alertTitle(o.kind)}: ${targetName(target)} — ${o.detail}`);
      } else if (event === "recovery") {
        const alertUndelivered = state.outbox.some((e) => e.key === key && e.kind === "alert");
        const email = buildRecoveryEmail({ ...common, since: prev.since, alertUndelivered });
        enqueue(state, { key, kind: "recovery", ...email, createdAt: at });
        console.log(`[alertas] ${recoveryTitle(o.kind)}: ${targetName(target)}`);
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
