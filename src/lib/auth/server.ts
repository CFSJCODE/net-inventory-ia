import { cache } from "react";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { can, type Permission, type UserRole } from "./permissions";
import { SESSION_COOKIE, sessionMatchesUser, verifySessionToken, type Session } from "./session";

export interface CurrentUser {
  id: string;
  username: string;
  role: UserRole;
}

/** Só o cookie (assinatura e validade). Para saber se o usuário ainda pode entrar, use getCurrentUser. */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/**
 * Usuário logado, conferido no banco a cada requisição: o middleware (Edge) só valida o cookie, então
 * é aqui que um usuário desativado, removido ou com o perfil alterado tem o efeito imediato.
 * cache(): uma consulta por requisição, mesmo chamado por layout, página e actions.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await getSession();
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || !sessionMatchesUser(session, user)) return null;
  return { id: user.id, username: user.username, role: user.role };
});

/**
 * Garante usuário válido dentro de uma server action ou rota. O middleware já bloqueia requisições sem
 * cookie, mas server actions são endpoints públicos por natureza — a checagem aqui é a segunda camada.
 */
export async function requireSession(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Sessão expirada. Faça login novamente.");
  return user;
}

export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireSession();
  if (!can(user.role, permission)) throw new Error("Seu perfil de acesso não permite esta ação.");
  return user;
}
