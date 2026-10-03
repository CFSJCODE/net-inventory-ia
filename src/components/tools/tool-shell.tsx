"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { getToolDefaults, type ToolResult } from "@/app/actions/tool-actions";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** Executa uma ferramenta (server action) e expõe resultado/erro já desembrulhados do ToolResult. */
export function useTool<A extends unknown[], T>(action: (...args: A) => Promise<ToolResult<T>>) {
  const mutation = useMutation({
    mutationFn: async (args: A) => {
      const result = await action(...args);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  });
  return {
    run: (...args: A) => mutation.mutate(args),
    data: mutation.data,
    error: mutation.error?.message ?? null,
    isPending: mutation.isPending,
  };
}

export function ToolCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

export function ToolForm({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
    >
      {children}
    </form>
  );
}

export function Field({ label, htmlFor, className, children }: { label: string; htmlFor?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

export function RunButton({ isPending, label, pendingLabel }: { isPending: boolean; label: string; pendingLabel?: string }) {
  return (
    <Button type="submit" disabled={isPending} className="w-fit">
      {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {isPending ? pendingLabel ?? "Executando..." : label}
    </Button>
  );
}

export function ToolError({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>;
}

export function ToolSummary({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function ResultTable({
  columns,
  rows,
  mono = [],
  empty = "Nenhum resultado.",
}: {
  columns: string[];
  rows: ReactNode[][];
  /** Índices das colunas exibidas em fonte monoespaçada (IPs, MACs, OIDs). */
  mono?: number[];
  empty?: string;
}) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="max-h-[60vh] overflow-auto rounded-md border">
      <Table>
        <TableHeader className="sticky top-0 bg-background">
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c}>{c}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => (
                <TableCell key={j} className={cn("whitespace-normal break-all", mono.includes(j) && "font-mono text-xs")}>
                  {cell ?? "—"}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Valores padrão das ferramentas: faixa configurada, broadcast da faixa e gateway padrão do SO. */
export function useToolDefaults() {
  return useQuery({ queryKey: ["tool-defaults"], queryFn: () => getToolDefaults(), staleTime: 60_000 });
}

export function SimpleSelect<V extends string>({
  id,
  value,
  onChange,
  options,
  className,
}: {
  id?: string;
  value: V;
  onChange: (value: V) => void;
  options: Record<V, string>;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as V)} items={options}>
      <SelectTrigger id={id} className={cn("w-full sm:w-44", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(options) as V[]).map((key) => (
          <SelectItem key={key} value={key}>
            {options[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
