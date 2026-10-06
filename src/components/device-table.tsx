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
import { SimpleSelect } from "@/components/tools/tool-shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  bulkDeleteDevices,
  bulkSetDeviceType,
  bulkToggleDeviceLock,
  quickSetDeviceType,
  quickToggleDeviceLock,
} from "@/app/actions/device-actions";

const DEVICE_TYPES = Object.keys(DEVICE_TYPE_LABELS) as DeviceType[];

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

function TypeLabel({ device }: { device: Device }) {
  return (
    <span className="flex items-center gap-1.5 text-sm">
      <DeviceTypeIcon type={device.type} />
      {DEVICE_TYPE_LABELS[device.type]}
      {device.typeLocked && (
        <span title="Tipo fixado: o scan não altera">
          <Lock size={12} className="text-muted-foreground" />
        </span>
      )}
    </span>
  );
}

/** Mesmo visual do rótulo de tipo; ao clicar, abre o menu para trocar o tipo ou fixá-lo. */
function TypeMenu({ device, onChange }: { device: Device; onChange: () => void }) {
  async function setType(type: DeviceType) {
    if (type === device.type) return;
    // Trocar o tipo manualmente fixa por padrão — senão o próximo scan desfaria a escolha.
    const res = await quickSetDeviceType(device.id, type, true);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Tipo alterado para ${DEVICE_TYPE_LABELS[type]}`);
    onChange();
  }

  async function toggleLock() {
    const next = !device.typeLocked;
    const res = await quickToggleDeviceLock(device.id, next);
    if (!res.ok) return toast.error(res.error);
    toast.success(next ? "Tipo fixado: o scan não vai alterá-lo." : "Tipo liberado para a classificação automática.");
    onChange();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="cursor-pointer rounded hover:text-foreground" aria-label={`Tipo de ${displayName(device)}`}>
        <TypeLabel device={device} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-48">
        <DropdownMenuRadioGroup value={device.type} onValueChange={(v) => setType(v as DeviceType)}>
          {DEVICE_TYPES.map((type) => (
            <DropdownMenuRadioItem key={type} value={type}>
              <DeviceTypeIcon type={type} />
              {DEVICE_TYPE_LABELS[type]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={toggleLock}>
          {device.typeLocked ? <Unlock /> : <Lock />}
          {device.typeLocked ? "Liberar tipo" : "Fixar tipo"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DeviceTable({ devices }: { devices: Device[] }) {
  const canEdit = useCan("inventory.edit");
  const queryClient = useQueryClient();
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkType, setBulkType] = useState<DeviceType>("COMPUTER");
  const [isUpdating, setIsUpdating] = useState(false);

  const allSelected = devices.length > 0 && devices.every((d) => selectedIds.has(d.id));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["devices"] });

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(devices.map((d) => d.id)));
  }

  function toggleSelectOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  function stopSelecting() {
    setSelecting(false);
    setSelectedIds(new Set());
  }

  async function runBulk(action: () => Promise<{ ok: true; data: number } | { ok: false; error: string }>, message: (count: number) => string) {
    setIsUpdating(true);
    try {
      const res = await action();
      if (!res.ok) throw new Error(res.error);
      toast.success(message(res.data));
      setSelectedIds(new Set());
      refresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUpdating(false);
    }
  }

  const ids = () => Array.from(selectedIds);

  if (devices.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        Nenhum dispositivo encontrado. Clique em &quot;Escanear agora&quot; para descobrir a rede.
      </div>
    );
  }

  const showSelection = canEdit && selecting;

  return (
    <div className="flex flex-col gap-2">
      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {showSelection && (
            <>
              <span className="text-xs text-muted-foreground">{selectedIds.size} selecionado(s)</span>
              <SimpleSelect value={bulkType} onChange={setBulkType} options={DEVICE_TYPE_LABELS} className="h-8 sm:w-40" />
              <Button
                size="sm"
                variant="outline"
                disabled={isUpdating || !selectedIds.size}
                onClick={() =>
                  runBulk(
                    () => bulkSetDeviceType(ids(), bulkType, true),
                    (n) => `${n} dispositivo(s) alterado(s) para ${DEVICE_TYPE_LABELS[bulkType]}`,
                  )
                }
              >
                Aplicar tipo
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={isUpdating || !selectedIds.size}
                onClick={() => runBulk(() => bulkToggleDeviceLock(ids(), true), (n) => `${n} dispositivo(s) fixado(s)`)}
              >
                <Lock /> Fixar
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={isUpdating || !selectedIds.size}
                onClick={() => runBulk(() => bulkToggleDeviceLock(ids(), false), (n) => `${n} dispositivo(s) liberado(s)`)}
              >
                <Unlock /> Liberar
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={isUpdating || !selectedIds.size}
                className="text-destructive"
                onClick={() => {
                  if (!confirm(`Remover ${selectedIds.size} dispositivo(s)?`)) return;
                  runBulk(() => bulkDeleteDevices(ids()), (n) => `${n} dispositivo(s) removido(s)`);
                }}
              >
                <Trash2 /> Excluir
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
            {selecting ? "Concluir" : "Editar em lote"}
          </Button>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {showSelection && (
                <TableHead className="w-10">
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} aria-label="Selecionar todos" />
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
            {devices.map((device) => (
              <TableRow key={device.id} data-state={selectedIds.has(device.id) ? "selected" : undefined}>
                {showSelection && (
                  <TableCell className="w-10">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(device.id)}
                      onChange={() => toggleSelectOne(device.id)}
                      aria-label={`Selecionar ${displayName(device)}`}
                    />
                  </TableCell>
                )}
                <TableCell className="font-medium">
                  <Link href={`/devices/${device.id}`} className="hover:underline">
                    {displayName(device)}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-sm">{device.ip}</TableCell>
                <TableCell>{canEdit ? <TypeMenu device={device} onChange={refresh} /> : <TypeLabel device={device} />}</TableCell>
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
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
