"use server";

import { revalidatePath } from "next/cache";
import type { DeviceType } from "@prisma/client";
import { requirePermission, requireSession } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { isRandomizedMac } from "@/lib/mac";
import type { ToolResult } from "./tool-actions";

const DEVICE_TYPES: DeviceType[] = ["COMPUTER", "NOTEBOOK", "MOBILE", "PRINTER", "CAMERA", "NVR", "SWITCH", "ROUTER", "SERVER", "UNKNOWN"];

export interface DeviceIdentityInput {
  alias: string;
  type: DeviceType;
  typeLocked: boolean;
  notes: string;
}

/** Identificação manual: apelido, tipo (opcionalmente travado contra o scan) e notas. */
export async function updateDevice(id: string, input: DeviceIdentityInput): Promise<ToolResult<null>> {
  await requirePermission("inventory.edit");
  try {
    if (!DEVICE_TYPES.includes(input.type)) throw new Error("Tipo inválido.");
    const alias = input.alias.trim().slice(0, 80);
    const notes = input.notes.trim().slice(0, 2000);
    await prisma.device.update({
      where: { id },
      data: { alias: alias || null, type: input.type, typeLocked: input.typeLocked, notes: notes || null },
    });
    revalidatePath(`/devices/${id}`);
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove o dispositivo; eventos e ligações saem em cascata, a posição no mapa é limpa aqui (não tem FK). */
export async function deleteDevice(id: string): Promise<void> {
  await requirePermission("inventory.edit");
  await prisma.$transaction([
    prisma.mapPosition.deleteMany({ where: { nodeId: id } }),
    prisma.device.delete({ where: { id } }),
  ]);
  revalidatePath("/");
}

/**
 * Dispositivos "efêmeros": MAC aleatório (celulares que trocam de MAC) e offline há mais de N dias.
 * Quando o aparelho volta com outro MAC, ele vira um novo registro — os antigos só poluem o inventário.
 */
async function findEphemeral(days: number) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const offline = await prisma.device.findMany({
    where: { status: "OFFLINE", lastSeenAt: { lt: cutoff }, alias: null },
    select: { id: true, mac: true },
  });
  // Dispositivos com apelido são preservados: o usuário os identificou de propósito.
  return offline.filter((d) => isRandomizedMac(d.mac));
}

export async function countEphemeralDevices(days: number): Promise<number> {
  await requireSession();
  return (await findEphemeral(days)).length;
}

export async function cleanupEphemeralDevices(days: number): Promise<number> {
  await requirePermission("settings.manage");
  if (!Number.isInteger(days) || days < 1) throw new Error("Período inválido.");
  const ids = (await findEphemeral(days)).map((d) => d.id);
  if (!ids.length) return 0;
  await prisma.$transaction([
    prisma.mapPosition.deleteMany({ where: { nodeId: { in: ids } } }),
    prisma.device.deleteMany({ where: { id: { in: ids } } }),
  ]);
  revalidatePath("/");
  return ids.length;
}
