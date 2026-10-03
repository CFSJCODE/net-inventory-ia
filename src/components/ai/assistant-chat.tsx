"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, SendHorizontal, Trash2 } from "lucide-react";
import { aiAsk } from "@/app/actions/ai-actions";
import type { ChatMessage } from "@/lib/ai/features";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AiUnavailable, SimpleMarkdown, useAiAccess } from "./ai-common";

const SUGGESTIONS = [
  "O que entrou na rede nas últimas 24 horas?",
  "Alguma ligação monitorada caiu esta semana? Por quê?",
  "Quais dispositivos têm portas arriscadas?",
  "Quais dispositivos estão offline agora?",
];

/** Chat com a IA sobre a rede. A conversa fica só no navegador (não é salva). */
export function AssistantChat() {
  const { blocked } = useAiAccess();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || pending) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: question }];
    setMessages(next);
    setDraft("");
    setError(null);
    setPending(true);
    const result = await aiAsk(next);
    setPending(false);
    if (!result.ok) return setError(result.error);
    setMessages([...next, { role: "assistant", content: result.data }]);
  }

  if (blocked) {
    return (
      <Card>
        <CardContent>
          <AiUnavailable reason={blocked} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="flex min-h-[60vh] flex-col">
      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
          {!messages.length && (
            <div className="flex flex-col gap-3 py-6">
              <p className="text-sm text-muted-foreground">
                Pergunte sobre a sua rede. O assistente consulta o inventário, o histórico, as ligações e os achados de segurança — só
                leitura. IPs, MACs e nomes são mascarados antes de ir para a OpenAI.
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <Button key={s} variant="outline" size="sm" onClick={() => send(s)}>
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl px-4 py-2.5",
                  m.role === "user" ? "bg-primary text-primary-foreground" : "border bg-card",
                )}
              >
                {m.role === "user" ? <p className="whitespace-pre-wrap text-sm">{m.content}</p> : <SimpleMarkdown text={m.content} />}
              </div>
            </div>
          ))}
          {pending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Consultando a rede…
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div ref={endRef} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
          className="flex items-center gap-2"
        >
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Pergunte algo sobre a rede…" disabled={pending} maxLength={4000} />
          <Button type="submit" size="icon" disabled={pending || !draft.trim()} aria-label="Enviar">
            <SendHorizontal className="h-4 w-4" />
          </Button>
          {!!messages.length && (
            <Button type="button" variant="ghost" size="icon" onClick={() => setMessages([])} disabled={pending} aria-label="Limpar conversa">
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
