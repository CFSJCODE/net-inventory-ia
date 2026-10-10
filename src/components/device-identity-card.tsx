"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { DeviceType } from "@prisma/client";
import { deleteDevice, updateDevice } from "@/app/actions/device-actions";
import { DEVICE_TYPE_LABELS } from "@/components/device-type-icon";
import { Field, SimpleSelect } from "@/components/tools/tool-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SparklesIcon } from "@/components/ui/sparkles";
import { aiSuggestIdentities } from "@/app/actions/ai-actions";
import { useAiAccess } from "@/components/ai/ai-common";
import { useCan } from "@/components/auth/user-provider";

interface Props {
  id: string;
  alias: string | null;
  hostname: string | null;
  type: DeviceType;
  typeLocked: boolean;
  notes: string | null;
  uplinkId: string | null;
  uplinkOptions: { id: string; label: string }[];
}

const AUTO_UPLINK = "";

export function DeviceIdentityCard(props: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [alias, setAlias] = useState(props.alias ?? "");
  const [type, setType] = useState<DeviceType>(props.type);
  const [typeLocked, setTypeLocked] = useState(props.typeLocked);
  const [notes, setNotes] = useState(props.notes ?? "");
  const [uplinkId, setUplinkId] = useState(props.uplinkId ?? AUTO_UPLINK);
  const uplinkChoices: Record<string, string> = {
    [AUTO_UPLINK]: "Automático (SNMP ou gateway)",
    ...Object.fromEntries(props.uplinkOptions.map((o) => [o.id, o.label])),
  };
  const { ready: aiReady } = useAiAccess();
  const canEdit = useCan("inventory.edit");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  /** A IA só preenche o formulário; nada é gravado até o usuário clicar em Salvar. */
  async function suggest() {
    setSuggesting(true);
    const result = await aiSuggestIdentities([props.id]);
    setSuggesting(false);
    if (!result.ok) return toast.error(result.error);
    const s = result.data[0];
    if (!s) return toast.error("A IA não retornou sugestão para este dispositivo.");
    setAlias(s.suggestedName);
    setType(s.type);
    setTypeLocked(true);
    setSuggestion(`Sugestão da IA (confiança ${s.confidence}): ${s.reasoning}`);
  }
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const dirty = alias !== (props.alias ?? "") || type !== props.type || typeLocked !== props.typeLocked || notes !== (props.notes ?? "") || uplinkId !== (props.uplinkId ?? AUTO_UPLINK);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const result = await updateDevice(props.id, { alias, type, typeLocked, notes, uplinkId });
    setSaving(false);
    if (!result.ok) return toast.error(result.error);
    toast.success("Identificação salva");
    queryClient.invalidateQueries({ queryKey: ["devices"] });
    queryClient.invalidateQueries({ queryKey: ["topology"] });
    router.refresh();
  }

  async function remove() {
    setDeleting(true);
    try {
      await deleteDevice(props.id);
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      toast.success("Dispositivo removido");
      router.push("/");
    } catch {
      setDeleting(false);
      toast.error("Não foi possível remover o dispositivo");
    }
  }

  // Ao mudar o tipo manualmente, trava por padrão — senão o próximo scan desfaria a escolha.
  function changeType(value: DeviceType) {
    setType(value);
    if (value !== props.type) setTypeLocked(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Identificação</CardTitle>
        <CardDescription>
          Dê um nome e o tipo certo a este dispositivo. O scan nunca altera o apelido nem as notas; com o tipo travado, ele também
          não muda o tipo. Em &quot;Conectado a&quot;, indique o switch ou roteador onde ele está ligado quando o mapa não descobre
          sozinho.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          {/* fieldset desabilitado: o visualizador vê os dados, mas não edita. */}
          <fieldset disabled={!canEdit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <Field label="Apelido" htmlFor="dev-alias">
              <Input
                id="dev-alias"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder={props.hostname ?? "Ex: TV da sala"}
                maxLength={80}
                className="sm:w-64"
              />
            </Field>
            <Field label="Tipo" htmlFor="dev-type">
              <SimpleSelect id="dev-type" value={type} onChange={changeType} options={DEVICE_TYPE_LABELS} className="sm:w-48" />
            </Field>
            <Label className="flex h-8 items-center gap-2 text-sm font-normal">
              <input type="checkbox" checked={typeLocked} onChange={(e) => setTypeLocked(e.target.checked)} />
              <Lock className="h-3.5 w-3.5 text-muted-foreground" />
              Travar tipo
            </Label>
          </div>
          <Field label="Conectado a" htmlFor="dev-uplink">
            <SimpleSelect id="dev-uplink" value={uplinkId} onChange={setUplinkId} options={uplinkChoices} className="sm:w-80" />
          </Field>
          <Field label="Notas" htmlFor="dev-notes">
            <textarea
              id="dev-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Ex: localização, dono, número de patrimônio…"
              className="w-full rounded-2xl border border-input bg-transparent px-3.5 py-2 text-sm outline-none transition-[border-color,box-shadow] duration-300 ease-out placeholder:text-muted-foreground hover:border-primary/50 focus-visible:border-primary/70 disabled:opacity-60"
            />
          </Field>
          </fieldset>
          {suggestion && (
            <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
              {suggestion} Revise e clique em Salvar para aplicar.
            </p>
          )}
          {!canEdit && <p className="text-xs text-muted-foreground">Somente leitura: seu perfil de acesso não permite editar o inventário.</p>}
          {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!dirty || saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Salvar
            </Button>
            {aiReady && (
              <Button type="button" variant="outline" onClick={suggest} disabled={suggesting}>
                {suggesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SparklesIcon size={14} className="text-primary" />}
                Sugerir com IA
              </Button>
            )}
            <Button type="button" variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => setConfirmOpen(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              Remover dispositivo
            </Button>
          </div>
          )}
        </form>
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remover dispositivo?</DialogTitle>
            <DialogDescription>
              O dispositivo, o histórico de eventos dele, as ligações monitoradas e a posição no mapa serão apagados. Se ele voltar a
              aparecer na rede, o scan o cadastrará como novo.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancelar</DialogClose>
            <Button variant="destructive" onClick={remove} disabled={deleting}>
              {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Remover
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
