"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useScanStatus, useTriggerScan } from "@/hooks/use-devices";
import { useCan } from "@/components/auth/user-provider";
import { RefreshCWIcon } from "@/components/ui/refresh-cw";
import { cn } from "@/lib/utils";

export function ScanButton() {
  const { mutate, isPending } = useTriggerScan();
  const { data: scanStatus } = useScanStatus();
  const scanning = isPending || !!scanStatus?.running;
  const canScan = useCan("network.operate");

  function handleScan() {
    mutate(undefined, {
      onSuccess: (result) => {
        toast.success("Scan concluído", {
          description: `${result.devicesFound} dispositivo(s) encontrado(s), ${result.newDevices} novo(s).`,
        });
      },
      onError: (error) => {
        if (error.name === "SCAN_IN_PROGRESS") {
          toast.info("Scan em andamento", { description: error.message });
          return;
        }
        toast.error("Falha ao escanear a rede", { description: error.message });
      },
    });
  }

  if (!canScan) return null;

  return (
    <Button onClick={handleScan} disabled={scanning}>
      <RefreshCWIcon size={14} className={cn(scanning && "animate-spin")} />
      {scanning ? "Escaneando..." : "Escanear agora"}
    </Button>
  );
}
