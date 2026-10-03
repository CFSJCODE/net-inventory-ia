"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { aiSummarizeEvents, getLatestSummary } from "@/app/actions/ai-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SparklesIcon } from "@/components/ui/sparkles";
import { formatRelativeTime } from "@/lib/format-time";
import { AiUnavailable, SimpleMarkdown, useAiAccess } from "./ai-common";

/** Resumo dos eventos em linguagem natural (IA), no topo do Histórico. */
export function AiSummaryCard() {
  const queryClient = useQueryClient();
  const { blocked } = useAiAccess();
  const { data: latest } = useQuery({ queryKey: ["ai-summary"], queryFn: () => getLatestSummary() });
  const summarize = useMutation({
    mutationFn: async (period: "24h" | "7d") => {
      const result = await aiSummarizeEvents(period);
      if (!result.ok) throw new Error(result.error);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai-summary"] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SparklesIcon size={16} className="text-primary" />
          Resumo com IA
        </CardTitle>
        <CardDescription>
          {latest
            ? `Resumo ${latest.period === "24h" ? "das últimas 24 horas" : "dos últimos 7 dias"}, gerado ${formatRelativeTime(latest.createdAt)}.`
            : "Um resumo em linguagem natural do que aconteceu na rede."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {latest && <SimpleMarkdown text={latest.text} />}
        {blocked ? (
          <AiUnavailable reason={blocked} />
        ) : (
          <div className="flex flex-wrap gap-2">
            {(["24h", "7d"] as const).map((period) => (
              <Button key={period} variant="outline" onClick={() => summarize.mutate(period)} disabled={summarize.isPending}>
                {summarize.isPending && summarize.variables === period ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <SparklesIcon size={14} className="text-primary" />
                )}
                Resumir {period === "24h" ? "últimas 24 h" : "últimos 7 dias"}
              </Button>
            ))}
          </div>
        )}
        {summarize.error && <p className="text-sm text-destructive">{summarize.error.message}</p>}
      </CardContent>
    </Card>
  );
}
