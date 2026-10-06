"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUp, ArrowDown, ArrowUpDown, Lock, Unlock, Trash2 } from "lucide-react";
import type { Device, DeviceType } from "@prisma/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeviceTypeIcon, DEVICE_TYPE_LABELS } from "@/components/device-type-icon";
import { StatusBadge } from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/format-time";
import { useUiStore, type DeviceSortKey } from "@/store/ui-store";
import { cn } from "@/lib/utils";
import { displayName } from "@/lib/device-name";
import { useCan } from "@/components/auth/user-provider";
import { Button } from "@/components/ui/button";
import {
  bulkDeleteDevices,
  bulkSetDeviceType,
  bulkToggleDeviceLock,
  quickSetDeviceType,
  quickToggleDeviceLock,
} from "@/app/actions/device-actions";

const DEVICE_TYPES: DeviceType[] = [
  "COMPUTER",
  "NOTEBOOK",
  "MOBILE",
  "PRINTER",
  "CAMERA",
  "NVR",
  "SWITCH",
  "ROUTER",
  "SERVER",
  "SMART_TV",
  "IOT",
  "UNKNOWN",
];

const SORTABLE_COLUMNS: { key: DeviceSortKey; label: string; className?: string }[] = [
  { key: "hostname", label: "Dispositivo" },
  { key: "ip", label: "IPv4" },
  { key: "type", label: "Tipo" },
  { key: "vendor", label: "Fabricante" },
  { key: "status", label: "Status" },
  { key: "lastSeenAt", label: "Última vez visto", className: "text-right" },
];

function SortableHead({ sortKey, label, className }: { sortKey: DeviceSortKey; label: string; className?: string }) {
  const { sortKey: activeKey, sortDirection, toggleSort } = useUiStore();
  const isActive = activeKey === sortKey;
  const Icon = isActive ? (sortDirection === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => toggleSort(sortKey)}
        className={cn(
          "flex cursor-pointer items-center gap-1 hover:text-foreground",
          className?.includes("text-right") && "ml-auto",
          isActive ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <Icon className="h-3.5 w-3.5" />
      </button>
    </TableHead>
  );
}

/** Mostra o endereço principal (global) e indica quantos outros existem; a lista completa fica no title. */
function Ipv6Cell({ value }: { value: string | null }) {
  const addresses = value?.split(",").filter(Boolean) ?? [];
  if (!addresses.length) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground" title={addresses.join("\n")}>
      <span className="max-w-[8rem] truncate min-[1800px]:max-w-[16rem]">{addresses[0]}</span>
      {addresses.length > 1 && (
        <span className="shrink-0 rounded bg-muted px-1 font-sans text-[10px] text-foreground">+{addresses.length - 1}</span>
      )}
    </span>
  );
}

