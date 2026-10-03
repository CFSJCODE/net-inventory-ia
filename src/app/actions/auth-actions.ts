"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { startSession, validatePassword, validateUsername } from "@/lib/auth/credentials";

export interface AuthFormState {
  error?: string;
}

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;
const attempts = (globalThis as typeof globalThis & { __loginAttempts?: Map<string, number[]> }).__loginAttempts ??= new Map<string, number[]>();

async function clientKey(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || "local";
}

/** Limite de tentativas por IP: no máximo 5 falhas por minuto (dificulta força bruta). */
function isRateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, recent);
  return recent.length >= MAX_ATTEMPTS;
}

function recordFailure(key: string) {
  attempts.set(key, [...(attempts.get(key) ?? []), Date.now()]);
}

/** Só aceita caminhos internos (evita redirecionar para outro site via ?next=//malicioso.com). */
function safeNext(next: FormDataEntryValue | null): string {
  const value = typeof next === "string" ? next : "";
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/login") ? value : "/";
}

function validateCredentials(username: string, password: string): string | null {
  return validateUsername(username) ?? validatePassword(password);
}

export async function hasAnyUser(): Promise<boolean> {
  return (await prisma.user.count()) > 0;
}

/** Primeiro acesso: cria o administrador. Recusa se já existir algum usuário. */
export async function setupAdmin(_prev: AuthFormState, form: FormData): Promise<AuthFormState> {
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) return { error: "As senhas não conferem." };
  const invalid = validateCredentials(username, password);
  if (invalid) return { error: invalid };

  // A checagem fica dentro da transação para dois cadastros simultâneos não criarem dois admins.
  const user = await prisma.$transaction(async (tx) => {
    if ((await tx.user.count()) > 0) return null;
    return tx.user.create({ data: { username, passwordHash: await hashPassword(password), role: "ADMIN", lastLoginAt: new Date() } });
  });
  if (!user) return { error: "O administrador já foi criado. Faça login." };

  await startSession(user);
  redirect(safeNext(form.get("next")));
}

export async function login(_prev: AuthFormState, form: FormData): Promise<AuthFormState> {
  const key = await clientKey();
  if (isRateLimited(key)) return { error: "Muitas tentativas. Aguarde um minuto e tente novamente." };

  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const user = await prisma.user.findUnique({ where: { username } });
  // Mesma mensagem para usuário inexistente e senha errada (não revela quais usuários existem).
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    recordFailure(key);
    return { error: "Usuário ou senha inválidos." };
  }
  // Só depois da senha certa: não revela a quem não sabe a senha que o usuário existe.
  if (!user.active) return { error: "Este usuário está desativado. Fale com o administrador." };

  attempts.delete(key);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await startSession(user);
  redirect(safeNext(form.get("next")));
}

export async function logout(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
