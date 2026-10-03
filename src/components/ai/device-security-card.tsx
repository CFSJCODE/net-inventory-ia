"use client";

import { useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { aiExplainDeviceSecurity } from "@/app/actions/ai-actions";
import type { SecurityFinding, Severity } from "@/lib/security-rules";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SparklesIcon } from "@/components/ui/sparkles";
import { cn } from "@/lib/utils";
import { AiUnavailable, SimpleMarkdown, useAiAccess } from "./ai-common";

export const SEVERITY_STYLE: Record<Severity, string> = {
  alta: "border-red-900 bg-red-950 text-red-400",
  média: "border-amber-900 bg-amber-950 text-amber-400",
  baixa: "border-zinc-700 bg-zinc-900 text-zinc-400",
};

export function FindingsList({ findings }: { findings: SecurityFinding[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {findings.map((f) => (
        <li key={f.port} className="flex flex-col gap-1 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={cn("font-normal", SEVERITY_STYLE[f.severity])}>
              {f.severity}
            </Badge>
            <span className="font-mono text-xs">{f.port}/tcp</span>
            <span className="text-sm font-medium">{f.service}</span>
          </div>
          <p className="text-sm">{f.risk}</p>
          <p className="text-sm text-muted-foreground">→ {f.recommendation}</p>
        </li>
      ))}
    </ul>
  );
}

export function DeviceSecurityCard({ deviceId, findings: localFindings }: { deviceId: string; findings: SecurityFinding[] }) {
  const { ready, blocked } = useAiAccess();
  const [findings, setFindings] = useState(localFindings);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function explain() {
    setLoading(true);
    setError(null);
    const result = await aiExplainDeviceSecurity(deviceId);
    setLoading(false);
    if (!result.ok) return setError(result.error);
    setFindings(result.data.findings);
    setSummary(result.data.aiSummary);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {findings.length ? <ShieldAlert className="h-4 w-4 text-amber-500" /> : <ShieldCheck className="h-4 w-4 text-primary" />}
          Segurança
        </CardTitle>
        <CardDescription>Portas abertas conhecidas por oferecer risco, com base no último scan.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!findings.length ? (
          <p className="text-sm text-muted-foreground">Nenhuma porta de risco conhecida entre as portas abertas detectadas.</p>
        ) : (
          <>
            {summary && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                <SimpleMarkdown text={summary} />
              </div>
            )}
            <FindingsList findings={findings} />
            {blocked && <AiUnavailable reason={blocked} compact />}
            {ready && !summary && (
              <Button variant="outline" onClick={explain} disabled={loading} className="w-fit">
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SparklesIcon size={14} className="text-primary" />}
                {loading ? "Analisando…" : "Explicar com IA"}
              </Button>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
