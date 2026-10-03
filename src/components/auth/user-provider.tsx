"use client";

import { createContext, useContext, type ReactNode } from "react";
import { can, type Permission, type UserRole } from "@/lib/auth/permissions";

export interface SessionUser {
  id: string;
  username: string;
  role: UserRole;
}

const UserContext = createContext<SessionUser | null>(null);

/** Disponibiliza o usuário logado (vindo do layout, já conferido no banco) para os componentes. */
export function UserProvider({ user, children }: { user: SessionUser; children: ReactNode }) {
  return <UserContext.Provider value={user}>{children}</UserContext.Provider>;
}

export function useCurrentUser(): SessionUser | null {
  return useContext(UserContext);
}

/**
 * O usuário pode fazer isto? Serve só para esconder ou desabilitar controles na interface: quem
 * barra de verdade é o servidor (requirePermission em cada action).
 */
export function useCan(permission: Permission): boolean {
  return can(useContext(UserContext)?.role, permission);
}
