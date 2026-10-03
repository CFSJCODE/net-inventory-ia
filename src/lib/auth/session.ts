/**
 * Sessão em cookie assinado (HMAC-SHA256). Usa apenas Web Crypto para rodar tanto no middleware
 * (runtime Edge) quanto no servidor Node — por isso não importa nada de "node:*".
 */

export const SESSION_COOKIE = "ni_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface Session {
  userId: string;
  username: string;
  /** User.sessionVersion na emissão; se mudou (senha trocada, usuário desativado), a sessão não vale mais. */
  sv?: number;
  /** Expiração em epoch segundos. */
  exp: number;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

let keyPromise: Promise<CryptoKey> | null = null;

function signingKey(): Promise<CryptoKey> {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET ausente ou curto demais no .env (mínimo 32 caracteres).");
  }
  keyPromise ??= crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
  return keyPromise;
}

export async function createSessionToken(userId: string, username: string, sessionVersion: number): Promise<string> {
  const session: Session = { userId, username, sv: sessionVersion, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const payload = base64url(encoder.encode(JSON.stringify(session)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}

/** Valida assinatura e expiração; devolve null para qualquer token inválido. */
export async function verifySessionToken(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  try {
    // crypto.subtle.verify compara em tempo constante.
    const valid = await crypto.subtle.verify("HMAC", await signingKey(), fromBase64url(signature), encoder.encode(payload));
    if (!valid) return null;
    const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Session;
    if (typeof session.exp !== "number" || session.exp < Date.now() / 1000) return null;
    return session;
  } catch {
    return null;
  }
}

/** A sessão vale para este usuário? Removido, desativado ou com senha trocada depois do login = não. */
export function sessionMatchesUser(session: Session, user: { active: boolean; sessionVersion: number } | null): boolean {
  return !!user && user.active && user.sessionVersion === (session.sv ?? 0);
}
