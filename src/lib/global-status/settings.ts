import { prisma } from "@/lib/prisma";
import type { ServiceStatus } from "./types";

/**
 * Configuração do painel "Status global" (fase 4), feita na tela de configuração da página /status. Fica
 * num JSON só em AppSetting; quais serviços são acompanhados fica em StatusService.enabled.
 */

export interface GlobalStatusAlertSettings {
  /** Desligado por padrão: o e-mail usa a chave do Resend e o destinatário de Alertas → Configurar e-mails. */
  enabled: boolean;
  /** "DOWN" = só quando um serviço sai do ar; "DEGRADED" = também quando fica degradado. */
  level: Extract<ServiceStatus, "DOWN" | "DEGRADED">;
}

export interface GlobalStatusSettings {
  alerts: GlobalStatusAlertSettings;
  /** ASN da operadora para o IODA; null = descobrir pelo IP público do servidor. */
  ispAsn: number | null;
}

export const SETTINGS_KEY = "globalStatus.settings";
export const DEFAULT_GLOBAL_STATUS_SETTINGS: GlobalStatusSettings = { alerts: { enabled: false, level: "DOWN" }, ispAsn: null };

/** Valida o que veio da tela ou do banco; o que não fizer sentido volta ao padrão. */
export function normalizeGlobalStatusSettings(input: unknown): GlobalStatusSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<{ alerts: Partial<GlobalStatusAlertSettings>; ispAsn: unknown }>;
  const asn = Number(raw.ispAsn);
  return {
    alerts: {
      enabled: raw.alerts?.enabled === true,
      level: raw.alerts?.level === "DEGRADED" ? "DEGRADED" : "DOWN",
    },
    // ASN de 32 bits; 0 e os reservados para documentação não são operadoras.
    ispAsn: raw.ispAsn !== null && raw.ispAsn !== undefined && raw.ispAsn !== "" && Number.isInteger(asn) && asn > 0 && asn < 4_200_000_000 ? asn : null,
  };
}

export async function getGlobalStatusSettings(): Promise<GlobalStatusSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  if (!row) return DEFAULT_GLOBAL_STATUS_SETTINGS;
  try {
    return normalizeGlobalStatusSettings(JSON.parse(row.value));
  } catch {
    return DEFAULT_GLOBAL_STATUS_SETTINGS;
  }
}

export async function saveGlobalStatusSettings(settings: GlobalStatusSettings): Promise<GlobalStatusSettings> {
  const value = JSON.stringify(normalizeGlobalStatusSettings(settings));
  await prisma.appSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value }, update: { value } });
  return JSON.parse(value) as GlobalStatusSettings;
}
