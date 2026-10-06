import { createHash } from "node:crypto";
import OpenAI from "openai";
import { prisma } from "@/lib/prisma";
import { getAiConfig } from "./settings";
import { PROVIDERS, type AiProvider } from "./providers";

/**
 * Cliente de IA unificado (somente no servidor).
 * Conecta a múltiplos provedores compatíveis com a API Chat Completions:
 * - Google Gemini (camada gratuita do Google AI Studio, usado no MistakeMap)
 * - OpenRouter (incluindo modelos gratuitos :free)
 * - Groq (camada gratuita de alta velocidade)
 * - Ollama (execução local 100% gratuita e privada)
 * - OpenAI (ChatGPT oficial)
 * - Personalizado / Qualquer endpoint compatível com OpenAI
 *
 * Tudo que chega aqui já foi devidamente mascarado pelo Redactor.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOOL_ROUNDS = 6;

export interface ToolHandler {
  definition: {
    type: "function";
    name?: string;
    description?: string;
    strict?: boolean;
    parameters?: Record<string, unknown>;
    function?: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  };
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

export async function isAiConfigured(): Promise<boolean> {
  const config = await getAiConfig();
  if (config.provider === "ollama") return true;
  return !!config.apiKey;
}

export async function aiModel(): Promise<string> {
  return (await getAiConfig()).model;
}

export async function aiProvider(): Promise<AiProvider> {
  return (await getAiConfig()).provider;
}

let clientState: { cacheKey: string; instance: OpenAI } | null = null;

export async function getAiClient(): Promise<{
  client: OpenAI;
  model: string;
  provider: AiProvider;
  baseUrl: string;
}> {
  const config = await getAiConfig();
  const providerDef = PROVIDERS[config.provider] ?? PROVIDERS.gemini;
  const baseUrl = config.baseUrl || providerDef.defaultBaseUrl;
  const apiKey = config.apiKey || (config.provider === "ollama" ? "ollama" : "");

  if (providerDef.requiresApiKey && !apiKey) {
    throw new Error(`IA não configurada: cadastre a chave do ${providerDef.name} em Configurações.`);
  }

  const cacheKey = `${config.provider}:${baseUrl}:${apiKey}`;
  if (!clientState || clientState.cacheKey !== cacheKey) {
    const defaultHeaders: Record<string, string> = {};
    if (config.provider === "openrouter") {
      defaultHeaders["HTTP-Referer"] = "http://localhost:3000";
      defaultHeaders["X-Title"] = "NetInventory";
    }

    clientState = {
      cacheKey,
      instance: new OpenAI({
        apiKey: apiKey || "not-required",
        baseURL: baseUrl || undefined,
        defaultHeaders: Object.keys(defaultHeaders).length ? defaultHeaders : undefined,
      }),
    };
  }

  return {
    client: clientState.instance,
    model: config.model || providerDef.defaultModel,
    provider: config.provider,
    baseUrl,
  };
}

/** Converte erros das APIs em mensagens claras em português brasileiro */
export function friendlyError(
  err: unknown,
  model?: string,
  provider: AiProvider = "gemini",
  baseUrl?: string,
): Error {
  const providerInfo = PROVIDERS[provider] ?? PROVIDERS.gemini;

  if (err instanceof OpenAI.APIError) {
    if (err.status === 401 || err.status === 403) {
      if (provider === "gemini") {
        return new Error(
          "Chave do Google AI Studio inválida. Obtenha sua chave gratuita em https://aistudio.google.com/apikey e atualize em Configurações.",
        );
      }
      if (provider === "openrouter") {
        return new Error("Chave do OpenRouter inválida. Obtenha sua chave em https://openrouter.ai/keys e atualize em Configurações.");
      }
      if (provider === "groq") {
        return new Error("Chave da Groq inválida. Obtenha sua chave gratuita em https://console.groq.com/keys e atualize em Configurações.");
      }
      if (provider === "openai") {
        return new Error("Chave da OpenAI inválida. Confira a chave em https://platform.openai.com/api-keys.");
      }
      return new Error(`Chave da API ou autorização inválida para o provedor ${providerInfo.name}.`);
    }

    if (err.status === 429) {
      if (provider === "gemini") {
        return new Error(
          "Limite de requisições do Google Gemini atingido. Aguarde alguns instantes ou verifique sua cota no Google AI Studio.",
        );
      }
      if (provider === "groq") {
        return new Error("Limite de requisições por minuto da Groq atingido. Aguarde alguns instantes e tente novamente.");
      }
      if (provider === "openrouter") {
        return new Error("Limite de requisições ou créditos esgotados no OpenRouter.");
      }
      return new Error(`Limite de uso ou cota do provedor ${providerInfo.name} atingido. Tente mais tarde.`);
    }

    if (err.status === 404) {
      return new Error(`Modelo "${model ?? "configurado"}" não encontrado no provedor ${providerInfo.name}. Verifique o modelo em Configurações.`);
    }

    return new Error(`Erro do provedor ${providerInfo.name} (${err.status ?? "rede"}): ${err.message}`);
  }

  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("ECONNREFUSED") ||
    msg.includes("Failed to fetch") ||
    msg.includes("fetch failed") ||
    msg.includes("ENOTFOUND")
  ) {
    if (provider === "ollama") {
      return new Error(
        `Não foi possível conectar ao Ollama em ${baseUrl || "http://localhost:11434"}. Verifique se o aplicativo do Ollama está em execução no seu computador.`,
      );
    }
    return new Error(
      `Não foi possível conectar ao endpoint em ${baseUrl || providerInfo.defaultBaseUrl}. Verifique o endereço e sua conexão de rede.`,
    );
  }

  return err instanceof Error ? err : new Error(String(err));
}

