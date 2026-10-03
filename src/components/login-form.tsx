"use client";

import { useActionState, useRef, useState, type ComponentProps } from "react";
import { Loader2 } from "lucide-react";
import { login, setupAdmin, type AuthFormState } from "@/app/actions/auth-actions";
import type { AnimatedIcon, AnimatedIconHandle } from "@/components/page-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserIcon } from "@/components/ui/user";
import { LockKeyholeIcon } from "@/components/ui/lock-keyhole";
import { EyeIcon } from "@/components/ui/eye";
import { EyeOffIcon } from "@/components/ui/eye-off";
import { ArrowRightIcon } from "@/components/ui/arrow-right";
import { ShieldCheckIcon } from "@/components/ui/shield-check";

/**
 * Input com ícone animado à esquerda (anima quando o campo recebe foco) e, opcionalmente, o botão
 * de mostrar/ocultar senha à direita.
 */
function IconInput({ icon: Icon, revealable, ...props }: ComponentProps<typeof Input> & { icon: AnimatedIcon; revealable?: boolean }) {
  const [visible, setVisible] = useState(false);
  const iconRef = useRef<AnimatedIconHandle>(null);
  const EyeToggle = visible ? EyeOffIcon : EyeIcon;

  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-4 flex -translate-y-1/2 text-primary">
        <Icon ref={iconRef} size={16} />
      </span>
      <Input
        {...props}
        type={revealable && visible ? "text" : props.type}
        onFocus={() => iconRef.current?.startAnimation()}
        // Fundo igual ao do card e texto cinza claro. Com usuário/senha salvos, o autofill do navegador
        // pinta o fundo de claro (com !important); uma sombra interna na cor do card cobre isso. No hover
        // e no foco a sombra precisa SOMAR o brilho verde — se só trocasse, o fundo claro reapareceria.
        className={[
          "h-11 border-2 bg-card pl-11 pr-11 text-sm text-zinc-300 dark:bg-card",
          "autofill:[-webkit-text-fill-color:var(--color-zinc-300)]",
          "autofill:shadow-[inset_0_0_0_1000px_var(--color-card)]",
          "autofill:hover:shadow-[inset_0_0_0_1000px_var(--color-card),0_0_14px_-2px_color-mix(in_oklab,var(--color-primary)_45%,transparent)]",
          "autofill:focus-visible:shadow-[inset_0_0_0_1000px_var(--color-card),0_0_18px_-2px_color-mix(in_oklab,var(--color-primary)_55%,transparent)]",
        ].join(" ")}
      />
      {revealable && (
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
          aria-pressed={visible}
          className="absolute top-1/2 right-3 flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-primary transition-opacity hover:opacity-80"
        >
          <EyeToggle size={16} />
        </button>
      )}
    </div>
  );
}

export function LoginForm({ mode, next }: { mode: "setup" | "login"; next: string }) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(mode === "setup" ? setupAdmin : login, {});
  const arrowRef = useRef<AnimatedIconHandle>(null);

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="next" value={next} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="username">Usuário</Label>
        <IconInput icon={UserIcon} id="username" name="username" placeholder="seu.usuario" autoComplete="username" required autoFocus />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Senha</Label>
        <IconInput
          icon={LockKeyholeIcon}
          revealable
          id="password"
          name="password"
          type="password"
          placeholder="••••••••"
          autoComplete={mode === "setup" ? "new-password" : "current-password"}
          minLength={mode === "setup" ? 8 : undefined}
          required
        />
      </div>
      {mode === "setup" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm">Confirmar senha</Label>
          <IconInput icon={LockKeyholeIcon} revealable id="confirm" name="confirm" type="password" placeholder="••••••••" autoComplete="new-password" minLength={8} required />
          <p className="text-xs text-muted-foreground">Mínimo de 8 caracteres.</p>
        </div>
      )}

      {state.error && (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {state.error}
        </p>
      )}

      <Button
        type="submit"
        disabled={pending}
        className="mt-2 h-11 w-full text-sm"
        onMouseEnter={() => arrowRef.current?.startAnimation()}
        onMouseLeave={() => arrowRef.current?.stopAnimation()}
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {mode === "setup" ? "Criar e entrar" : "Entrar"}
        {!pending && <ArrowRightIcon ref={arrowRef} size={16} />}
      </Button>

      <div className="mt-2 flex items-center gap-3 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        <span className="h-px flex-1 bg-border" />
        <span className="flex items-center gap-1.5">
          <ShieldCheckIcon size={14} className="text-primary" />
          Autenticação segura
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <p className="text-center text-xs leading-relaxed text-muted-foreground">
        Acesso restrito aos administradores da rede. Sessão criptografada e senha protegida com hash.
      </p>
    </form>
  );
}
