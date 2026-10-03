"use client";

import Link from "next/link";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import type { Device } from "@prisma/client";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeviceTypeIcon, DEVICE_TYPE_LABELS } from "@/components/device-type-icon";
import { StatusBadge } from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/format-time";
import { useUiStore, type DeviceSortKey } from "@/store/ui-store";
import { cn } from "@/lib/utils";
import { displayName } from "@/lib/device-name";

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
  if (devices.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        Nenhum dispositivo encontrado. Clique em &quot;Escanear agora&quot; para descobrir a rede.
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {SORTABLE_COLUMNS.map(({ key, label, className }) => (
              <SortableHead key={key} sortKey={key} label={label} className={className} />
            ))}
            <TableHead>IPv6</TableHead>
            <TableHead>MAC</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {devices.map((device) => (
            <TableRow key={device.id}>
              <TableCell className="font-medium">
                <Link href={`/devices/${device.id}`} className="hover:underline">
                  {displayName(device)}
                </Link>
              </TableCell>
              <TableCell className="font-mono text-sm">{device.ip}</TableCell>
              <TableCell>
                <span className="flex items-center gap-1.5 text-sm">
                  <DeviceTypeIcon type={device.type} />
                  {DEVICE_TYPE_LABELS[device.type]}
                </span>
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
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
