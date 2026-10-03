"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { deleteAiKey, saveAiSettings, type AiStatus } from "@/app/actions/ai-actions";
import { Field } from "@/components/tools/tool-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SparklesIcon } from "@/components/ui/sparkles";
import { useAiStatus } from "./ai-common";

export function AiSettingsCard() {
  const queryClient = useQueryClient();
  const { data: ai } = useAiStatus();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");

  useEffect(() => {
    if (ai) setModel(ai.model);
  }, [ai]);

  const onStatus = (status: AiStatus) => {
    queryClient.setQueryData(["ai-status"], status);
    setApiKey("");
  };

  const save = useMutation({
    mutationFn: () => saveAiSettings({ apiKey, model }),
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.error);
      onStatus(result.data);
      toast.success("Configuração da IA salva");
    },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteAiKey(),
    onSuccess: (status) => {
      onStatus(status);
      toast.success("Chave removida");
    },
    onError: (err) => toast.error(err.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SparklesIcon size={16} className="text-primary" />
          Inteligência artificial (OpenAI)
        </CardTitle>
        <CardDescription>
          Identificação de dispositivos, análise de segurança, resumo de eventos e assistente. IPs, MACs, hostnames e apelidos são
          mascarados antes do envio; as chamadas só acontecem quando você clica e as respostas ficam em cache por 24 h.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {!ai ? (
          <p className="text-muted-foreground">Verificando…</p>
        ) : ai.configured ? (
          <p>
            <span className="text-primary">● Ativa</span> — chave terminada em <code className="font-mono">…{ai.keyHint}</code>, modelo{" "}
            <code className="font-mono">{ai.model}</code>.
          </p>
        ) : (
          <p className="text-muted-foreground">
            <span className="text-foreground">● Desativada.</span> Os recursos de IA ficam indisponíveis até você cadastrar uma chave da API da OpenAI (crie em{" "}
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              platform.openai.com/api-keys
            </a>
            ).
          </p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label={ai?.configured ? "Nova chave (deixe vazio para manter)" : "Chave da API"} htmlFor="ai-key" className="sm:flex-1">
            <Input
              id="ai-key"
              type="password"
              autoComplete="off"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Modelo" htmlFor="ai-model" className="sm:w-48">
            <Input id="ai-model" value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" />
          </Field>
          <Button type="submit" disabled={!ai || save.isPending || (!ai.configured && !apiKey.trim())} className="w-fit">
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {save.isPending ? "Testando…" : "Salvar"}
          </Button>
        </form>

        {ai?.configured && (
          <Button variant="outline" onClick={() => remove.mutate()} disabled={remove.isPending} className="w-fit">
            Remover chave
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          A chave é testada na OpenAI antes de salvar e fica criptografada no banco; ela nunca é enviada de volta ao navegador.
        </p>
      </CardContent>
    </Card>
  );
}
