"use server";

import { requirePermission } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { activeProblems, deliver, pendingEmails } from "@/lib/alerts/alert-monitor";
import {
  getEmailAlertConfig,
  getLastDelivery,
  removeResendKey,
  saveEmailAlertConfig,
  type EmailAlertSettings,
  type LastDelivery,
} from "@/lib/alerts/email-settings";
import { renderEmail } from "@/lib/alerts/resend";
import type { ToolResult } from "./tool-actions";

async function run<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** O que vai para o navegador: a chave fica no servidor, só se informa o final dela. */
export interface EmailAlertStatus {
  settings: EmailAlertSettings;
  hasKey: boolean;
  keyHint: string | null;
  lastDelivery: LastDelivery | null;
  /** Problemas confirmados agora ("192.168.0.3|cpu") e desde quando. */
  active: { key: string; since: number | null }[];
  /** E-mails esperando a internet voltar. */
  pending: number;
  /** Equipamentos SNMP cadastrados (CPU, memória e temperatura são lidos deles). */
  snmpEquipment: { name: string; ip: string }[];
}

export async function getEmailAlertStatus(): Promise<ToolResult<EmailAlertStatus>> {
  return run(async () => {
    await requirePermission("settings.manage");
    const { apiKey, ...settings } = await getEmailAlertConfig();
    const [lastDelivery, active, pending, snmpEquipment] = await Promise.all([
      getLastDelivery(),
      activeProblems(),
      pendingEmails(),
      prisma.equipment.findMany({ select: { name: true, ip: true }, orderBy: { name: "asc" } }),
    ]);
    return { settings, hasKey: !!apiKey, keyHint: apiKey ? apiKey.slice(-4) : null, lastDelivery, active, pending, snmpEquipment };
  });
}

/** Grava a configuração; chave vazia = mantém a atual. */
export async function saveEmailAlertSettings(settings: EmailAlertSettings, apiKey?: string): Promise<ToolResult<EmailAlertStatus>> {
  return run(async () => {
    await requirePermission("settings.manage");
    const current = await getEmailAlertConfig();
    if (settings.enabled && !apiKey?.trim() && !current.apiKey) throw new Error("Cadastre a chave da API do Resend para ativar os alertas.");
    await saveEmailAlertConfig(settings, apiKey);
    const status = await getEmailAlertStatus();
    if (!status.ok) throw new Error(status.error);
    return status.data;
  });
}

/** Manda um e-mail de teste com a configuração salva, para confirmar chave, remetente e destinatário. */
export async function sendTestAlertEmail(): Promise<ToolResult<LastDelivery | null>> {
  return run(async () => {
    await requirePermission("settings.manage");
    const config = await getEmailAlertConfig();
    const { html, text } = renderEmail({
      title: "Teste dos alertas do NetInventory",
      color: "#1565c0",
      lines: [
        ["Equipamentos vigiados", config.targets.join(", ") || "nenhum"],
        ["Limites", `CPU ${config.thresholds.cpuPct}%, memória ${config.thresholds.memPct}%, temperatura ${config.thresholds.tempC} °C`],
        ["Enviado em", new Date().toLocaleString("pt-BR")],
      ],
      footer: "Se este e-mail chegou, os alertas estão configurados. Enviado pelo NetInventory.",
    });
    await deliver(config, "✅ Teste dos alertas do NetInventory", html, text);
    return getLastDelivery();
  });
}

export async function deleteResendKey(): Promise<ToolResult<EmailAlertStatus>> {
  return run(async () => {
    await requirePermission("settings.manage");
    await removeResendKey();
    const status = await getEmailAlertStatus();
    if (!status.ok) throw new Error(status.error);
    return status.data;
  });
}
