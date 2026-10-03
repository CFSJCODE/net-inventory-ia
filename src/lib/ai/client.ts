import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { ResponseInputItem, Tool } from "openai/resources/responses/responses";
import { prisma } from "@/lib/prisma";
import { getAiConfig } from "./settings";

/**
 * Acesso à OpenAI (somente no servidor). Tudo que chega aqui já foi mascarado pelo Redactor.
 * `store: false` pede que a OpenAI não guarde as conversas no histórico da conta.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function isAiConfigured(): Promise<boolean> {
  return !!(await getAiConfig()).apiKey;
}

export async function aiModel(): Promise<string> {
  return (await getAiConfig()).model;
}

// Recriado quando a chave muda pela tela de configurações.
let client: { apiKey: string; instance: OpenAI } | null = null;
async function openai(): Promise<OpenAI> {
  const { apiKey } = await getAiConfig();
  if (!apiKey) throw new Error("IA não configurada: cadastre a chave da OpenAI em Configurações.");
  if (client?.apiKey !== apiKey) client = { apiKey, instance: new OpenAI({ apiKey }) };
  return client.instance;
}

/** Converte erros da API em mensagens úteis em português (chave inválida, cota, limite de taxa...). */
export function friendlyError(err: unknown, model?: string): Error {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 401) return new Error("Chave da OpenAI inválida. Confira a chave em Configurações.");
    if (err.status === 429) return new Error("Limite de uso ou cota da OpenAI atingido. Verifique o faturamento da conta ou tente mais tarde.");
    if (err.status === 404) return new Error(`Modelo "${model ?? "configurado"}" não encontrado. Ajuste o modelo em Configurações.`);
    return new Error(`Erro da OpenAI (${err.status ?? "rede"}): ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function cacheKey(feature: string, payload: unknown): Promise<string> {
  return createHash("sha256").update(JSON.stringify([feature, await aiModel(), payload])).digest("hex");
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
 * Resposta estruturada: o modelo é obrigado a seguir o JSON Schema (Structured Outputs, strict).
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
    const model = await aiModel();
    try {
      const response = await (await openai()).responses.create({
        model,
        instructions: opts.instructions,
        input: JSON.stringify(opts.input),
        text: { format: { type: "json_schema", name: opts.schemaName, schema: opts.schema, strict: true } },
        store: false,
      });
      return JSON.parse(response.output_text) as T;
    } catch (err) {
      throw friendlyError(err, model);
    }
  });
}

export interface ToolHandler {
  definition: Tool;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const MAX_TOOL_ROUNDS = 6;

/**
 * Conversa com chamada de ferramentas (function calling): o modelo pede dados, executamos localmente
 * (somente leitura, já mascarados) e devolvemos, até ele produzir a resposta final em texto.
 */
export async function chatWithTools(opts: {
  instructions: string;
  messages: { role: "user" | "assistant"; content: string }[];
  tools: Record<string, ToolHandler>;
}): Promise<string> {
  const input: ResponseInputItem[] = opts.messages.map((m) => ({ role: m.role, content: m.content }));
  const model = await aiModel();
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await (await openai()).responses.create({
        model,
        instructions: opts.instructions,
        input,
        tools: Object.values(opts.tools).map((t) => t.definition),
        store: false,
        // Com store:false, o raciocínio do modelo precisa voltar criptografado entre as rodadas.
        include: ["reasoning.encrypted_content"],
      });

      const calls = response.output.filter((item) => item.type === "function_call");
      if (!calls.length) return response.output_text;

      input.push(...(response.output as ResponseInputItem[]));
      for (const call of calls) {
        const handler = opts.tools[call.name];
        let output: unknown;
        try {
          output = handler ? await handler.run(JSON.parse(call.arguments || "{}")) : { erro: `ferramenta desconhecida: ${call.name}` };
        } catch (err) {
          output = { erro: err instanceof Error ? err.message : String(err) };
        }
        input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
      }
    }
    return "Não consegui concluir a resposta (muitas consultas seguidas). Tente reformular a pergunta.";
  } catch (err) {
    throw friendlyError(err, model);
  }
}
