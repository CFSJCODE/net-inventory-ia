"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Device, DeviceEvent, ScanConfig, ScanRun } from "@prisma/client";
import { triggerScan, updateScanConfig } from "@/app/actions/scan-actions";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao buscar ${url}`);
  return res.json();
}

export function useDevices() {
  return useQuery({
    queryKey: ["devices"],
    queryFn: () => fetchJson<Device[]>("/api/devices"),
    refetchInterval: 15_000,
  });
}

export function useDevice(id: string | undefined) {
  return useQuery({
    queryKey: ["devices", id],
    queryFn: () => fetchJson<Device & { events: DeviceEvent[] }>(`/api/devices/${id}`),
    enabled: !!id,
  });
}

export function useScanConfig() {
  return useQuery({
    queryKey: ["scan-config"],
    queryFn: () => fetchJson<ScanConfig>("/api/scan-config"),
  });
}

export function useScanRuns() {
  return useQuery({
    queryKey: ["scan-runs"],
    queryFn: () => fetchJson<ScanRun[]>("/api/scan-runs"),
  });
}

export function useTriggerScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: triggerScan,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      queryClient.invalidateQueries({ queryKey: ["scan-config"] });
      queryClient.invalidateQueries({ queryKey: ["scan-runs"] });
    },
  });
}

export function useUpdateScanConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ cidr, intervalMinutes }: { cidr: string; intervalMinutes: number | null }) => updateScanConfig(cidr, intervalMinutes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scan-config"] });
    },
  });
}
