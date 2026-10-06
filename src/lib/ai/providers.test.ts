import { describe, expect, it } from "vitest";
import { getProviderInfo, PROVIDERS, PROVIDER_LIST, type AiProvider } from "./providers";

describe("AI Providers Configuration", () => {
  it("contém todos os 6 provedores esperados", () => {
    const expected: AiProvider[] = ["gemini", "openrouter", "groq", "ollama", "openai", "custom"];
    for (const id of expected) {
      expect(PROVIDERS[id]).toBeDefined();
      expect(PROVIDERS[id].id).toBe(id);
    }
    expect(PROVIDER_LIST.length).toBe(6);
  });

  it("Google Gemini está configurado com modelos e endpoint do Google AI Studio", () => {
    const gemini = PROVIDERS.gemini;
    expect(gemini.name).toBe("Google Gemini");
    expect(gemini.defaultBaseUrl).toContain("generativelanguage.googleapis.com");
    expect(gemini.defaultModel).toBe("gemini-3.8-flash");
    expect(gemini.requiresApiKey).toBe(true);
    expect(gemini.apiKeyHelpUrl).toBe("https://aistudio.google.com/apikey");
    expect(gemini.models.some((m) => m.id === "gemini-3.8-flash" && m.free)).toBe(true);
  });

  it("OpenRouter inclui modelos com sufixo :free para uso gratuito", () => {
    const openrouter = PROVIDERS.openrouter;
    expect(openrouter.defaultBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(openrouter.models.some((m) => m.id.endsWith(":free"))).toBe(true);
  });

  it("Ollama não exige chave de API obrigatória", () => {
    const ollama = PROVIDERS.ollama;
    expect(ollama.requiresApiKey).toBe(false);
    expect(ollama.defaultBaseUrl).toContain("11434");
  });

  it("getProviderInfo retorna provedor correto ou Gemini por padrão", () => {
    expect(getProviderInfo("groq").id).toBe("groq");
    expect(getProviderInfo("gemini").id).toBe("gemini");
    expect(getProviderInfo(null).id).toBe("gemini");
    expect(getProviderInfo("inexistente" as unknown as AiProvider).id).toBe("gemini");
  });
});
