"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { deleteAiKey, saveAiSettings, type AiStatus } from "@/app/actions/ai-actions";
import { Field, SimpleSelect } from "@/components/tools/tool-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SparklesIcon } from "@/components/ui/sparkles";
import { PROVIDER_LIST, PROVIDERS, type AiProvider } from "@/lib/ai/providers";
import { useAiStatus } from "./ai-common";

const PROVIDER_OPTIONS = Object.fromEntries(PROVIDER_LIST.map((p) => [p.id, p.name])) as Record<AiProvider, string>;

export function AiSettingsCard() {
  const queryClient = useQueryClient();
  const { data: ai } = useAiStatus();
  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  useEffect(() => {
    if (ai) {
      setProvider(ai.provider);
      setModel(ai.model);
      setBaseUrl(ai.baseUrl);
    }
  }, [ai]);

  const def = PROVIDERS[provider] ?? PROVIDERS.gemini;
  const showBaseUrl = provider === "custom" || provider === "ollama";
  const keepsCurrentKey = Boolean(ai?.configured && ai.provider === provider);

  // Ao trocar de provedor, sugere o modelo e a URL padrão.
  function changeProvider(value: AiProvider) {
    const next = PROVIDERS[value] ?? PROVIDERS.gemini;
    setProvider(value);
    setModel(next.defaultModel);
    setBaseUrl(next.defaultBaseUrl);
    setApiKey("");
  }

  const onStatus = (status: AiStatus) => {
    queryClient.setQueryData(["ai-status"], status);
    setApiKey("");
  };

  const save = useMutation({
    mutationFn: () =>
      saveAiSettings({
        provider,
        apiKey: apiKey.trim() || undefined,
        model: model.trim(),
        baseUrl: baseUrl.trim() || undefined,
      }),
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.error);
      onStatus(result.data);
      toast.success("Configuração da IA salva");
    },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteAiKey(),
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.error);
      onStatus(result.data);
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
          Inteligência artificial
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
            <span className="text-primary">● Ativa</span> — {ai.providerName}
            {ai.keyHint && (
              <>
                , chave terminada em <code className="font-mono">…{ai.keyHint}</code>
              </>
            )}
            , modelo <code className="font-mono">{ai.model}</code>.
          </p>
        ) : (
          <p className="text-muted-foreground">
            <span className="text-foreground">● Desativada.</span> Os recursos de IA ficam indisponíveis até você escolher um provedor e
            cadastrar a chave
            {def.apiKeyHelpUrl && (
              <>
                {" "}
                (crie em{" "}
                <a href={def.apiKeyHelpUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  {def.apiKeyHelpUrl.replace(/^https?:\/\//, "")}
                </a>
                )
              </>
            )}
            .
          </p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Provedor" htmlFor="ai-provider" className="sm:w-48">
              <SimpleSelect id="ai-provider" value={provider} onChange={changeProvider} options={PROVIDER_OPTIONS} className="sm:w-48" />
            </Field>
            <Field
              label={
                !def.requiresApiKey ? "Chave da API (opcional)" : keepsCurrentKey ? "Nova chave (deixe vazio para manter)" : "Chave da API"
              }
              htmlFor="ai-key"
              className="sm:flex-1"
            >
              <Input
                id="ai-key"
                type="password"
                autoComplete="off"
                placeholder={def.apiKeyPlaceholder}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Modelo" htmlFor="ai-model" className="sm:w-48">
              <Input
                id="ai-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={def.defaultModel}
                className="font-mono"
              />
            </Field>
            <Button
              type="submit"
              disabled={!ai || save.isPending || !model.trim() || (def.requiresApiKey && !apiKey.trim() && !keepsCurrentKey)}
              className="w-fit"
            >
              {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {save.isPending ? "Testando…" : "Salvar"}
            </Button>
          </div>
          {showBaseUrl && (
            <Field label="URL base da API" htmlFor="ai-base-url">
              <Input
                id="ai-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={def.defaultBaseUrl || "https://..."}
                className="font-mono"
              />
            </Field>
          )}
        </form>

        {ai?.configured && (
          <Button variant="outline" onClick={() => remove.mutate()} disabled={remove.isPending} className="w-fit">
            Remover chave
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          A chave é testada no provedor antes de salvar e fica criptografada no banco; ela nunca é enviada de volta ao navegador.
        </p>
      </CardContent>
    </Card>
  );
}
