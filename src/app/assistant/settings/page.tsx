import { AiSettingsCard } from "@/components/ai/ai-settings-card";
import { requireSession } from "@/lib/auth/server";
import { can } from "@/lib/auth/permissions";

export default async function AssistantSettingsPage() {
  const user = await requireSession();
  if (!can(user.role, "settings.manage")) {
    return <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">Somente administradores podem alterar o provedor, o modelo e a chave da IA. Peça a um administrador para configurar o acesso.</div>;
  }
  return <AiSettingsCard />;
}