/** Extrai e faz o parse de JSON retornado por qualquer modelo de forma resiliente */
export function parseJsonFromAi<T>(raw: string): T {
  let text = raw.trim();

  // Remove markdown fences se o modelo retornou ```json ... ```
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  // Se houver texto antes ou depois do JSON, isola entre as primeiras e últimas chaves/colchetes
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  let startIdx = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    startIdx = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
  } else {
    startIdx = firstBracket;
  }

  if (startIdx > 0) {
    const lastBrace = text.lastIndexOf("}");
    const lastBracket = text.lastIndexOf("]");
    const endIdx = Math.max(lastBrace, lastBracket);
    if (endIdx > startIdx) {
      text = text.substring(startIdx, endIdx + 1);
    }
  }

  return JSON.parse(text) as T;
}

async function cacheKey(feature: string, payload: unknown): Promise<string> {
  const model = await aiModel();
  const provider = await aiProvider();
  return createHash("sha256").update(JSON.stringify([feature, provider, model, payload])).digest("hex");
}

async function cached<T>(feature: string, payload: unknown, compute: () => Promise<T>): Promise<T> {
  const key = await cacheKey(feature, payload);
  const hit = await prisma.aiCache.findUnique({ where: { key } });
  if (hit && Date.now() - hit.createdAt.getTime() < CACHE_TTL_MS) return JSON.parse(hit.response) as T;
  const value = await compute();
  await prisma.aiCache.upsert({
    where: { key },
    update: { response: JSON.stringify(value), createdAt: new Date() },
    create: { key, response: JSON.stringify(value) },
  });
  return value;
}

/**
 * Resposta estruturada: pede JSON válido ao modelo seguindo o schema.
 * Compatível universalmente com OpenAI, Gemini, Groq, OpenRouter, Ollama e Custom.
 * Cacheada por 24h pela entrada mascarada — a mesma análise não é cobrada duas vezes.
 */
export async function structuredResponse<T>(opts: {
  feature: string;
  instructions: string;
  input: unknown;
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<T> {
  return cached(opts.feature, [opts.instructions, opts.input, opts.schema], async () => {
    const { client: ai, model, provider, baseUrl } = await getAiClient();
    const systemPrompt = `${opts.instructions}\n\nResponda ESTRITAMENTE em formato JSON válido seguindo a estrutura solicitada. Não inclua blocos markdown como \`\`\`json no início ou no fim, retorne apenas o JSON bruto puro.`;
    const userPrompt = typeof opts.input === "string" ? opts.input : JSON.stringify(opts.input);

    try {
      let content: string | null = null;

      // Tentativa 1: tentar com json_schema
      try {
        const completion = await ai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: opts.schemaName,
              schema: opts.schema as Record<string, unknown>,
              strict: true,
            },
          },
        });
        content = completion.choices[0]?.message?.content;
      } catch {
        // Se json_schema não for aceito pelo provedor/modelo, tenta com json_object
        try {
          const completion = await ai.chat.completions.create({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
          });
          content = completion.choices[0]?.message?.content;
        } catch {
          // Fallback final: requisição normal confiando nas instruções do prompt
          const completion = await ai.chat.completions.create({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          });
          content = completion.choices[0]?.message?.content;
        }
      }

      if (!content) throw new Error("O modelo não retornou conteúdo.");
      return parseJsonFromAi<T>(content);
    } catch (err) {
      throw friendlyError(err, model, provider, baseUrl);
    }
  });
}