export function DeviceTable({ devices }: { devices: Device[] }) {
  const canEdit = useCan("inventory.edit");
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkType, setBulkType] = useState<DeviceType>("COMPUTER");
  const [isUpdating, setIsUpdating] = useState(false);

  const allSelected = devices.length > 0 && devices.every((d) => selectedIds.has(d.id));

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(devices.map((d) => d.id)));
    }
  }

  function toggleSelectOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  async function handleQuickTypeChange(device: Device, newType: DeviceType) {
    if (device.type === newType) return;
    const res = await quickSetDeviceType(device.id, newType);
    if (!res.ok) {
      toast.error(res.error);
    } else {
      toast.success(`Tipo alterado para ${DEVICE_TYPE_LABELS[newType]}`);
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    }
  }

  async function handleToggleLock(device: Device) {
    const nextLock = !device.typeLocked;
    const res = await quickToggleDeviceLock(device.id, nextLock);
    if (!res.ok) {
      toast.error(res.error);
    } else {
      toast.success(nextLock ? "Tipo fixado! Não será alterado por scans futuros." : "Tipo liberado para classificação automática.");
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    }
  }

  async function handleBulkApplyType(lock: boolean) {
    if (!selectedIds.size) return;
    setIsUpdating(true);
    try {
      const res = await bulkSetDeviceType(Array.from(selectedIds), bulkType, lock);
      if (!res.ok) throw new Error(res.error);
      toast.success(`${res.data} dispositivo(s) atualizado(s) para ${DEVICE_TYPE_LABELS[bulkType]}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUpdating(false);
    }
  }

  async function handleBulkToggleLock(lock: boolean) {
    if (!selectedIds.size) return;
    setIsUpdating(true);
    try {
      const res = await bulkToggleDeviceLock(Array.from(selectedIds), lock);
      if (!res.ok) throw new Error(res.error);
      toast.success(`${res.data} dispositivo(s) ${lock ? "fixado(s)" : "liberado(s)"}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUpdating(false);
    }
  }

  async function handleBulkDelete() {
    if (!selectedIds.size) return;
    if (!confirm(`Tem certeza que deseja remover ${selectedIds.size} dispositivo(s)?`)) return;
    setIsUpdating(true);
    try {
      const res = await bulkDeleteDevices(Array.from(selectedIds));
      if (!res.ok) throw new Error(res.error);
      toast.success(`${res.data} dispositivo(s) removido(s)`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUpdating(false);
    }
  }

  if (devices.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        Nenhum dispositivo encontrado. Clique em &quot;Escanear agora&quot; para descobrir a rede.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Barra flutuante de ações em lote */}
      {canEdit && selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-2.5 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
              {selectedIds.size} selecionado(s)
            </span>
            <div className="flex items-center gap-1.5 text-xs">
              <span>Mudar tipo para:</span>
              <select
                value={bulkType}
                onChange={(e) => setBulkType(e.target.value as DeviceType)}
                className="h-8 rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm"
              >
                {DEVICE_TYPES.map((dt) => (
                  <option key={dt} value={dt}>
                    {DEVICE_TYPE_LABELS[dt]}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="default"
                disabled={isUpdating}
                onClick={() => handleBulkApplyType(true)}
                className="h-8 text-xs"
              >
                Aplicar e Fixar
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={isUpdating}
              onClick={() => handleBulkToggleLock(true)}
              className="h-8 gap-1 text-xs"
              title="Fixa os tipos selecionados para não serem alterados pelo scan"
            >
              <Lock size={12} />
              Fixar
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isUpdating}
              onClick={() => handleBulkToggleLock(false)}
              className="h-8 gap-1 text-xs"
              title="Libera para voltar a classificar automaticamente no scan"
            >
              <Unlock size={12} />
              Liberar
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={isUpdating}
              onClick={handleBulkDelete}
              className="h-8 gap-1 text-xs"
            >
              <Trash2 size={12} />
              Excluir
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelectedIds(new Set())}
              className="h-8 text-xs text-muted-foreground"
            >
              Desmarcar
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {canEdit && (
                <TableHead className="w-10 px-3 text-center">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label="Selecionar todos os dispositivos visíveis"
                    className="h-4 w-4 rounded border-input text-primary"
                  />
                </TableHead>
              )}
              {SORTABLE_COLUMNS.map(({ key, label, className }) => (
                <SortableHead key={key} sortKey={key} label={label} className={className} />
              ))}
              <TableHead>IPv6</TableHead>
              <TableHead>MAC</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {devices.map((device) => {
              const isSelected = selectedIds.has(device.id);

              return (
                <TableRow key={device.id} className={cn(isSelected && "bg-muted/40")}>
                  {canEdit && (
                    <TableCell className="w-10 px-3 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelectOne(device.id)}
                        aria-label={`Selecionar ${displayName(device)}`}
                        className="h-4 w-4 rounded border-input text-primary"
                      />
                    </TableCell>
                  )}
                  <TableCell className="font-medium">
                    <Link href={`/devices/${device.id}`} className="hover:underline">
                      {displayName(device)}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{device.ip}</TableCell>
                  <TableCell>
                    {canEdit ? (
                      <div className="flex items-center gap-1.5">
                        <select
                          value={device.type}
                          onChange={(e) => handleQuickTypeChange(device, e.target.value as DeviceType)}
                          aria-label={`Tipo do dispositivo ${displayName(device)}`}
                          className="h-7 rounded border border-input bg-background/80 px-1.5 py-0.5 text-xs shadow-none transition-colors hover:bg-background focus:ring-1 focus:ring-ring"
                        >
                          {DEVICE_TYPES.map((dt) => (
                            <option key={dt} value={dt}>
                              {DEVICE_TYPE_LABELS[dt]}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => handleToggleLock(device)}
                          title={
                            device.typeLocked
                              ? "Tipo fixado manualmente (não será alterado pelo scan). Clique para destravar."
                              : "Tipo automático (pode ser alterado no próximo scan). Clique para fixar."
                          }
                          className={cn(
                            "rounded p-1 transition-colors hover:bg-muted",
                            device.typeLocked
                              ? "text-primary hover:text-primary/80"
                              : "text-muted-foreground/50 hover:text-muted-foreground",
                          )}
                        >
                          {device.typeLocked ? <Lock size={13} /> : <Unlock size={13} />}
                        </button>
                      </div>
                    ) : (
                      <span className="flex items-center gap-1.5 text-sm">
                        <DeviceTypeIcon type={device.type} />
                        {DEVICE_TYPE_LABELS[device.type]}
                        {device.typeLocked && (
                          <span title="Tipo fixado">
                            <Lock size={12} className="text-muted-foreground" />
                          </span>
                        )}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[10rem] truncate text-sm text-muted-foreground min-[1800px]:max-w-[18rem]" title={device.vendor ?? undefined}>
                    {device.vendor ?? "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={device.status} />
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {formatRelativeTime(device.lastSeenAt)}
                  </TableCell>
                  <TableCell>
                    <Ipv6Cell value={device.ipv6} />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {device.mac ?? "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
