import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ completion: vi.fn(), cacheFind: vi.fn(), cacheUpsert: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { aiCache: { findUnique: mock.cacheFind, upsert: mock.cacheUpsert }, aiUsage: { create: mock.record } } }));
vi.mock("./settings", () => ({ getAiConfig: vi.fn().mockResolvedValue({ provider: "openrouter", model: "test-model", apiKey: "synthetic-key", baseUrl: "https://openrouter.ai/api/v1" }) }));
vi.mock("openai", async (original) => {
  const actual = await original<typeof import("openai")>();
  class MockClient {
    static APIError = actual.default.APIError;
    chat = { completions: { create: mock.completion } };
  }
  return { ...actual, default: MockClient };
});
import { chatWithTools, structuredResponse, testAiConnection } from "./client";

beforeEach(() => { vi.clearAllMocks(); mock.cacheFind.mockResolvedValue(null); mock.cacheUpsert.mockResolvedValue({}); mock.record.mockResolvedValue({}); });
const opts = { feature: "summary", instructions: "synthetic", input: {}, schemaName: "test", schema: {} };

describe("Coleta integrada ao cliente IA", () => {
  it("soma separadamente as rodadas de ferramentas do chat", async () => {
    mock.completion.mockResolvedValueOnce({ usage: { total_tokens: 5 }, choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "test", arguments: "{}" } }] } }] })
      .mockResolvedValueOnce({ usage: { total_tokens: 7 }, choices: [{ message: { role: "assistant", content: "Pronto" } }] });
    expect(await chatWithTools({ instructions: "test", messages: [{ role: "user", content: "test" }], tools: { test: { definition: { type: "function", name: "test" }, run: async () => ({ count: 1 }) } } })).toBe("Pronto");
    expect(mock.record.mock.calls.map(([arg]) => arg.data.totalTokens)).toEqual([5, 7]);
    expect(mock.completion.mock.calls[0][0].usage).toEqual({ include: true });
  });
  it("registra tentativa recusada e resposta no fallback estruturado", async () => {
    mock.completion.mockRejectedValueOnce(Object.assign(new Error("unsupported schema"), { status: 400 }))
      .mockResolvedValueOnce({ usage: { total_tokens: 9 }, choices: [{ message: { content: '{"ok":true}' } }] });
    expect(await structuredResponse(opts)).toEqual({ ok: true });
    expect(mock.record.mock.calls.map(([arg]) => arg.data.status)).toEqual(["error", "success"]);
  });
  it("não chama o provedor ao servir uma análise em cache", async () => {
    mock.cacheFind.mockResolvedValue({ response: '{"ok":true}', createdAt: new Date() });
    expect(await structuredResponse(opts)).toEqual({ ok: true });
    expect(mock.completion).not.toHaveBeenCalled();
    expect(mock.record.mock.calls[0][0].data.status).toBe("cache");
  });
  it("contabiliza também o consumo do teste da chave", async () => {
    mock.completion.mockResolvedValueOnce({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, choices: [] });
    await testAiConnection({ provider: "openrouter", apiKey: "synthetic-key", model: "test-model" });
    expect(mock.record.mock.calls[0][0].data).toMatchObject({ feature: "connection-test", totalTokens: 2 });
  });
});
