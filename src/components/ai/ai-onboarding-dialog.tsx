"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { dismissAiKeyOnboarding, saveAiSettings } from "@/app/actions/ai-actions";
import type { AnimatedIcon, AnimatedIconHandle } from "@/components/page-title";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EarthIcon } from "@/components/ui/earth";
import { LockKeyholeIcon } from "@/components/ui/lock-keyhole";
import { ShieldCheckIcon } from "@/components/ui/shield-check";
import { SparklesIcon } from "@/components/ui/sparkles";
import { Field, SimpleSelect } from "@/components/tools/tool-shell";
import { PROVIDERS, PROVIDER_LIST, type AiProvider } from "@/lib/ai/providers";
import { useAiStatus } from "./ai-common";

const PROVIDER_OPTIONS = Object.fromEntries(PROVIDER_LIST.map((p) => [p.id, p.name])) as Record<AiProvider, string>;

const STEP_DELAY_MS = 450;

const link = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-2">
    {text}
  </a>
);

function getProviderSteps(provider: AiProvider): { icon: AnimatedIcon; title: string; body: ReactNode }[] {
  if (provider === "gemini") {
    return [
      {
        icon: EarthIcon,
        title: "Acesse o Google AI Studio (100% gratuito)",
        body: (
          <>
            Acesse {link("https://aistudio.google.com/apikey", "aistudio.google.com/apikey")} com sua conta Google. Não é necessário
            cartão de crédito para a camada gratuita do Gemini.
          </>
        ),
      },
      {
        icon: LockKeyholeIcon,
        title: "Gere sua chave de API",
        body: (
          <>
            Clique em <strong>Create API key</strong>, copie a chave (começa com <code className="font-mono">AIzaSy...</code>) e cole abaixo.
          </>
        ),
      },
      {
        icon: ShieldCheckIcon,
        title: "Cole a chave aqui",
        body: "A chave é validada e criptografada no seu servidor. O NetInventory usará o modelo rápido e gratuito Gemini 2.5 Flash.",
      },
    ];
  }

  if (provider === "openrouter") {
    return [
      {
        icon: EarthIcon,
        title: "Acesse o OpenRouter",
        body: (
          <>
            Crie uma conta gratuita em {link("https://openrouter.ai/keys", "openrouter.ai/keys")} para ter acesso a modelos de ponta e modelos
            gratuitos com sufixo <code className="font-mono">:free</code>.
          </>
        ),
      },
      {
        icon: LockKeyholeIcon,
        title: "Crie uma chave",
        body: (
          <>
            Clique em <strong>Create Key</strong> e copie a chave gerada (começa com <code className="font-mono">sk-or-...</code>).
          </>
        ),
      },
      {
        icon: ShieldCheckIcon,
        title: "Pronto para usar",
        body: "Cole a chave para ativar a integração com modelos livres.",
      },
    ];
  }

  if (provider === "ollama") {
    return [
      {
        icon: EarthIcon,
        title: "Instale o Ollama no computador",
        body: (
          <>
            Baixe e execute o Ollama em {link("https://ollama.ai", "ollama.ai")}. Ele roda localmente e não envia dados para a internet.
          </>
        ),
      },
      {
        icon: LockKeyholeIcon,
        title: "Baixe um modelo",
        body: (
          <>
            No terminal, rode <code className="font-mono text-xs">ollama run llama3.2</code> ou <code className="font-mono text-xs">ollama run qwen2.5</code>.
          </>
        ),
      },
      {
        icon: ShieldCheckIcon,
        title: "Conectar localmente",
        body: "Não requer chave de API! Basta clicar em Salvar para usar o Ollama local em http://localhost:11434.",
      },
    ];
  }

  // Padrão OpenAI
  return [
    {
      icon: EarthIcon,
      title: "Entre na plataforma da OpenAI",
      body: (
        <>
          Acesse {link("https://platform.openai.com", "platform.openai.com")} e faça login (ou crie uma conta). A API é cobrada à parte do
          ChatGPT Plus.
        </>
      ),
    },
    {
      icon: LockKeyholeIcon,
      title: "Crie uma chave secreta",
      body: (
        <>
          Em {link("https://platform.openai.com/api-keys", "API keys")}, clique em <strong>Create new secret key</strong> e copie a chave (<code className="font-mono">sk-...</code>).
        </>
      ),
    },
    {
      icon: ShieldCheckIcon,
      title: "Cole a chave aqui",
      body: "Ela é testada antes de salvar e fica criptografada no servidor.",
    },
  ];
}

