import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Configuração da OpenAI feita pela tela de Configurações. Sem chave cadastrada aqui, os recursos de IA
 * ficam desativados (o OPENAI_API_KEY do .env não é usado). A chave fica no banco criptografada
 * (AES-256-GCM) com uma chave derivada do AUTH_SECRET: quem copiar só o arquivo do banco não consegue lê-la.
 */

export const DEFAULT_MODEL = "gpt-5.4-mini";

const KEY_SETTING = "openai.apiKey";
const MODEL_SETTING = "openai.model";

export interface AiConfig {
  apiKey: string | null;
  model: string;
}

function cipherKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET ausente ou curto demais no .env (mínimo 32 caracteres).");
  return createHash("sha256").update(`netinventory:settings:${secret}`).digest();
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

/** null se o valor não puder ser aberto (ex.: AUTH_SECRET trocado) — a chave precisa ser cadastrada de novo. */
function decrypt(stored: string): string | null {
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

export async function getAiConfig(): Promise<AiConfig> {
  if (cache) return cache;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: [KEY_SETTING, MODEL_SETTING] } } });
  const stored = rows.find((r) => r.key === KEY_SETTING);
  cache = {
    apiKey: stored ? decrypt(stored.value) : null,
    model: rows.find((r) => r.key === MODEL_SETTING)?.value || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
  };
  return cache;
}

/** Grava a chave (se informada) e o modelo. Chave omitida = mantém a atual. */
export async function saveAiConfig(opts: { apiKey?: string; model: string }): Promise<void> {
  const writes = [prisma.appSetting.upsert({ where: { key: MODEL_SETTING }, update: { value: opts.model }, create: { key: MODEL_SETTING, value: opts.model } })];
  if (opts.apiKey) {
    const value = encrypt(opts.apiKey);
    writes.push(prisma.appSetting.upsert({ where: { key: KEY_SETTING }, update: { value }, create: { key: KEY_SETTING, value } }));
  }
  await prisma.$transaction(writes);
  cache = null;
}

// O "já vi o aviso da chave" fica no banco, por usuário: vale para a instalação, não para o navegador
// (no localStorage, uma reinstalação ou outro app em localhost:3000 herdava a marca e o aviso sumia).
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
  await prisma.appSetting.deleteMany({ where: { key: KEY_SETTING } });
  cache = null;
}
