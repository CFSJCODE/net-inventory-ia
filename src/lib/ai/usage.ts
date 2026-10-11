import type OpenAI from "openai";
import { prisma } from "@/lib/prisma";
import type { AiConfig } from "./settings";
import type { UsagePeriod } from "./usage-types";
export { USAGE_PERIODS, type UsagePeriod } from "./usage-types";

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokens(value: unknown): number | null {
  const number = finite(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

export function completionUsage(usage: unknown) {
  const data = (usage ?? {}) as Record<string, unknown>;
  return {
    inputTokens: tokens(data.prompt_tokens),
    outputTokens: tokens(data.completion_tokens),
    totalTokens: tokens(data.total_tokens),
    costUsd: finite(data.cost),
  };
}

/** A telemetria não pode impedir uma resposta. Só metadados, inclusive nas falhas. */
async function record(data: Parameters<typeof prisma.aiUsage.create>[0]["data"]) {
  try {
    await prisma.aiUsage.create({ data });
  } catch {
    console.warn("Não foi possível registrar os metadados de consumo da IA.");
  }
}

export async function measuredCompletion(
  context: { provider: string; model: string; feature: string },
  request: () => Promise<OpenAI.Chat.ChatCompletion>,
) {
  const started = Date.now();
  try {
    const completion = await request();
    await record({ ...context, status: "success", durationMs: Date.now() - started, ...completionUsage(completion.usage) });
    return completion;
  } catch (error) {
    const status = finite((error as { status?: unknown } | null)?.status);
    await record({ ...context, status: "error", durationMs: Date.now() - started, httpStatus: status });
    throw error;
  }
}

export async function recordCacheHit(context: { provider: string; model: string; feature: string }) {
  await record({ ...context, status: "cache", durationMs: 0 });
}

export async function getLocalAiUsage(period: UsagePeriod) {
  const days = { "24h": 1, "7d": 7, "30d": 30, all: 0 }[period];
  const where = days ? { createdAt: { gte: new Date(Date.now() - days * 86_400_000) } } : {};
  const [totals, statuses, features, first] = await Promise.all([
    prisma.aiUsage.aggregate({ where: { ...where, status: { not: "cache" } },
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true, costUsd: true },
      _count: { _all: true, totalTokens: true, costUsd: true },
      _avg: { durationMs: true } }),
    prisma.aiUsage.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.aiUsage.groupBy({ by: ["feature", "provider", "model"], where,
      _count: { _all: true, totalTokens: true }, _sum: { totalTokens: true, costUsd: true }, orderBy: { _count: { feature: "desc" } } }),
    prisma.aiUsage.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  const count = (status: string) => statuses.find((row) => row.status === status)?._count._all ?? 0;
  return {
    requests: totals._count._all, successful: count("success"), errors: count("error"), cacheHits: count("cache"),
    inputTokens: totals._sum.inputTokens, outputTokens: totals._sum.outputTokens, totalTokens: totals._sum.totalTokens,
    costUsd: totals._sum.costUsd, tokenReports: totals._count.totalTokens, costReports: totals._count.costUsd,
    averageDurationMs: totals._avg.durationMs, trackingSince: first?.createdAt.toISOString() ?? null,
    features: features.map((row) => ({ feature: row.feature, provider: row.provider, model: row.model,
      events: row._count._all, tokenReports: row._count.totalTokens, totalTokens: row._sum.totalTokens, costUsd: row._sum.costUsd })),
  };
}

export interface ProviderUsage {
  state: "available" | "unsupported" | "unconfigured" | "error";
  message: string;
  checkedAt: string;
  accountBalance: number | null;
  keyLimit: number | null;
  keyRemaining: number | null;
  keyUsage: number | null;
  dailyUsage: number | null;
  monthlyUsage: number | null;
  reset: string | null;
  freeRequestsUsed: number | null;
  freeRequestsLimit: number | null;
  freeRequestsRemaining: number | null;
}

export function parseOpenRouterUsage(key: unknown, credits: unknown): Omit<ProviderUsage, "state" | "message" | "checkedAt"> {
  const data = (key ?? {}) as Record<string, unknown>;
  const balance = (credits ?? {}) as Record<string, unknown>;
  const free = (data.free_model_daily_requests ?? {}) as Record<string, unknown>;
  const totalCredits = finite(balance.total_credits);
  const totalUsage = finite(balance.total_usage);
  return {
    accountBalance: totalCredits !== null && totalUsage !== null ? totalCredits - totalUsage : null,
    keyLimit: finite(data.limit), keyRemaining: finite(data.limit_remaining), keyUsage: finite(data.usage),
    dailyUsage: finite(data.usage_daily), monthlyUsage: finite(data.usage_monthly),
    reset: typeof data.limit_reset === "string" ? data.limit_reset : null,
    freeRequestsUsed: tokens(free.used), freeRequestsLimit: tokens(free.limit), freeRequestsRemaining: tokens(free.remaining),
  };
}

/** Consultas de saldo sem inferência; credencial só no servidor e no endpoint oficial. */
export async function getProviderAiUsage(config: AiConfig): Promise<ProviderUsage> {
  const empty: ProviderUsage = { state: "unsupported", message: "Este provedor não oferece consulta automática de saldo neste painel. Consulte as cotas no painel do provedor.",
    checkedAt: new Date().toISOString(), ...parseOpenRouterUsage(null, null) };
  if (config.provider === "ollama") return { ...empty, message: "No Ollama local, não há saldo de créditos de API. A capacidade depende do servidor e do modelo instalado." };
  if (!config.apiKey) return { ...empty, state: "unconfigured", message: "Configure a IA para consultar os limites do provedor." };
  if (config.provider !== "openrouter" || config.baseUrl.replace(/\/$/, "") !== "https://openrouter.ai/api/v1") return empty;
  async function read(path: string) {
    const response = await fetch(`https://openrouter.ai/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` }, cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Consulta indisponível");
    const body = await response.json();
    if (!body.data || typeof body.data !== "object") throw new Error("Resposta indisponível");
    return body.data;
  }
  const [key, credits] = await Promise.allSettled([read("key"), read("credits")]);
  if (key.status === "rejected" && credits.status === "rejected") return { ...empty, state: "error", message: "Não foi possível consultar o OpenRouter. Verifique a conexão e as permissões da chave e tente atualizar." };
  return { ...empty, ...parseOpenRouterUsage(key.status === "fulfilled" ? key.value : null, credits.status === "fulfilled" ? credits.value : null),
    state: "available", message: credits.status === "fulfilled" ? "Dados consultados no OpenRouter. O saldo da conta e o limite da chave são independentes." : "Limites da chave consultados no OpenRouter. O saldo da conta exige permissão de gerenciamento; consulte-o no painel do provedor." };
}