/**
 * Aviso de boas-vindas para configurar IA: aparece enquanto não houver IA configurada
 * e o usuário não o dispensar. Permite escolher o provedor (Google Gemini grátis, OpenRouter, etc.).
 */
export function AiOnboardingDialog() {
  const queryClient = useQueryClient();
  const { data: ai } = useAiStatus();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [apiKey, setApiKey] = useState("");
  const sparklesRef = useRef<AnimatedIconHandle>(null);
  const stepRefs = useRef<(AnimatedIconHandle | null)[]>([]);

  useEffect(() => {
    if (ai?.onboardingPending) setOpen(true);
  }, [ai?.onboardingPending]);

  const steps = useMemo(() => getProviderSteps(provider), [provider]);
  const providerDef = PROVIDERS[provider] ?? PROVIDERS.gemini;

  // Ao abrir ou trocar de provedor, anima o título e depois cada passo em sequência
  useEffect(() => {
    if (!open) return;
    const timers = [setTimeout(() => sparklesRef.current?.startAnimation(), 150)];
    steps.forEach((_, i) => timers.push(setTimeout(() => stepRefs.current[i]?.startAnimation(), 600 + i * STEP_DELAY_MS)));
    return () => timers.forEach(clearTimeout);
  }, [open, steps]);

  function close() {
    setOpen(false);
    if (ai?.onboardingPending) dismissAiKeyOnboarding().then((status) => queryClient.setQueryData(["ai-status"], status));
  }

  const save = useMutation({
    mutationFn: () =>
      saveAiSettings({
        provider,
        apiKey: apiKey.trim() || undefined,
        model: providerDef.defaultModel,
        baseUrl: providerDef.defaultBaseUrl,
      }),
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.error);
      queryClient.setQueryData(["ai-status"], result.data);
      toast.success("IA configurada e ativada com sucesso!");
      setOpen(false);
    },
    onError: (err) => toast.error(err.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon
              ref={sparklesRef}
              size={18}
              className="text-primary"
              onMouseEnter={() => sparklesRef.current?.startAnimation()}
              onMouseLeave={() => sparklesRef.current?.stopAnimation()}
            />
            Ative os recursos de IA
          </DialogTitle>
          <DialogDescription>
            O NetInventory usa IA para identificar dispositivos, analisar a segurança da rede, resumir eventos e responder no Assistente.
            Para isso, escolha um provedor e cadastre a sua chave da API — leva cerca de 2 minutos.
          </DialogDescription>
        </DialogHeader>

        <Field label="Provedor" htmlFor="ai-onboarding-provider">
          <SimpleSelect
            id="ai-onboarding-provider"
            value={provider}
            onChange={(v) => {
              setProvider(v);
              setApiKey("");
            }}
            options={PROVIDER_OPTIONS}
            className="sm:w-full"
          />
        </Field>

        <ol className="flex flex-col gap-3">
          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <li
                key={step.title}
                className="flex gap-3 rounded-lg border p-3"
                onMouseEnter={() => stepRefs.current[i]?.startAnimation()}
                onMouseLeave={() => stepRefs.current[i]?.stopAnimation()}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Icon
                    ref={(handle) => {
                      stepRefs.current[i] = handle;
                    }}
                    size={16}
                  />
                </span>
                <div className="flex flex-col gap-0.5">
                  <p className="font-medium">
                    {i + 1}. {step.title}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">{step.body}</p>
                </div>
              </li>
            );
          })}
        </ol>

        {providerDef.requiresApiKey && (
          <form id="ai-onboarding-form" onSubmit={handleSubmit}>
            <Input
              type="password"
              autoComplete="off"
              placeholder={providerDef.apiKeyPlaceholder}
              aria-label={`Chave da API do ${providerDef.name}`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono"
              required
            />
          </form>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Agora não
          </Button>
          <Button
            type="submit"
            form="ai-onboarding-form"
            onClick={!providerDef.requiresApiKey ? handleSubmit : undefined}
            disabled={(providerDef.requiresApiKey && !apiKey.trim()) || save.isPending}
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {save.isPending ? "Testando…" : "Salvar chave"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
