import { AssistantChat } from "@/components/ai/assistant-chat";

export default function AssistantPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Chat sobre a rede</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Converse sobre a sua rede em português. As respostas usam os dados reais do inventário.
        </p>
      </div>
      <AssistantChat />
    </div>
  );
}
