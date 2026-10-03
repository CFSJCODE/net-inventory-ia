"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTriggerScan } from "@/hooks/use-devices";
import { useCan } from "@/components/auth/user-provider";
import { RefreshCWIcon } from "@/components/ui/refresh-cw";
import { cn } from "@/lib/utils";

export function ScanButton() {
  const { mutate, isPending } = useTriggerScan();
  const canScan = useCan("network.operate");

  function handleScan() {
    mutate(undefined, {
      onSuccess: (result) => {
        toast.success("Scan concluído", {
          description: `${result.devicesFound} dispositivo(s) encontrado(s), ${result.newDevices} novo(s).`,
        });
      },
      onError: (error) => {
        toast.error("Falha ao escanear a rede", { description: error.message });
      },
    });
  }

  if (!canScan) return null;

  return (
    <Button onClick={handleScan} disabled={isPending}>
      <RefreshCWIcon size={14} className={cn(isPending && "animate-spin")} />
      {isPending ? "Escaneando..." : "Escanear agora"}
    </Button>
  );
}