/**
 * Conversa com chamada de ferramentas (function calling): o modelo pede dados,
 * executamos localmente (somente leitura, já mascarados) e devolvemos,
 * até ele produzir a resposta final em texto.
 */
export async function chatWithTools(opts: {
  instructions: string;
  messages: { role: "user" | "assistant"; content: string }[];
  tools: Record<string, ToolHandler>;
}): Promise<string> {
  const { client: ai, model, provider, baseUrl } = await getAiClient();

  const formattedTools: OpenAI.Chat.ChatCompletionTool[] = Object.values(opts.tools).map((t) => {
    const def = t.definition;
    const func = def.function ?? {
      name: def.name ?? "",
      description: def.description,
      parameters: def.parameters,
    };
    return {
      type: "function",
      function: {
        name: func.name,
        description: func.description,
        parameters: func.parameters,
      },
    };
  });

  const conversationMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.instructions },
    ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const completion = await ai.chat.completions.create({
        model,
        messages: conversationMessages,
        tools: formattedTools.length ? formattedTools : undefined,
      });

      const choice = completion.choices[0];
      const message = choice?.message;
      if (!message) break;

      conversationMessages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        return message.content || "";
      }

      for (const toolCall of message.tool_calls) {
        if (toolCall.type === "function") {
          const handler = opts.tools[toolCall.function.name];
          let output: unknown;
          try {
            const args = JSON.parse(toolCall.function.arguments || "{}");
            output = handler ? await handler.run(args) : { erro: `ferramenta desconhecida: ${toolCall.function.name}` };
          } catch (err) {
            output = { erro: err instanceof Error ? err.message : String(err) };
          }
          conversationMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(output),
          });
        }
      }
    }
    return "Não consegui concluir a resposta (muitas consultas seguidas). Tente reformular a pergunta.";
  } catch (err) {
    throw friendlyError(err, model, provider, baseUrl);
  }
}

/** Testa a conexão e o modelo com uma chamada de teste mínima */
export async function testAiConnection(opts: {
  provider: AiProvider;
  apiKey?: string | null;
  model: string;
  baseUrl?: string | null;
}): Promise<void> {
  const providerInfo = PROVIDERS[opts.provider] ?? PROVIDERS.gemini;
  const baseUrl = opts.baseUrl?.trim() || providerInfo.defaultBaseUrl;
  const apiKey = opts.apiKey?.trim() || (opts.provider === "ollama" ? "ollama" : "");

  if (providerInfo.requiresApiKey && !apiKey) {
    throw new Error(`Informe a chave da API para o provedor ${providerInfo.name}.`);
  }

  const defaultHeaders: Record<string, string> = {};
  if (opts.provider === "openrouter") {
    defaultHeaders["HTTP-Referer"] = "http://localhost:3000";
    defaultHeaders["X-Title"] = "NetInventory";
  }

  const testClient = new OpenAI({
    apiKey: apiKey || "not-required",
    baseURL: baseUrl || undefined,
    defaultHeaders: Object.keys(defaultHeaders).length ? defaultHeaders : undefined,
  });

  try {
    // Teste com completion de 1 token: valida autenticação, conectividade e disponibilidade do modelo
    await testClient.chat.completions.create({
      model: opts.model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
  } catch (err: unknown) {
    const errObj = err as { message?: string; code?: string; status?: number } | null;
    // Modelos que usam max_completion_tokens (como o1/o3)
    if (errObj?.message?.includes("max_completion_tokens") || errObj?.code === "unsupported_parameter") {
      try {
        await testClient.chat.completions.create({
          model: opts.model,
          messages: [{ role: "user", content: "ping" }],
          max_completion_tokens: 1,
        });
        return;
      } catch (err2) {
        throw friendlyError(err2, opts.model, opts.provider, baseUrl);
      }
    }

    // Se o erro não for de autenticação (ex.: 401/403), tenta listar os modelos como fallback
    if (errObj?.status !== 401 && errObj?.status !== 403) {
      try {
        await testClient.models.list();
        return;
      } catch {
        // mantém o erro original
      }
    }

    throw friendlyError(err, opts.model, opts.provider, baseUrl);
  }
}
