import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { friendlyError, parseJsonFromAi } from "./client";

describe("AI Client Helpers", () => {
  describe("parseJsonFromAi", () => {
    it("faz parse de JSON puro", () => {
      const parsed = parseJsonFromAi<{ ok: boolean }>('{"ok": true}');
      expect(parsed).toEqual({ ok: true });
    });

    it("remove blocos markdown ```json", () => {
      const raw = '```json\n{\n  "nome": "Dispositivo teste",\n  "portas": [80, 443]\n}\n```';
      const parsed = parseJsonFromAi<{ nome: string; portas: number[] }>(raw);
      expect(parsed).toEqual({ nome: "Dispositivo teste", portas: [80, 443] });
    });

    it("extrai JSON mesmo se o modelo tiver adicionado texto antes ou depois", () => {
      const raw = 'Aqui está a resposta solicitada:\n```json\n{"status": "ONLINE"}\n```\nEspero ter ajudado!';
      const parsed = parseJsonFromAi<{ status: string }>(raw);
      expect(parsed).toEqual({ status: "ONLINE" });
    });

    it("extrai array JSON", () => {
      const raw = "Resultado: [1, 2, 3]";
      const parsed = parseJsonFromAi<number[]>(raw);
      expect(parsed).toEqual([1, 2, 3]);
    });
  });

  describe("friendlyError", () => {
    it("formata erro 401 do Gemini apontando para o AI Studio", () => {
      const apiErr = new OpenAI.APIError(401, { error: { message: "Invalid API key" } }, "Invalid API key", new Headers());
      const err = friendlyError(apiErr, "gemini-2.5-flash", "gemini");
      expect(err.message).toContain("Google AI Studio");
      expect(err.message).toContain("aistudio.google.com/apikey");
    });

    it("formata erro 429 do Gemini apontando para cota", () => {
      const apiErr = new OpenAI.APIError(429, { error: { message: "Quota exceeded" } }, "Quota exceeded", new Headers());
      const err = friendlyError(apiErr, "gemini-2.5-flash", "gemini");
      expect(err.message).toContain("Google Gemini");
      expect(err.message).toContain("Google AI Studio");
    });

    it("formata erro de conexão do Ollama explicando se o app está aberto", () => {
      const netErr = new Error("connect ECONNREFUSED 127.0.0.1:11434");
      const err = friendlyError(netErr, "llama3.2", "ollama", "http://localhost:11434/v1");
      expect(err.message).toContain("Ollama");
      expect(err.message).toContain("http://localhost:11434");
    });

    it("formata erro 404 de modelo não encontrado", () => {
      const apiErr = new OpenAI.APIError(404, { error: { message: "Not found" } }, "Not found", new Headers());
      const err = friendlyError(apiErr, "modelo-inexistente", "groq");
      expect(err.message).toContain('Modelo "modelo-inexistente" não encontrado no provedor Groq');
    });
  });
});
