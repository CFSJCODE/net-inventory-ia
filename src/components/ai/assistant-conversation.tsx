"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { ChatMessage } from "@/lib/ai/features";

function useConversationState() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return { messages, setMessages, draft, setDraft, pending, setPending, error, setError };
}

const ConversationContext = createContext<ReturnType<typeof useConversationState> | null>(null);

/** Mantém a conversa entre submenus, somente na memória desta página do navegador. */
export function AssistantConversationProvider({ children }: { children: ReactNode }) {
  const state = useConversationState();
  return <ConversationContext.Provider value={state}>{children}</ConversationContext.Provider>;
}

export function useAssistantConversation() {
  const state = useContext(ConversationContext);
  if (!state) throw new Error("Conversa fora do painel do Assistente.");
  return state;
}
