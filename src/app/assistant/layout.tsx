import { requireSession } from "@/lib/auth/server";
import { can } from "@/lib/auth/permissions";
import { AssistantNavigation } from "@/components/ai/assistant-navigation";
import { AssistantConversationProvider } from "@/components/ai/assistant-conversation";

export default async function AssistantLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  if (!can(user.role, "ai.use")) {
    return <p className="m-6 rounded-xl border bg-card p-6 text-sm text-muted-foreground">Seu perfil de acesso não inclui os recursos de IA.</p>;
  }
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Assistente IA</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">Configure sua IA, acompanhe o consumo e converse sobre a sua rede.</p>
      </div>
      <AssistantNavigation />
      <AssistantConversationProvider>{children}</AssistantConversationProvider>
    </div>
  );
}
