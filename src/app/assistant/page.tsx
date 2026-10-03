import { AssistantChat } from "@/components/ai/assistant-chat";

export default function AssistantPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-3 py-8">
      <div>
        <p className="text-sm text-muted-foreground">
          Converse sobre a sua rede em português. As respostas usam os dados reais do inventário.
        </p>
      </div>
      <AssistantChat />
    </div>
  );
}
