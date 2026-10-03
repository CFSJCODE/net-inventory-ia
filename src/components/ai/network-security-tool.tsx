"use client";

import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { aiExplainNetworkSecurity, getNetworkFindings } from "@/app/actions/ai-actions";
import { displayName } from "@/lib/device-name";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SparklesIcon } from "@/components/ui/sparkles";
import { ToolCard, ToolSummary } from "@/components/tools/tool-shell";
import { cn } from "@/lib/utils";
import { AiUnavailable, SimpleMarkdown, useAiAccess } from "./ai-common";
import { SEVERITY_STYLE } from "./device-security-card";

/** Aba "Segurança" em Ferramentas: achados locais da rede inteira + diagnóstico opcional com IA. */
export function NetworkSecurityTool() {
  const { ready, blocked } = useAiAccess();
  const { data, isLoading } = useQuery({ queryKey: ["network-findings"], queryFn: () => getNetworkFindings() });
  const diagnose = useMutation({
    mutationFn: async () => {
      const result = await aiExplainNetworkSecurity();
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  });

  const total = data?.reduce((sum, d) => sum + d.findings.length, 0) ?? 0;
  const high = data?.reduce((sum, d) => sum + d.findings.filter((f) => f.severity === "alta").length, 0) ?? 0;

  return (
    <ToolCard
      title="Segurança da rede"
      description="Portas abertas de risco em todos os dispositivos, a partir do último scan (Telnet, SMB, RDP, VNC, ADB, Docker, bancos sem senha...)."
    >
      {isLoading && <ToolSummary>Carregando…</ToolSummary>}
      {data && (
        <ToolSummary>
          {total ? `${total} achado(s) em ${data.length} dispositivo(s), ${high} de severidade alta.` : "Nenhuma porta de risco conhecida encontrada."}
        </ToolSummary>
      )}
      {!!data?.length && (
        <ul className="flex flex-col gap-2">
          {data.map((d) => (
            <li key={d.deviceId} className="flex flex-col gap-1.5 rounded-md border p-3 sm:flex-row sm:items-center sm:gap-3">
              <Link href={`/devices/${d.deviceId}`} className="min-w-48 text-sm font-medium hover:underline">
                {displayName(d.device)} <span className="font-mono text-xs text-muted-foreground">{d.device.ip}</span>
              </Link>
              <span className="flex flex-wrap gap-1.5">
                {d.findings.map((f) => (
                  <Badge key={f.port} variant="outline" className={cn("font-normal", SEVERITY_STYLE[f.severity])} title={f.risk}>
                    {f.service} ({f.port})
                  </Badge>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {blocked && <AiUnavailable reason={blocked} />}
      {ready && !!total && !diagnose.data && (
        <Button variant="outline" onClick={() => diagnose.mutate()} disabled={diagnose.isPending} className="w-fit">
          {diagnose.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SparklesIcon size={14} className="text-primary" />}
          {diagnose.isPending ? "Analisando a rede…" : "Diagnóstico com IA"}
        </Button>
      )}
      {diagnose.error && <p className="text-sm text-destructive">{diagnose.error.message}</p>}
      {diagnose.data && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
          <SimpleMarkdown text={diagnose.data} />
        </div>
      )}
    </ToolCard>
  );
}
