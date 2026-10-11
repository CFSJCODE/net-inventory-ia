"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCan } from "@/components/auth/user-provider";
import { deleteEquipment, listEquipment, readEquipmentDetail, type EquipmentRow } from "@/app/actions/equipment-actions";
import type { ToolResult } from "@/app/actions/tool-actions";
import { EquipmentFormDialog } from "./equipment-form-dialog";
import { EquipmentStatusPanel } from "./equipment-status-panel";

async function unwrap<T>(promise: Promise<ToolResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function DeleteEquipmentDialog({ equipment, onClose, onDeleted }: { equipment: EquipmentRow | null; onClose: () => void; onDeleted: (id: string) => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => unwrap(deleteEquipment(equipment!.id)),
    onSuccess: ({ id }) => {
      toast.success(`${equipment!.name} removido`);
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
      onDeleted(id);
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Dialog open={!!equipment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remover {equipment?.name}?</DialogTitle>
          <DialogDescription>Sai só da lista de equipamentos (com a community salva). Nada é alterado no próprio equipamento nem no inventário.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Remover
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EquipmentDetailSection({ equipment }: { equipment: EquipmentRow }) {
  const canQuery = useCan("network.operate");
  const detail = useQuery({
    queryKey: ["equipment-detail", equipment.id],
    queryFn: () => unwrap(readEquipmentDetail(equipment.id)),
    enabled: canQuery,
    staleTime: 30_000,
    retry: false,
  });

  return (
    <section className="flex flex-col gap-4" aria-label={`Estado de ${equipment.name}`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{equipment.name}</h2>
        <p className="font-mono text-xs text-muted-foreground">
          {equipment.ip} · SNMP v{equipment.snmpVersion}
        </p>
        {equipment.notes && <p className="text-sm whitespace-pre-line text-muted-foreground">{equipment.notes}</p>}
      </div>

      {!canQuery ? (
        <p className="text-sm text-muted-foreground">Seu perfil de acesso não permite consultar equipamentos via SNMP (requer Operador ou Administrador).</p>
      ) : detail.isPending ? (
        <div className="flex flex-col gap-4">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Lendo {equipment.ip} via SNMP…
          </p>
          <Skeleton className="h-32 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      ) : detail.isError && !detail.data ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{detail.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => detail.refetch()} disabled={detail.isFetching}>
              {detail.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Tentar de novo
            </Button>
          </CardContent>
        </Card>
      ) : detail.data ? (
        <>
          {detail.isError && <p className="text-sm text-destructive">Falha ao atualizar: {detail.error.message}. Mostrando a última leitura.</p>}
          <EquipmentStatusPanel data={detail.data} isFetching={detail.isFetching} onRefresh={() => detail.refetch()} />
        </>
      ) : null}
    </section>
  );
}

export function EquipmentView() {
  const canEdit = useCan("inventory.edit");
  const { data: rows, isLoading, error } = useQuery({ queryKey: ["equipment"], queryFn: () => unwrap(listEquipment()) });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EquipmentRow | null>(null);
  const [deleting, setDeleting] = useState<EquipmentRow | null>(null);

  // Sem escolha explícita, abre o primeiro: com um único switch cadastrado, os dados já aparecem.
  const selected = rows?.find((r) => r.id === selectedId) ?? rows?.[0] ?? null;

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(row: EquipmentRow) {
    setEditing(row);
    setFormOpen(true);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-base">Equipamentos cadastrados</CardTitle>
            <CardDescription>Clique num equipamento para ver o hardware e as portas em tempo real.</CardDescription>
          </div>
          {canEdit && (
            <Button onClick={openNew} className="w-fit">
              <Plus className="h-3.5 w-3.5" />
              Novo equipamento
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error.message}</p>
          ) : !rows?.length ? (
            <div className="flex flex-col items-start gap-3 rounded-md border border-dashed p-4">
              <p className="text-sm text-muted-foreground">
                Nenhum equipamento cadastrado ainda. Cadastre o switch com o IP, a community e a versão SNMP para acompanhar CPU, temperatura e cada porta.
              </p>
              {canEdit && (
                <Button variant="outline" size="sm" onClick={openNew}>
                  <Plus className="h-3.5 w-3.5" />
                  Cadastrar o primeiro
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Endereço</TableHead>
                    <TableHead>SNMP</TableHead>
                    <TableHead>Observações</TableHead>
                    {canEdit && <TableHead className="text-right">Ações</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const active = row.id === selected?.id;
                    return (
                      <TableRow
                        key={row.id}
                        onClick={() => setSelectedId(row.id)}
                        aria-selected={active}
                        className={cn("cursor-pointer", active && "bg-primary/5 hover:bg-primary/10")}
                      >
                        <TableCell className="font-medium">
                          <button type="button" className="text-left outline-none focus-visible:underline" onClick={() => setSelectedId(row.id)}>
                            {row.name}
                          </button>
                          {active && <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle" aria-hidden />}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{row.ip}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-normal">v{row.snmpVersion}</Badge>
                        </TableCell>
                        <TableCell className="max-w-72 truncate text-muted-foreground">{row.notes ?? "—"}</TableCell>
                        {canEdit && (
                          <TableCell>
                            <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                              <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                                <Pencil className="h-3.5 w-3.5" />
                                Editar
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setDeleting(row)} aria-label={`Remover ${row.name}`} className="text-destructive hover:text-destructive">
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {selected && <EquipmentDetailSection key={selected.id} equipment={selected} />}

      <EquipmentFormDialog open={formOpen} editing={editing} onClose={() => setFormOpen(false)} onSaved={(row) => {
        setFormOpen(false);
        setSelectedId(row.id);
      }} />
      <DeleteEquipmentDialog equipment={deleting} onClose={() => setDeleting(null)} onDeleted={(id) => id === selectedId && setSelectedId(null)} />
    </div>
  );
}
