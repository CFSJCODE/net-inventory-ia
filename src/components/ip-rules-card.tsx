"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Network, Plus, ShieldCheck, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import type { DeviceType } from "@prisma/client";
import { applyIpRulesAction, getIpRulesAction, saveIpRulesAction } from "@/app/actions/ip-rule-actions";
import type { IpClassificationRule } from "@/lib/network/ip-rules";
import { DeviceTypeIcon, DEVICE_TYPE_LABELS } from "@/components/device-type-icon";
import { useCan } from "@/components/auth/user-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SimpleSelect } from "@/components/tools/tool-shell";

export function IpRulesCard() {
  const canManage = useCan("settings.manage");
  const queryClient = useQueryClient();

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["ip-rules"],
    queryFn: async () => {
      const res = await getIpRulesAction();
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
  });

  const [pattern, setPattern] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<DeviceType>("COMPUTER");
  const [lock, setLock] = useState(true);

  const saveMutation = useMutation({
    mutationFn: async (newRules: IpClassificationRule[]) => {
      const res = await saveIpRulesAction(newRules);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ip-rules"] });
      toast.success("Regras salvas com sucesso!");
    },
    onError: (err) => toast.error(err.message),
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      const res = await applyIpRulesAction();
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    onSuccess: (data) => {
      toast.success(`Regras aplicadas! ${data.updatedCount} dispositivo(s) atualizado(s) de ${data.matchedCount} correspondente(s).`);
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (err) => toast.error(err.message),
  });

  function handleAddRule(e: React.FormEvent) {
    e.preventDefault();
    const cleanPattern = pattern.trim();
    if (!cleanPattern) {
      toast.error("Informe um IP, faixa (ex: 192.168.0.100-192.168.0.150) ou CIDR.");
      return;
    }

    const newRule: IpClassificationRule = {
      id: crypto.randomUUID(),
      name: name.trim() || undefined,
      pattern: cleanPattern,
      type,
      lock,
      enabled: true,
    };

    saveMutation.mutate([...rules, newRule]);
    setPattern("");
    setName("");
  }

  function handleToggleRule(id: string) {
    const updated = rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r));
    saveMutation.mutate(updated);
  }

  function handleDeleteRule(id: string) {
    const updated = rules.filter((r) => r.id !== id);
    saveMutation.mutate(updated);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network size={16} className="text-primary" />
          Regras de Classificação por IP e Faixa
        </CardTitle>
        <CardDescription>
          Ideal para redes domésticas com DHCP e IPs reservados: defina faixas para câmeras, impressoras ou computadores.
          Dispositivos que entrarem nesses IPs serão classificados automaticamente no scan.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 text-sm">
        {/* Formulário de adicionar regra */}
        {canManage && (
          <form onSubmit={handleAddRule} className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4">
            <div className="font-medium text-foreground">Adicionar nova regra</div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div>
                <label htmlFor="rule-pattern" className="text-xs text-muted-foreground">Padrão de IP *</label>
                <Input
                  id="rule-pattern"
                  placeholder="Ex: 192.168.0.100-192.168.0.150"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  className="mt-1"
                />
              </div>

              <div>
                <label htmlFor="rule-name" className="text-xs text-muted-foreground">Descrição (opcional)</label>
                <Input
                  id="rule-name"
                  placeholder="Ex: Câmeras CFTV"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1"
                />
              </div>

              <div>
                <label htmlFor="rule-type" className="text-xs text-muted-foreground">Tipo de Dispositivo</label>
                <SimpleSelect id="rule-type" value={type} onChange={setType} options={DEVICE_TYPE_LABELS} className="mt-1 sm:w-full" />
              </div>

              <div className="flex flex-col justify-end">
                <Button type="submit" disabled={saveMutation.isPending || !pattern.trim()} className="h-9">
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Adicionar regra
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs text-muted-foreground">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={lock}
                  onChange={(e) => setLock(e.target.checked)}
                  className="rounded border-input text-primary"
                />
                <span>Fixar tipo no dispositivo contra alterações em scans futuros (<code>typeLocked</code>)</span>
              </label>

              <span className="text-[11px] text-muted-foreground/80">
                Formatos aceitos: <code>192.168.0.50</code>, <code>192.168.0.10-192.168.0.30</code>, <code>192.168.0.0/28</code>, <code>192.168.0.*</code>
              </span>
            </div>
          </form>
        )}

        {/* Lista de regras cadastradas */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Regras Ativas ({rules.length})
            </span>
            {rules.length > 0 && canManage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => applyMutation.mutate()}
                disabled={applyMutation.isPending}
                className="h-8 gap-1.5 text-xs"
              >
                {applyMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wand2 className="h-3.5 w-3.5" />
                )}
                Aplicar regras aos dispositivos existentes
              </Button>
            )}
          </div>

          {isLoading ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Carregando regras...</p>
          ) : rules.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
              Nenhuma regra cadastrada. Adicione faixas de IP acima para classificar seus aparelhos automaticamente.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-xs">
                <thead className="border-b bg-muted/40 font-medium text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Padrão de IP</th>
                    <th className="px-3 py-2">Descrição</th>
                    <th className="px-3 py-2">Tipo Atribuído</th>
                    <th className="px-3 py-2 text-center">Fixar Tipo</th>
                    <th className="px-3 py-2 text-center">Status</th>
                    {canManage && <th className="px-3 py-2 text-right">Ação</th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rules.map((rule) => (
                    <tr key={rule.id} className="hover:bg-muted/20">
                      <td className="px-3 py-2.5 font-mono font-medium text-foreground">{rule.pattern}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{rule.name || "—"}</td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1.5">
                          <DeviceTypeIcon type={rule.type} size={14} />
                          {DEVICE_TYPE_LABELS[rule.type]}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {rule.lock ? (
                          <Badge variant="secondary" className="gap-1 text-[10px]">
                            <ShieldCheck size={10} className="text-primary" /> Sim
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">Não</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <button
                          type="button"
                          disabled={!canManage}
                          onClick={() => handleToggleRule(rule.id)}
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                            rule.enabled
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {rule.enabled ? "Ativa" : "Pausada"}
                        </button>
                      </td>
                      {canManage && (
                        <td className="px-3 py-2.5 text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => handleDeleteRule(rule.id)}
                            title="Excluir regra"
                          >
                            <Trash2 size={13} />
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
