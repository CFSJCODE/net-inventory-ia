import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/ai/settings";
import { DEFAULT_FROM, DEFAULT_SETTINGS, type EmailAlertSettings } from "./email-defaults";

export type { AlertThresholds, EmailAlertSettings } from "./email-defaults";
export { DEFAULT_FROM, DEFAULT_SETTINGS } from "./email-defaults";

/**
 * Configuração dos alertas por e-mail (Resend), feita na tela de Configurações. A chave da API fica
 * criptografada no banco, como a da IA; o resto vai num JSON só. Tipos e padrões em email-defaults.ts
 * (sem imports de servidor, para a tela de Configurações poder usá-los).
 */

export interface EmailAlertConfig extends EmailAlertSettings {
  apiKey: string | null;
}

const KEY_SETTINGS = "alerts.email";
const KEY_API_KEY = "alerts.resendApiKey";

let cache: EmailAlertConfig | null = null;

export async function getEmailAlertConfig(): Promise<EmailAlertConfig> {
  if (cache) return cache;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: [KEY_SETTINGS, KEY_API_KEY] } } });
  const raw = rows.find((r) => r.key === KEY_SETTINGS)?.value;
  const enc = rows.find((r) => r.key === KEY_API_KEY)?.value;
  let stored: Partial<EmailAlertSettings> = {};
  try {
    stored = raw ? (JSON.parse(raw) as Partial<EmailAlertSettings>) : {};
  } catch {
    // JSON corrompido: volta ao padrão.
  }
  cache = {
    ...DEFAULT_SETTINGS,
    ...stored,
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...stored.thresholds },
    apiKey: enc ? decrypt(enc) : null,
  };
  return cache;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** "e-mail" ou "Nome <e-mail>". */
const FROM_RE = /^([^<>]+<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/;

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** Valida e normaliza o que veio da tela. Lança erro com mensagem para o usuário. */
export function normalizeSettings(input: EmailAlertSettings): EmailAlertSettings {
  const from = input.from.trim() || DEFAULT_FROM;
  if (!FROM_RE.test(from)) throw new Error('Remetente inválido. Use "email@dominio.com" ou "Nome <email@dominio.com>".');
  const to = input.to
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (input.enabled && !to.length) throw new Error("Informe o e-mail que recebe os alertas.");
  const invalid = to.find((e) => !EMAIL_RE.test(e));
  if (invalid) throw new Error(`E-mail inválido: ${invalid}`);
  const targets = Array.from(new Set(input.targets.map((t) => t.trim()).filter(Boolean)));
  const invalidTarget = targets.find((t) => !/^[a-zA-Z0-9.:-]+$/.test(t));
  if (invalidTarget) throw new Error(`Endereço inválido na lista de equipamentos: ${invalidTarget}`);
  const d = DEFAULT_SETTINGS.thresholds;
  return {
    enabled: !!input.enabled,
    from,
    to: to.join(", "),
    targets: targets.slice(0, 30),
    thresholds: {
      cpuPct: clamp(input.thresholds.cpuPct, 1, 100, d.cpuPct),
      memPct: clamp(input.thresholds.memPct, 1, 100, d.memPct),
      tempC: clamp(input.thresholds.tempC, 20, 150, d.tempC),
      latencyMs: clamp(input.thresholds.latencyMs, 1, 10_000, d.latencyMs),
      lossPct: clamp(input.thresholds.lossPct, 1, 100, d.lossPct),
    },
    cooldownMinutes: clamp(input.cooldownMinutes, 0, 24 * 60, DEFAULT_SETTINGS.cooldownMinutes),
  };
}

/** Grava a configuração e, se informada, a chave nova (vazia = mantém a atual). */
export async function saveEmailAlertConfig(settings: EmailAlertSettings, apiKey?: string): Promise<void> {
  const value = JSON.stringify(normalizeSettings(settings));
  const writes = [prisma.appSetting.upsert({ where: { key: KEY_SETTINGS }, update: { value }, create: { key: KEY_SETTINGS, value } })];
  if (apiKey?.trim()) {
    const enc = encrypt(apiKey.trim());
    writes.push(prisma.appSetting.upsert({ where: { key: KEY_API_KEY }, update: { value: enc }, create: { key: KEY_API_KEY, value: enc } }));
  }
  await prisma.$transaction(writes);
  cache = null;
}

export async function removeResendKey(): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: KEY_API_KEY } });
  cache = null;
}

// Último envio (ou erro), para a tela mostrar se os e-mails estão saindo.
const KEY_LAST = "alerts.lastDelivery";

export interface LastDelivery {
  at: string;
  ok: boolean;
  subject: string;
  error?: string;
}

export async function recordDelivery(d: LastDelivery): Promise<void> {
  const value = JSON.stringify(d);
  await prisma.appSetting.upsert({ where: { key: KEY_LAST }, update: { value }, create: { key: KEY_LAST, value } });
}

export async function getLastDelivery(): Promise<LastDelivery | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY_LAST } });
  try {
    return row ? (JSON.parse(row.value) as LastDelivery) : null;
  } catch {
    return null;
  }
}
