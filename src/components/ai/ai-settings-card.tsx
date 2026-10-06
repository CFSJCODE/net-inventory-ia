"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { deleteAiKey, saveAiSettings, type AiStatus } from "@/app/actions/ai-actions";
import { Field } from "@/components/tools/tool-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SparklesIcon } from "@/components/ui/sparkles";
import { PROVIDER_LIST, PROVIDERS, type AiProvider } from "@/lib/ai/providers";
import { useAiStatus } from "./ai-common";

export function AiSettingsCard() {
  const queryClient = useQueryClient();
  const { data: ai } = useAiStatus();

  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showAdvancedUrl, setShowAdvancedUrl] = useState(false);

  useEffect(() => {
    if (ai) {
      setProvider(ai.provider);
      setModel(ai.model);
      setBaseUrl(ai.baseUrl);
      if (ai.provider === "custom" || ai.provider === "ollama") {
        setShowAdvancedUrl(true);
      }
    }
  }, [ai]);

  const activeProviderDef = PROVIDERS[provider] ?? PROVIDERS.gemini;

  // Ao trocar de provedor, sugere o modelo e a URL padrão
  function handleProviderChange(newProvider: AiProvider) {
    setProvider(newProvider);
    const def = PROVIDERS[newProvider] ?? PROVIDERS.gemini;
    setModel(def.defaultModel);
    setBaseUrl(def.defaultBaseUrl);
    setApiKey("");
    if (newProvider === "custom" || newProvider === "ollama") {
      setShowAdvancedUrl(true);
    }
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
      if (!result.ok) {
        return toast.error(result.error);
      }
      onStatus(result.data);
      toast.success("Configuração de IA salva e conexão validada!");
    },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteAiKey(),
    onSuccess: (result) => {
      if (!result.ok) {
        return toast.error(result.error);
      }
      onStatus(result.data);
      toast.success("Chave removida e IA desativada");
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
          Inteligência Artificial (Multi-Provedor)
        </CardTitle>
        <CardDescription>
          Identificação de dispositivos, análise de segurança, resumo de eventos e assistente. Conecte com{" "}
          <strong>Google Gemini</strong> (camada gratuita no Google AI Studio, como no MistakeMap),{" "}
          <strong>OpenRouter</strong> (modelos gratuitos :free), <strong>Groq</strong>,{" "}
          <strong>Ollama</strong> (100% local/offline) ou <strong>OpenAI</strong>.
          IPs, MACs, hostnames e apelidos são estritamente mascarados antes do envio.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 text-sm">
        {/* Status atual */}
        <div className="rounded-lg border bg-muted/30 p-3.5">
          {!ai ? (
            <p className="text-muted-foreground">Verificando status da IA…</p>
          ) : ai.configured ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 font-medium">
                <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-emerald-700 dark:text-emerald-400">Ativa e conectada</span>
                <Badge variant="outline" className="text-[11px] font-normal">
                  {ai.providerName}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Modelo: <code className="font-mono text-foreground">{ai.model}</code>
                {ai.keyHint && (
                  <>
                    {" "}
                    • Chave: <code className="font-mono text-foreground">…{ai.keyHint}</code>
                  </>
                )}
                {ai.provider === "ollama" && " • Execução local sem envio à nuvem"}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 font-medium">
                <span className="flex h-2 w-2 rounded-full bg-muted-foreground" />
                <span className="text-foreground">Desativada</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Escolha um provedor abaixo e cadastre sua chave (ou use modelos gratuitos como o Google Gemini do AI Studio)
                para ativar os recursos inteligentes.
              </p>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Seletor de provedor */}
          <div className="flex flex-col gap-1.5">
            <Field label="Provedor de IA" htmlFor="ai-provider">
              <Select
                value={provider}
                onValueChange={(val) => handleProviderChange(val as AiProvider)}
                items={Object.fromEntries(PROVIDER_LIST.map((p) => [p.id, p.name]))}
              >
                <SelectTrigger id="ai-provider" className="w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_LIST.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <div className="flex items-center justify-between gap-3 w-full">
                        <span>{p.name}</span>
                        {p.badge && (
                          <span className="text-[10px] text-muted-foreground rounded bg-muted px-1.5 py-0.5">
                            {p.badge}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {/* Descrição e link do provedor ativo */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground pt-1">
              <span>{activeProviderDef.description}</span>
              {activeProviderDef.apiKeyHelpUrl && (
                <a
                  href={activeProviderDef.apiKeyHelpUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:opacity-80"
                >
                  {activeProviderDef.badge ? `Obter chave (${activeProviderDef.badge})` : "Obter chave da API"}
                  <ExternalLink size={12} />
                </a>
              )}
            </div>
          </div>

          {/* Modelos rápidos recomendados */}
          {activeProviderDef.models.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Modelos populares recomendados:</span>
              <div className="flex flex-wrap gap-1.5">
                {activeProviderDef.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModel(m.id)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                      model === m.id
                        ? "border-primary bg-primary/10 font-semibold text-primary"
                        : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <span>{m.name}</span>
                    {m.badge && (
                      <span
                        className={`text-[10px] rounded px-1 py-px ${
                          m.free ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium" : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {m.badge}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* Campo Modelo */}
            <Field label="Identificador do Modelo" htmlFor="ai-model">
              <Input
                id="ai-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={activeProviderDef.defaultModel}
                className="font-mono text-sm"
                required
              />
            </Field>

            {/* Campo Chave de API */}
            <Field
              label={
                activeProviderDef.requiresApiKey
                  ? ai?.configured && ai.provider === provider
                    ? "Chave da API (deixe em branco para manter a atual)"
                    : "Chave da API"
                  : "Chave da API (opcional)"
              }
              htmlFor="ai-key"
            >
              <Input
                id="ai-key"
                type="password"
                autoComplete="off"
                placeholder={activeProviderDef.apiKeyPlaceholder}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="font-mono text-sm"
              />
            </Field>
          </div>

          {/* URL Base customizada (para Ollama, Custom ou proxies) */}
          {(showAdvancedUrl || provider === "custom" || provider === "ollama") && (
            <Field label="URL Base da API (Endpoint)" htmlFor="ai-base-url">
              <Input
                id="ai-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={activeProviderDef.defaultBaseUrl || "https://..."}
                className="font-mono text-sm"
              />
            </Field>
          )}

          {!showAdvancedUrl && provider !== "custom" && provider !== "ollama" && (
            <button
              type="button"
              onClick={() => setShowAdvancedUrl(true)}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground self-start"
            >
              Personalizar URL base do endpoint
            </button>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button
              type="submit"
              disabled={
                save.isPending ||
                !model.trim() ||
                (activeProviderDef.requiresApiKey && !apiKey.trim() && !(ai?.configured && ai.provider === provider))
              }
            >
              {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {save.isPending ? "Testando conexão…" : "Salvar e testar conexão"}
            </Button>

            {ai?.configured && (
              <Button
                variant="outline"
                type="button"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                {remove.isPending ? "Removendo…" : "Desativar IA"}
              </Button>
            )}
          </div>
        </form>

        <p className="text-xs leading-relaxed text-muted-foreground border-t pt-3">
          A conexão é testada com uma consulta leve antes de salvar. A chave de API é criptografada com AES-256-GCM no servidor e
          nunca é exposta ao navegador.
        </p>
      </CardContent>
    </Card>
  );
}
