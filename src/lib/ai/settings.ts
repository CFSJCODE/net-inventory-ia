import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { PROVIDERS, type AiProvider } from "./providers";

/**
 * Configuração da IA feita pela tela de Configurações.
 * Suporta múltiplos provedores: Google Gemini (mesmo ecossistema usado no MistakeMap),
 * OpenRouter, Groq, Ollama (Local) e OpenAI (ChatGPT).
 * A chave fica no banco criptografada (AES-256-GCM) com uma chave derivada do AUTH_SECRET.
 */

export const DEFAULT_PROVIDER: AiProvider = "gemini";
export const DEFAULT_MODEL = PROVIDERS.gemini.defaultModel;

const KEY_PROVIDER = "ai.provider";
const KEY_API_KEY = "ai.apiKey";
const KEY_MODEL = "ai.model";
const KEY_BASE_URL = "ai.baseUrl";

// Chaves legadas da versão anterior (OpenAI exclusivo)
const LEGACY_KEY_SETTING = "openai.apiKey";
const LEGACY_MODEL_SETTING = "openai.model";

export interface AiConfig {
  provider: AiProvider;
  apiKey: string | null;
  model: string;
  baseUrl: string;
}

function cipherKey(): Buffer {
  const secret =
    process.env.AUTH_SECRET ||
    (process.env.NODE_ENV === "test" || !process.env.AUTH_SECRET ? "netinventory-default-fallback-secret-at-least-32-characters" : undefined);
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET ausente ou curto demais no .env (mínimo 32 caracteres).");
  }
  return createHash("sha256").update(`netinventory:settings:${secret}`).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

/** null se o valor não puder ser aberto (ex.: AUTH_SECRET trocado) — a chave precisa ser cadastrada de novo. */
export function decrypt(stored: string): string | null {
  try {
    const [iv, tag, data] = stored.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", cipherKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// Lida a cada chamada de IA: guarda em memória e só volta ao banco depois de uma alteração.
let cache: AiConfig | null = null;

export function clearAiConfigCache(): void {
  cache = null;
}

export async function getAiConfig(): Promise<AiConfig> {
  if (cache) return cache;

  const rows = await prisma.appSetting.findMany({
    where: {
      key: {
        in: [KEY_PROVIDER, KEY_API_KEY, KEY_MODEL, KEY_BASE_URL, LEGACY_KEY_SETTING, LEGACY_MODEL_SETTING],
      },
    },
  });

  const getRow = (key: string) => rows.find((r) => r.key === key)?.value;

  const storedProvider = getRow(KEY_PROVIDER) as AiProvider | undefined;
  const storedApiKeyEnc = getRow(KEY_API_KEY);
  const storedModel = getRow(KEY_MODEL);
  const storedBaseUrl = getRow(KEY_BASE_URL);

  // Verificação de compatibilidade com instalações existentes
  const legacyApiKeyEnc = getRow(LEGACY_KEY_SETTING);
  const legacyModel = getRow(LEGACY_MODEL_SETTING);

  let provider: AiProvider = DEFAULT_PROVIDER;
  let rawEncryptedKey: string | undefined = storedApiKeyEnc;
  let model: string = storedModel || "";
  let baseUrl: string = storedBaseUrl || "";

  if (storedProvider && storedProvider in PROVIDERS) {
    provider = storedProvider;
  } else if (legacyApiKeyEnc) {
    // Instalação prévia que já usava OpenAI
    provider = "openai";
    rawEncryptedKey = legacyApiKeyEnc;
    model = legacyModel || process.env.OPENAI_MODEL?.trim() || PROVIDERS.openai.defaultModel;
  }

  const providerDef = PROVIDERS[provider] ?? PROVIDERS[DEFAULT_PROVIDER];

  if (!model) {
    model = providerDef.defaultModel;
  }

  if (!baseUrl) {
    baseUrl = providerDef.defaultBaseUrl;
  }

  cache = {
    provider,
    apiKey: rawEncryptedKey ? decrypt(rawEncryptedKey) : null,
    model,
    baseUrl,
  };

  return cache;
}

/** Grava provedor, modelo, baseUrl e chave (se informada). Chave omitida = mantém a atual. */
export async function saveAiConfig(opts: {
  provider: AiProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<void> {
  const provider = opts.provider in PROVIDERS ? opts.provider : DEFAULT_PROVIDER;
  const providerDef = PROVIDERS[provider];
  const model = opts.model.trim() || providerDef.defaultModel;
  const baseUrl = opts.baseUrl?.trim() || providerDef.defaultBaseUrl;

  const writes = [
    prisma.appSetting.upsert({
      where: { key: KEY_PROVIDER },
      update: { value: provider },
      create: { key: KEY_PROVIDER, value: provider },
    }),
    prisma.appSetting.upsert({
      where: { key: KEY_MODEL },
      update: { value: model },
      create: { key: KEY_MODEL, value: model },
    }),
    prisma.appSetting.upsert({
      where: { key: KEY_BASE_URL },
      update: { value: baseUrl },
      create: { key: KEY_BASE_URL, value: baseUrl },
    }),
  ];

  if (opts.apiKey !== undefined && opts.apiKey.trim()) {
    const encrypted = encrypt(opts.apiKey.trim());
    writes.push(
      prisma.appSetting.upsert({
        where: { key: KEY_API_KEY },
        update: { value: encrypted },
        create: { key: KEY_API_KEY, value: encrypted },
      }),
    );

    // Se for OpenAI, atualiza também a chave legada para retrocompatibilidade
    if (provider === "openai") {
      writes.push(
        prisma.appSetting.upsert({
          where: { key: LEGACY_KEY_SETTING },
          update: { value: encrypted },
          create: { key: LEGACY_KEY_SETTING, value: encrypted },
        }),
      );
    }
  }

  await prisma.$transaction(writes);
  cache = null;
}

// O "já vi o aviso da chave" fica no banco, por usuário
const onboardingKey = (userId: string) => `ai.onboardingDismissed:${userId}`;

export async function isAiOnboardingDismissed(userId: string): Promise<boolean> {
  return !!(await prisma.appSetting.findUnique({ where: { key: onboardingKey(userId) } }));
}

export async function dismissAiOnboarding(userId: string): Promise<void> {
  const key = onboardingKey(userId);
  const value = new Date().toISOString();
  await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

/** Remove a chave cadastrada — os recursos de IA ficam desativados. */
export async function removeAiKey(): Promise<void> {
  await prisma.appSetting.deleteMany({
    where: {
      key: { in: [KEY_API_KEY, LEGACY_KEY_SETTING] },
    },
  });
  cache = null;
}
