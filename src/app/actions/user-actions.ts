"use server";

import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { requirePermission, requireSession } from "@/lib/auth/server";
import { startSession, validatePassword, validateUsername } from "@/lib/auth/credentials";
import { ROLES, type UserRole } from "@/lib/auth/permissions";
import type { ToolResult } from "./tool-actions";

export interface UserRow {
  id: string;
  username: string;
  role: UserRole;
  active: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

// Erros de validação viram { ok: false, error } — exceções em server actions chegam ao navegador sem a
// mensagem em produção, e o administrador precisa saber o que corrigir.
async function run<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function assertRole(role: string): asserts role is UserRole {
  if (!ROLES.includes(role as UserRole)) throw new Error("Perfil inválido.");
}

const USER_FIELDS = { id: true, username: true, role: true, active: true, lastLoginAt: true, createdAt: true } as const;

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Toda alteração passa por aqui: a instalação nunca pode ficar sem um administrador ativo. */
async function assertAdminRemains(tx: Tx) {
  if ((await tx.user.count({ where: { role: "ADMIN", active: true } })) === 0) {
    throw new Error("É preciso manter pelo menos um administrador ativo.");
  }
}

export async function listUsers(): Promise<UserRow[]> {
  await requirePermission("users.manage");
  return prisma.user.findMany({ select: USER_FIELDS, orderBy: { username: "asc" } });
}

export async function createUser(input: { username: string; password: string; role: string }): Promise<ToolResult<UserRow>> {
  await requirePermission("users.manage");
  return run(async () => {
    const username = input.username.trim();
    const invalid = validateUsername(username) ?? validatePassword(input.password);
    if (invalid) throw new Error(invalid);
    assertRole(input.role);
    if (await prisma.user.findUnique({ where: { username } })) throw new Error(`O usuário "${username}" já existe.`);
    return prisma.user.create({
      data: { username, passwordHash: await hashPassword(input.password), role: input.role },
      select: USER_FIELDS,
    });
  });
}

/** Muda perfil e/ou ativa/desativa. Desativar derruba as sessões abertas do usuário. */
export async function updateUser(id: string, changes: { role?: string; active?: boolean }): Promise<ToolResult<UserRow>> {
  const me = await requirePermission("users.manage");
  return run(async () => {
    if (changes.role !== undefined) assertRole(changes.role);
    if (id === me.id && changes.active === false) throw new Error("Você não pode desativar o seu próprio usuário.");
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: {
          ...(changes.role !== undefined && { role: changes.role as UserRole }),
          ...(changes.active !== undefined && { active: changes.active }),
          ...(changes.active === false && { sessionVersion: { increment: 1 } }),
        },
        select: USER_FIELDS,
      });
      await assertAdminRemains(tx);
      return user;
    });
  });
}

/** Define uma nova senha para outro usuário (ex.: esqueceu a senha). Encerra as sessões dele. */
export async function resetUserPassword(id: string, password: string): Promise<ToolResult<null>> {
  await requirePermission("users.manage");
  return run(async () => {
    const invalid = validatePassword(password);
    if (invalid) throw new Error(invalid);
    await prisma.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(password), sessionVersion: { increment: 1 } },
    });
    return null;
  });
}

export async function deleteUser(id: string): Promise<ToolResult<null>> {
  const me = await requirePermission("users.manage");
  return run(async () => {
    if (id === me.id) throw new Error("Você não pode remover o seu próprio usuário.");
    await prisma.$transaction(async (tx) => {
      await tx.user.delete({ where: { id } });
      await assertAdminRemains(tx);
      await tx.appSetting.deleteMany({ where: { key: `ai.onboardingDismissed:${id}` } });
    });
    return null;
  });
}

/** Qualquer usuário troca a própria senha. As outras sessões dele caem; esta continua (cookie reemitido). */
export async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<ToolResult<null>> {
  const me = await requireSession();
  return run(async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new Error("A senha atual está incorreta.");
    const invalid = validatePassword(newPassword);
    if (invalid) throw new Error(invalid);
    if (currentPassword === newPassword) throw new Error("A nova senha precisa ser diferente da atual.");
    const updated = await prisma.user.update({
      where: { id: me.id },
      data: { passwordHash: await hashPassword(newPassword), sessionVersion: { increment: 1 } },
    });
    await startSession(updated);
    return null;
  });
}
