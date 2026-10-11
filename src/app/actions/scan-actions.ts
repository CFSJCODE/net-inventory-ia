"use server";

import { requirePermission } from "@/lib/auth/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { runConfiguredScan, type ScanResult } from "@/lib/scan-service";
import { parseScanCidr } from "@/lib/network/subnet";
import { ALLOWED_INTERVAL_MINUTES } from "@/lib/auto-interval";

export async function triggerScan(): Promise<ScanResult> {
  await requirePermission("network.operate");
  const result = await runConfiguredScan();
  revalidatePath("/");
  return result;
}

export async function updateScanConfig(rawCidr: string, intervalMinutes: number | null): Promise<void> {
  await requirePermission("settings.manage");
  if (intervalMinutes !== null && !ALLOWED_INTERVAL_MINUTES.includes(intervalMinutes)) throw new Error("Intervalo inválido.");
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
