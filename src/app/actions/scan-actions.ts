"use server";

import { getCurrentUser, requirePermission } from "@/lib/auth/server";
import { can } from "@/lib/auth/permissions";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { runConfiguredScan, ScanInProgressError, type ScanResult } from "@/lib/scan-service";
import { parseScanCidr } from "@/lib/network/subnet";
import { ALLOWED_INTERVAL_MINUTES } from "@/lib/auto-interval";

export type ScanActionResult =
  | { ok: true; data: ScanResult }
  | { ok: false; code: "SCAN_IN_PROGRESS" | "SCAN_FAILED" | "FORBIDDEN"; error: string };

export async function triggerScan(): Promise<ScanActionResult> {
  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, code: "FORBIDDEN", error: "Sessão expirada. Faça login novamente." };
    if (!can(user.role, "network.operate")) {
      return { ok: false, code: "FORBIDDEN", error: "Seu perfil de acesso não permite esta ação." };
    }
    const result = await runConfiguredScan();
    revalidatePath("/");
    return { ok: true, data: result };
  } catch (error) {
    if (error instanceof ScanInProgressError) {
      return { ok: false, code: "SCAN_IN_PROGRESS", error: error.message };
    }
    console.error("[scan] falha no scan manual:", error);
    return { ok: false, code: "SCAN_FAILED", error: "Não foi possível concluir o scan. Tente novamente; se persistir, consulte o histórico e os logs do serviço." };
  }
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
