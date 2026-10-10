"use server";

import { requirePermission } from "@/lib/auth/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { runConfiguredScan, type ScanResult } from "@/lib/scan-service";
import { parseScanCidr } from "@/lib/network/subnet";

export async function triggerScan(): Promise<ScanResult> {
  await requirePermission("network.operate");
  const result = await runConfiguredScan();
  revalidatePath("/");
  return result;
}

/** Intervalos aceitos para o scan automático (minutos); null = desligado. */
const ALLOWED_INTERVALS = [5, 15, 30, 60];

export async function updateScanConfig(rawCidr: string, intervalMinutes: number | null): Promise<void> {
  await requirePermission("settings.manage");
  if (intervalMinutes !== null && !ALLOWED_INTERVALS.includes(intervalMinutes)) throw new Error("Intervalo inválido.");
  // Mesma regra que o scan aplica: um CIDR inválido salvo só falharia no próximo scan.
  const cidr = rawCidr.trim();
  parseScanCidr(cidr);
  const existing = await prisma.scanConfig.findFirst();
  if (existing) {
    await prisma.scanConfig.update({ where: { id: existing.id }, data: { cidr, intervalMinutes } });
  } else {
    await prisma.scanConfig.create({ data: { cidr, intervalMinutes } });
  }
  revalidatePath("/settings");
}
