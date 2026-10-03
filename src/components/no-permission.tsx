import { ShieldAlert } from "lucide-react";
import type { UserRole } from "@/lib/auth/permissions";
import { ROLE_INFO } from "@/lib/auth/permissions";

/** Mostrado no lugar de uma página ou seção que o perfil do usuário não pode acessar. */
export function NoPermission({ role, what }: { role: UserRole; what: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-5 text-sm">
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
      <div className="flex flex-col gap-1">
        <p className="font-medium">Sem permissão para {what}</p>
        <p className="text-muted-foreground">
          Seu perfil é <strong className="text-foreground">{ROLE_INFO[role].label}</strong>. Peça a um administrador se precisar deste acesso.
        </p>
      </div>
    </div>
  );
}
