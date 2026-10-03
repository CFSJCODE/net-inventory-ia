"use client";

import { useMemo } from "react";
import { useDevices } from "@/hooks/use-devices";
import { useUiStore, DEVICES_PAGE_SIZE } from "@/store/ui-store";
import { DeviceFilters } from "@/components/device-filters";
import { DeviceTable } from "@/components/device-table";
import { DevicePagination } from "@/components/device-pagination";
import { ScanButton } from "@/components/scan-button";
import { BulkIdentifyButton } from "@/components/ai/bulk-identify-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { sortDevices } from "@/lib/device-sort";
import { isRandomizedMac } from "@/lib/mac";

/** Efêmero: offline, MAC aleatório e sem apelido (quem o usuário identificou nunca é escondido). */
function isEphemeral(d: { status: string; mac: string | null; alias: string | null }): boolean {
  return d.status === "OFFLINE" && !d.alias && isRandomizedMac(d.mac);
}

export function DeviceInventory() {
  const { data: devices, isLoading, isError } = useDevices();
  const { search, statusFilter, typeFilter, sortKey, sortDirection, page, setPage, hideEphemeral, setHideEphemeral } = useUiStore();
  const ephemeralCount = devices?.filter(isEphemeral).length ?? 0;

  const filtered = useMemo(() => {
    if (!devices) return [];
    const term = search.trim().toLowerCase();

    const matched = devices.filter((device) => {
      const matchesSearch =
        !term ||
        device.hostname?.toLowerCase().includes(term) ||
        device.alias?.toLowerCase().includes(term) ||
        device.notes?.toLowerCase().includes(term) ||
        device.ip.includes(term) ||
        device.mac?.toLowerCase().includes(term) ||
        device.ipv6?.toLowerCase().includes(term);
      const matchesStatus = statusFilter === "ALL" || device.status === statusFilter;
      const matchesType = typeFilter === "ALL" || device.type === typeFilter;
      return matchesSearch && matchesStatus && matchesType && !(hideEphemeral && isEphemeral(device));
    });

    return sortDevices(matched, sortKey, sortDirection);
  }, [devices, search, statusFilter, typeFilter, sortKey, sortDirection, hideEphemeral]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / DEVICES_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const paginated = filtered.slice((currentPage - 1) * DEVICES_PAGE_SIZE, currentPage * DEVICES_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <DeviceFilters />
        <BulkIdentifyButton />
        <ScanButton />
      </div>

      {isLoading && <Skeleton className="h-64 w-full" />}
      {isError && (
        <p className="text-sm text-destructive">Não foi possível carregar o inventário.</p>
      )}
      {!isLoading && !isError && (
        <>
          {ephemeralCount > 0 && (
            <p className="-mt-2 text-xs text-muted-foreground">
              {hideEphemeral
                ? `${ephemeralCount} dispositivo(s) efêmero(s) oculto(s) — celulares offline com MAC aleatório, que provavelmente já voltaram com outro MAC. `
                : `Mostrando ${ephemeralCount} dispositivo(s) efêmero(s). `}
              <button type="button" onClick={() => setHideEphemeral(!hideEphemeral)} className="cursor-pointer text-foreground underline underline-offset-2">
                {hideEphemeral ? "Mostrar" : "Ocultar"}
              </button>
            </p>
          )}
          <DeviceTable devices={paginated} />
          <DevicePagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
