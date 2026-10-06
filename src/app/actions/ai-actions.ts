"use server";

import { requirePermission, requireSession } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { testAiConnection } from "@/lib/ai/client";
import { can } from "@/lib/auth/permissions";
import { dismissAiOnboarding, getAiConfig, isAiOnboardingDismissed, removeAiKey, saveAiConfig } from "@/lib/ai/settings";
import { PROVIDERS, type AiProvider } from "@/lib/ai/providers";
import {
  askAssistant,
  explainDeviceSecurity,
  explainNetworkSecurity,
  networkFindings,
  suggestIdentities,
  summarizeEvents,
  type ChatMessage,
  type IdentitySuggestion,
  type SecurityReport,
  type SummaryPeriod,
} from "@/lib/ai/features";
import { findingsForPorts, parsePorts, type SecurityFinding } from "@/lib/security-rules";
import type { ToolResult } from "./tool-actions";

async function run<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface AiStatus {
  configured: boolean;
  provider: AiProvider;
  providerName: string;
  model: string;
  baseUrl: string;
  /** Últimos 4 caracteres da chave, para o usuário reconhecer qual está em uso. A chave em si nunca vai ao navegador. */
  keyHint: string | null;
  requiresApiKey: boolean;
  /** Mostrar o aviso de boas-vindas da chave: sem chave, usuário que pode cadastrá-la e ainda não o dispensou. */
  onboardingPending: boolean;
}

export async function getAiStatus(): Promise<AiStatus> {
  const user = await requireSession();
  const config = await getAiConfig();
  const providerDef = PROVIDERS[config.provider] ?? PROVIDERS.gemini;
  const isConfigured = config.provider === "ollama" ? true : !!config.apiKey;

  return {
    configured: isConfigured,
    provider: config.provider,
    providerName: providerDef.name,
    model: config.model,
    baseUrl: config.baseUrl,
    keyHint: config.apiKey ? config.apiKey.slice(-4) : null,
    requiresApiKey: providerDef.requiresApiKey,
    onboardingPending: !isConfigured && can(user.role, "settings.manage") && !(await isAiOnboardingDismissed(user.id)),
  };
}

/** "Agora não" no aviso da chave: não mostra mais para este usuário nesta instalação. */
export async function dismissAiKeyOnboarding(): Promise<AiStatus> {
  const user = await requireSession();
  await dismissAiOnboarding(user.id);
  return getAiStatus();
}

/**
 * Salva o provedor, a chave e o modelo depois de testá-los no provedor escolhido.
 * Sem chave nova, testa a atual com o provedor/modelo informado.
 */
export async function saveAiSettings(input: {
  provider: AiProvider;
  apiKey?: string;
  model: string;
  baseUrl?: string;
}): Promise<ToolResult<AiStatus>> {
  await requirePermission("settings.manage");
  return run(async () => {
    const provider = input.provider in PROVIDERS ? input.provider : "gemini";
    const providerDef = PROVIDERS[provider];
    const apiKey = input.apiKey?.trim() || undefined;
    const model = input.model?.trim() || providerDef.defaultModel;
    const baseUrl = input.baseUrl?.trim() || providerDef.defaultBaseUrl;

    if (!model) throw new Error("Informe o modelo.");

    const currentConfig = await getAiConfig();
    const keyToTest = apiKey ?? (provider === currentConfig.provider ? currentConfig.apiKey : undefined);

    if (providerDef.requiresApiKey && !keyToTest) {
      throw new Error(`Informe a chave da API para o provedor ${providerDef.name}.`);
    }

    // Testa a conexão antes de gravar
    await testAiConnection({
      provider,
      apiKey: keyToTest,
      model,
      baseUrl,
    });

    await saveAiConfig({ provider, apiKey, model, baseUrl });
    return getAiStatus();
  });
}

export async function deleteAiKey(): Promise<AiStatus> {
  await requirePermission("settings.manage");
  await removeAiKey();
  return getAiStatus();
}

export async function aiSuggestIdentities(deviceIds: string[]): Promise<ToolResult<IdentitySuggestion[]>> {
  await requirePermission("ai.use");
  return run(() => {
    if (!deviceIds.length || deviceIds.length > 40) throw new Error("Selecione de 1 a 40 dispositivos.");
    return suggestIdentities(deviceIds);
  });
}

/** Dispositivos sem nome (nem apelido nem hostname) — candidatos à identificação em massa. */
export async function listUnnamedDeviceIds(): Promise<string[]> {
  await requireSession();
  const devices = await prisma.device.findMany({ where: { alias: null, hostname: null }, select: { id: true }, take: 40 });
  return devices.map((d) => d.id);
}

/** Achados locais (sem IA, sem custo) de um dispositivo. */
export async function getDeviceFindings(deviceId: string): Promise<SecurityFinding[]> {
  await requireSession();
  const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { openPorts: true } });
  return findingsForPorts(parsePorts(device?.openPorts ?? null));
}

export async function aiExplainDeviceSecurity(deviceId: string): Promise<ToolResult<SecurityReport>> {
  await requirePermission("ai.use");
  return run(() => explainDeviceSecurity(deviceId));
}

export async function getNetworkFindings() {
  await requireSession();
  const [results, devices] = await Promise.all([networkFindings(), prisma.device.findMany({ select: { id: true, ip: true, hostname: true, alias: true } })]);
  const byId = new Map(devices.map((d) => [d.id, d]));
  return results.map((r) => ({ ...r, device: byId.get(r.deviceId)! }));
}

export async function aiExplainNetworkSecurity(): Promise<ToolResult<string>> {
  await requirePermission("ai.use");
  return run(explainNetworkSecurity);
}

export async function aiSummarizeEvents(period: SummaryPeriod): Promise<ToolResult<string>> {
  await requirePermission("ai.use");
  return run(() => {
    if (period !== "24h" && period !== "7d") throw new Error("Período inválido.");
    return summarizeEvents(period);
  });
}

export async function getLatestSummary(): Promise<{ period: string; text: string; createdAt: string } | null> {
  await requireSession();
  const s = await prisma.aiSummary.findFirst({ orderBy: { createdAt: "desc" } });
  return s ? { period: s.period, text: s.text, createdAt: s.createdAt.toISOString() } : null;
}

export async function aiAsk(messages: ChatMessage[]): Promise<ToolResult<string>> {
  await requirePermission("ai.use");
  return run(() => {
    const clean = messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!clean.length || clean[clean.length - 1].role !== "user") throw new Error("Envie uma pergunta.");
    return askAssistant(clean);
  });
}
