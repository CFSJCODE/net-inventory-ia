"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { getAiStatus } from "@/app/actions/ai-actions";
import { useCan } from "@/components/auth/user-provider";

export function useAiStatus() {
  return useQuery({ queryKey: ["ai-status"], queryFn: () => getAiStatus(), staleTime: 5 * 60_000 });
}

export type AiBlockedReason = "role" | "key";

/**
 * A IA está pronta para este usuário? Precisa da chave cadastrada E de um perfil com "ai.use".
 * blocked diz o motivo quando não está (null enquanto o status carrega ou quando está tudo certo).
 */
export function useAiAccess() {
  const { data: ai } = useAiStatus();
  const allowed = useCan("ai.use");
  const blocked: AiBlockedReason | null = !allowed ? "role" : ai && !ai.configured ? "key" : null;
  return { ai, ready: allowed && !!ai?.configured, blocked };
}

/** Aviso no lugar de um recurso de IA indisponível, com o motivo certo. */
export function AiUnavailable({ reason, compact = false }: { reason: AiBlockedReason; compact?: boolean }) {
  if (reason === "key") return <AiNotConfigured compact={compact} />;
  return <p className="text-xs text-muted-foreground">Seu perfil de acesso não inclui os recursos de IA.</p>;
}

/** Aviso exibido no lugar dos recursos de IA quando não há chave da OpenAI configurada. */
export function AiNotConfigured({ compact = false }: { compact?: boolean }) {
  // Só o administrador cadastra a chave; para os outros, o caminho é pedir a ele.
  const canConfigure = useCan("settings.manage");
  if (!canConfigure) {
    return (
      <p className="text-xs text-muted-foreground">
        {compact ? "IA desativada." : "Recursos de IA desativados."} Peça a um administrador para cadastrar a chave da OpenAI.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {compact ? "IA desativada." : "Recursos de IA desativados."} Cadastre a chave da OpenAI em{" "}
      <Link href="/settings" className="underline underline-offset-2">
        Configurações
      </Link>
      .
    </p>
  );
}

/** Negrito (**texto**) e código (`texto`) dentro de uma linha. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-muted px-1 font-mono text-xs">{part.slice(1, -1)}</code>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/**
 * Markdown mínimo para respostas da IA (títulos, listas, negrito, código). Monta elementos React —
 * nunca injeta HTML —, então um texto malicioso vindo do modelo não vira script na página.
 */
export function SimpleMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`ul-${blocks.length}`} className="ml-4 list-disc space-y-1">{list}</ul>);
    list = [];
  };

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) return list.push(<li key={i}>{inline(bullet[1])}</li>);
    flush();
    if (!line) return;
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    blocks.push(
      heading ? (
        <p key={i} className="font-semibold">
          {inline(heading[1])}
        </p>
      ) : (
        <p key={i}>{inline(line)}</p>
      ),
    );
  });
  flush();
  return <div className="flex flex-col gap-2 text-sm leading-relaxed">{blocks}</div>;
}
