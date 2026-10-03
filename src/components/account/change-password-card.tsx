"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { changeOwnPassword } from "@/app/actions/user-actions";
import { Field } from "@/components/tools/tool-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const change = useMutation({
    mutationFn: async () => {
      if (next !== confirm) throw new Error("A confirmação não confere com a nova senha.");
      const result = await changeOwnPassword(current, next);
      if (!result.ok) throw new Error(result.error);
    },
    onSuccess: () => {
      toast.success("Senha alterada. Outras sessões abertas com o seu usuário foram encerradas.");
      setCurrent("");
      setNext("");
      setConfirm("");
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Trocar senha</CardTitle>
        <CardDescription>Se você recebeu uma senha inicial do administrador, troque por uma só sua.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate();
          }}
          className="flex flex-col gap-3 lg:flex-row lg:items-end"
        >
          <Field label="Senha atual" htmlFor="current-password" className="lg:w-52">
            <Input id="current-password" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </Field>
          <Field label="Nova senha (mín. 8)" htmlFor="new-own-password" className="lg:w-52">
            <Input id="new-own-password" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
          </Field>
          <Field label="Confirmar nova senha" htmlFor="confirm-own-password" className="lg:w-52">
            <Input id="confirm-own-password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} required />
          </Field>
          <Button type="submit" disabled={change.isPending} className="w-fit">
            {change.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Trocar senha
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
