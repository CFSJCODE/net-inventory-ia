"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { aiSuggestIdentities, listUnnamedDeviceIds } from "@/app/actions/ai-actions";
import { updateDevice } from "@/app/actions/device-actions";
import type { IdentitySuggestion } from "@/lib/ai/features";
import { DEVICE_TYPE_LABELS } from "@/components/device-type-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SparklesIcon } from "@/components/ui/sparkles";
import { useDevices } from "@/hooks/use-devices";
import { useAiAccess } from "./ai-common";

/** Identificação em massa dos dispositivos sem nome: a IA sugere, o usuário escolhe o que aplicar. */
export function BulkIdentifyButton() {
  const queryClient = useQueryClient();
  const { ready } = useAiAccess();
  const { data: devices } = useDevices();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [suggestions, setSuggestions] = useState<IdentitySuggestion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const unnamed = devices?.filter((d) => !d.alias && !d.hostname).length ?? 0;
  if (!ready || !unnamed) return null;

  const byId = new Map(devices?.map((d) => [d.id, d]));

  async function start() {
    setOpen(true);
    setLoading(true);
    setSuggestions([]);
    const ids = await listUnnamedDeviceIds();
    const result = await aiSuggestIdentities(ids);
    setLoading(false);
    if (!result.ok) {
      setOpen(false);
      return toast.error(result.error);
    }
    setSuggestions(result.data);
    // Pré-seleciona só as de confiança alta/média; as de baixa o usuário marca se quiser.
    setSelected(new Set(result.data.filter((s) => s.confidence !== "baixa").map((s) => s.deviceId)));
  }

  async function apply() {
    setApplying(true);
    const chosen = suggestions.filter((s) => selected.has(s.deviceId));
    const results = await Promise.all(
      chosen.map((s) => updateDevice(s.deviceId, { alias: s.suggestedName, type: s.type, typeLocked: true, notes: byId.get(s.deviceId)?.notes ?? "" })),
    );
    setApplying(false);
    const failed = results.filter((r) => !r.ok).length;
    if (failed) toast.error(`${failed} dispositivo(s) não puderam ser atualizados`);
    toast.success(`${chosen.length - failed} dispositivo(s) identificado(s)`);
    queryClient.invalidateQueries({ queryKey: ["devices"] });
    setOpen(false);
  }

  return (
    <>
      <Button variant="outline" onClick={start}>
        <SparklesIcon size={14} className="text-primary" />
        Identificar {unnamed} sem nome
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Identificação com IA</DialogTitle>
            <DialogDescription>
              Sugestões a partir do fabricante, portas abertas e tipo de MAC (IPs, MACs e nomes foram mascarados antes do envio).
              Marque as que quer aplicar — o tipo fica travado e o nome vira o apelido, que você pode editar depois.
            </DialogDescription>
          </DialogHeader>
          {loading ? (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Analisando {unnamed} dispositivo(s)…
            </p>
          ) : (
            <ul className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
              {suggestions.map((s) => {
                const d = byId.get(s.deviceId);
                return (
                  <li key={s.deviceId}>
                    <label className="flex cursor-pointer gap-3 rounded-md border p-3 hover:border-primary/50">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selected.has(s.deviceId)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(s.deviceId);
                          else next.delete(s.deviceId);
                          setSelected(next);
                        }}
                      />
                      <span className="flex flex-col gap-0.5 text-sm">
                        <span>
                          <span className="font-medium">{s.suggestedName}</span>
                          <span className="text-muted-foreground"> · {DEVICE_TYPE_LABELS[s.type]} · confiança {s.confidence}</span>
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {d?.ip} · {d?.vendor ?? "fabricante desconhecido"}
                        </span>
                        <span className="text-xs text-muted-foreground">{s.reasoning}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={apply} disabled={loading || applying || !selected.size}>
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Aplicar {selected.size || ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
