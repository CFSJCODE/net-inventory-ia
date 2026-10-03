"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { useAiStatus } from "./ai-common";

const STEP_DELAY_MS = 450;

const link = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-2">
    {text}
  </a>
);

const STEPS: { icon: AnimatedIcon; title: string; body: ReactNode }[] = [
  {
    icon: EarthIcon,
    title: "Entre na plataforma da OpenAI",
    body: (
      <>
        Acesse {link("https://platform.openai.com", "platform.openai.com")} e faça login (ou crie uma conta). A API é cobrada à parte do
        ChatGPT Plus: adicione créditos em {link("https://platform.openai.com/settings/organization/billing", "Settings → Billing")}.
      </>
    ),
  },
  {
    icon: LockKeyholeIcon,
    title: "Crie uma chave secreta",
    body: (
      <>
        Em {link("https://platform.openai.com/api-keys", "API keys")}, clique em <strong>Create new secret key</strong>, dê um nome (ex.:
        NetInventory) e copie a chave, que começa com <code className="font-mono">sk-</code>. Ela só é exibida uma vez.
      </>
    ),
  },
  {
    icon: ShieldCheckIcon,
    title: "Cole a chave aqui",
    body: "Ela é testada antes de salvar e fica criptografada no servidor. Dá para trocar ou remover depois em Configurações.",
  },
];

/**
 * Aviso de boas-vindas sobre a chave da OpenAI: aparece enquanto não houver chave cadastrada e o
 * usuário não o dispensar — logo após o login ou para quem já estava logado. A dispensa fica no banco
 * (por usuário), então vale em qualquer navegador e volta a aparecer numa instalação nova.
 */
export function AiOnboardingDialog() {
  const queryClient = useQueryClient();
  const { data: ai } = useAiStatus();
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const sparklesRef = useRef<AnimatedIconHandle>(null);
  const stepRefs = useRef<(AnimatedIconHandle | null)[]>([]);

  useEffect(() => {
    if (ai?.onboardingPending) setOpen(true);
  }, [ai?.onboardingPending]);

  // Ao abrir, anima o título e depois cada passo em sequência, guiando a leitura.
  useEffect(() => {
    if (!open) return;
    const timers = [setTimeout(() => sparklesRef.current?.startAnimation(), 150)];
    STEPS.forEach((_, i) => timers.push(setTimeout(() => stepRefs.current[i]?.startAnimation(), 600 + i * STEP_DELAY_MS)));
    return () => timers.forEach(clearTimeout);
  }, [open]);

  // Fecha na hora; a dispensa é gravada no servidor em segundo plano.
  function close() {
    setOpen(false);
    if (ai?.onboardingPending) dismissAiKeyOnboarding().then((status) => queryClient.setQueryData(["ai-status"], status));
  }

  const save = useMutation({
    mutationFn: () => saveAiSettings({ apiKey, model: ai!.model }),
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.error);
      queryClient.setQueryData(["ai-status"], result.data);
      toast.success("Chave da OpenAI cadastrada — recursos de IA ativados");
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
            O NetInventory usa a OpenAI para identificar dispositivos, analisar a segurança da rede, resumir eventos e responder no
            Assistente. Para isso, cadastre a sua chave da API — leva cerca de 2 minutos.
          </DialogDescription>
        </DialogHeader>

        <ol className="flex flex-col gap-3">
          {STEPS.map((step, i) => {
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

        <form id="ai-onboarding-form" onSubmit={handleSubmit}>
          <Input
            type="password"
            autoComplete="off"
            placeholder="sk-..."
            aria-label="Chave da API da OpenAI"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="font-mono"
          />
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Agora não
          </Button>
          <Button type="submit" form="ai-onboarding-form" disabled={!apiKey.trim() || save.isPending}>
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {save.isPending ? "Testando…" : "Salvar chave"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
