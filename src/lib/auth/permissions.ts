/**
 * Perfis de acesso e o que cada um pode fazer. Única fonte da verdade: o servidor usa para barrar
 * as ações (requirePermission) e a interface para esconder o que o usuário não pode usar (useCan).
 * Sem imports de servidor — é usado também no navegador.
 */

export type UserRole = "ADMIN" | "OPERATOR" | "VIEWER";

export type Permission =
  /** Criar, editar, desativar e remover usuários. */
  | "users.manage"
  /** Faixa e frequência do scan, chave da IA e limpeza do inventário. */
  | "settings.manage"
  /** Ações que tocam a rede: scan, ferramentas, Wake-on-LAN, testar ligações. */
  | "network.operate"
  /** Alterar o inventário: dispositivos, ligações monitoradas e posições no mapa. */
  | "inventory.edit"
  /** Recursos de IA (cada uso gasta a chave da OpenAI). */
  | "ai.use";

export const ROLES: UserRole[] = ["ADMIN", "OPERATOR", "VIEWER"];

export const ROLE_INFO: Record<UserRole, { label: string; description: string }> = {
  ADMIN: { label: "Administrador", description: "Acesso total, incluindo usuários e configurações." },
  OPERATOR: { label: "Operador", description: "Opera a rede: scans, ferramentas, edição do inventário e IA. Não altera configurações nem usuários." },
  VIEWER: { label: "Visualizador", description: "Somente consulta: inventário, mapa, ligações e histórico." },
};

const PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  ADMIN: ["users.manage", "settings.manage", "network.operate", "inventory.edit", "ai.use"],
  OPERATOR: ["network.operate", "inventory.edit", "ai.use"],
  VIEWER: [],
};

export function can(role: UserRole | null | undefined, permission: Permission): boolean {
  return !!role && PERMISSIONS[role].includes(permission);
}
