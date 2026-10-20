import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";

const db = vi.hoisted(() => ({ create: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), findFirst: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { aiUsage: db } }));
import { completionUsage, getLocalAiUsage, getProviderAiUsage, measuredCompletion, parseOpenRouterUsage, recordCacheHit } from "./usage";

beforeEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); db.create.mockResolvedValue({}); });

describe("Metadados de consumo de IA", () => {
  it("mantém consumo desconhecido distinto de zero e rejeita valores inválidos", () => {
    expect(completionUsage(undefined)).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
    expect(completionUsage({ prompt_tokens: 0, completion_tokens: -1, total_tokens: NaN, cost: 0 })).toEqual({ inputTokens: 0, outputTokens: null, totalTokens: null, costUsd: 0 });
  });
  it("registra cada completion, inclusive rodadas do chat, sem guardar conteúdo", async () => {
    const completion = { choices: [{ message: { content: "conteúdo privado" } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.001 } } as unknown as OpenAI.Chat.ChatCompletion;
    const context = { provider: "openrouter", model: "test-model", feature: "assistant" };
    expect(await measuredCompletion(context, async () => completion)).toBe(completion);
    await measuredCompletion(context, async () => completion);
    expect(db.create).toHaveBeenCalledTimes(2);
    expect(db.create.mock.calls[0][0].data).toMatchObject({ ...context, totalTokens: 30, costUsd: 0.001, status: "success" });
    expect(JSON.stringify(db.create.mock.calls)).not.toContain("conteúdo privado");
  });
  it("registra status de falhas sem guardar mensagens do provedor", async () => {
    const error = Object.assign(new Error("credencial ou prompt privado"), { status: 429 });
    await expect(measuredCompletion({ provider: "gemini", model: "test", feature: "summary" }, async () => { throw error; })).rejects.toBe(error);
    expect(db.create.mock.calls[0][0].data).toMatchObject({ status: "error", httpStatus: 429 });
    expect(JSON.stringify(db.create.mock.calls)).not.toContain("privado");
  });
  it("falha na telemetria não descarta uma resposta válida", async () => {
    db.create.mockRejectedValue(new Error("db unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const completion = { usage: undefined } as OpenAI.Chat.ChatCompletion;
    expect(await measuredCompletion({ provider: "ollama", model: "test", feature: "assistant" }, async () => completion)).toBe(completion);
    warn.mockRestore();
  });
  it("cache não contabiliza novos tokens ou custo", async () => {
    await recordCacheHit({ provider: "groq", model: "test", feature: "identify" });
    expect(db.create.mock.calls[0][0].data).toEqual({ provider: "groq", model: "test", feature: "identify", status: "cache", durationMs: 0 });
  });
  it("agrega todos os modelos e separa chamadas de cache", async () => {
    db.aggregate.mockResolvedValue({ _count: { _all: 3, totalTokens: 2, costUsd: 1 }, _sum: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 }, _avg: { durationMs: 250 } });
    db.groupBy.mockResolvedValueOnce([{ status: "success", _count: { _all: 2 } }, { status: "error", _count: { _all: 1 } }, { status: "cache", _count: { _all: 4 } }]).mockResolvedValueOnce([]);
    db.findFirst.mockResolvedValue({ createdAt: new Date("2026-10-11T12:00:00Z") });
    expect(await getLocalAiUsage("7d")).toMatchObject({ requests: 3, errors: 1, cacheHits: 4, totalTokens: 15, tokenReports: 2, costUsd: 0 });
    expect(db.aggregate.mock.calls[0][0].where.status).toEqual({ not: "cache" });
    expect(db.aggregate.mock.calls[0][0].where.createdAt.gte).toBeInstanceOf(Date);
  });
});

describe("Saldo e limites do provedor", () => {
  const config = { provider: "openrouter" as const, apiKey: "test-key", model: "test", baseUrl: "https://openrouter.ai/api/v1" };
  it("separa saldo da conta, teto da chave e cota gratuita", () => {
    expect(parseOpenRouterUsage({ limit: 10, limit_remaining: 4, usage: 6, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } }, { total_credits: 100, total_usage: 20 })).toMatchObject({ accountBalance: 80, keyLimit: 10, keyRemaining: 4, keyUsage: 6, freeRequestsRemaining: 47 });
    expect(parseOpenRouterUsage({}, {}).keyRemaining).toBeNull();
  });
  it("mantém limites da chave quando saldo exige chave de gerenciamento", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { limit_remaining: 0, usage: 10 } }))).mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await getProviderAiUsage(config);
    expect(result).toMatchObject({ state: "available", keyRemaining: 0, accountBalance: null });
    expect(result.message).toContain("gerenciamento");
    expect(fetcher.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/key");
    expect(JSON.stringify(result)).not.toContain("test-key");
  });
  it("não transmite credenciais de endpoints personalizados para o OpenRouter", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await getProviderAiUsage({ ...config, baseUrl: "https://other.example/v1" })).state).toBe("unsupported");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("não fabrica saldo para Ollama ou provedor sem consulta suportada", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await getProviderAiUsage({ ...config, provider: "ollama", apiKey: null })).accountBalance).toBeNull();
    expect((await getProviderAiUsage({ ...config, provider: "groq" })).state).toBe("unsupported");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("devolve erro seguro quando o provedor falha", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private-provider-response")));
    const result = await getProviderAiUsage(config);
    expect(result.state).toBe("error");
    expect(JSON.stringify(result)).not.toContain("private-provider-response");
  });
});
