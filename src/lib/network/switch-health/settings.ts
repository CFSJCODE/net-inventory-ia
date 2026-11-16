import { prisma } from "@/lib/prisma";
import type { SwitchHealthThresholds } from "./counters";

/**
 * Configuração do coletor da saúde das switches (Switch Health), num JSON só em AppSetting. Os limites
 * valem para a cor das portas na tela e para o alerta por e-mail (Alertas → Configurar e-mails).
 */

export interface SwitchHealthSettings extends SwitchHealthThresholds {
  /** Liga o coletor periódico. */
  enabled: boolean;
  /** Intervalo entre leituras, em segundos (30 a 900). */
  intervalSec: number;
}

export const SWITCH_HEALTH_KEY = "switchHealth.settings";
export const DEFAULT_SWITCH_HEALTH_SETTINGS: SwitchHealthSettings = { enabled: true, intervalSec: 60, errorsPerMin: 10, discardsPerMin: 100 };

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** Valida o que veio da tela ou do banco; o que não fizer sentido volta ao padrão. */
export function normalizeSwitchHealthSettings(input: unknown): SwitchHealthSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof SwitchHealthSettings, unknown>>;
  const d = DEFAULT_SWITCH_HEALTH_SETTINGS;
  return {
    enabled: raw.enabled === undefined ? d.enabled : raw.enabled === true,
    intervalSec: clamp(raw.intervalSec, 30, 900, d.intervalSec),
    errorsPerMin: clamp(raw.errorsPerMin, 1, 1_000_000, d.errorsPerMin),
    discardsPerMin: clamp(raw.discardsPerMin, 1, 1_000_000, d.discardsPerMin),
  };
}

const g = globalThis as typeof globalThis & { __switchHealthSettings?: SwitchHealthSettings };

export async function getSwitchHealthSettings(): Promise<SwitchHealthSettings> {
  if (g.__switchHealthSettings) return g.__switchHealthSettings;
  const row = await prisma.appSetting.findUnique({ where: { key: SWITCH_HEALTH_KEY } });
  let stored: unknown = {};
  try {
    stored = row ? JSON.parse(row.value) : {};
  } catch {
    // JSON corrompido: volta ao padrão.
  }
  g.__switchHealthSettings = normalizeSwitchHealthSettings(stored);
  return g.__switchHealthSettings;
}

export async function saveSwitchHealthSettings(input: unknown): Promise<SwitchHealthSettings> {
  const settings = normalizeSwitchHealthSettings(input);
  const value = JSON.stringify(settings);
  await prisma.appSetting.upsert({ where: { key: SWITCH_HEALTH_KEY }, update: { value }, create: { key: SWITCH_HEALTH_KEY, value } });
  g.__switchHealthSettings = settings;
  return settings;
}
