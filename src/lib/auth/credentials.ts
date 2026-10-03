import { cookies } from "next/headers";
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "./session";

/*
 * Funções internas de autenticação. Ficam fora dos arquivos "use server" de propósito: lá, todo export
 * vira endpoint público — e startSession exposto permitiria criar a sessão de qualquer usuário.
 */

/** Emite o cookie de sessão do usuário (login, primeiro acesso e troca da própria senha). */
export async function startSession(user: { id: string; username: string; sessionVersion: number }) {
  const store = await cookies();
  store.set(SESSION_COOKIE, await createSessionToken(user.id, user.username, user.sessionVersion), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.AUTH_INSECURE_COOKIE !== "1",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function validateUsername(username: string): string | null {
  return /^[a-zA-Z0-9._-]{3,32}$/.test(username) ? null : "Usuário deve ter 3 a 32 caracteres (letras, números, . _ -).";
}

export function validatePassword(password: string): string | null {
  return password.length >= 8 ? null : "A senha deve ter pelo menos 8 caracteres.";
}
