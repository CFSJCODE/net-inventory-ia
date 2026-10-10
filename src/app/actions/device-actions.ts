"use server";

import { revalidatePath } from "next/cache";
import type { DeviceType } from "@prisma/client";
import { requirePermission, requireSession } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { isRandomizedMac } from "@/lib/mac";
import type { ToolResult } from "./tool-actions";

const DEVICE_TYPES: DeviceType[] = ["COMPUTER", "NOTEBOOK", "MOBILE", "PRINTER", "CAMERA", "NVR", "SWITCH", "ROUTER", "SERVER", "SMART_TV", "IOT", "UNKNOWN"];

export interface DeviceIdentityInput {
  alias: string;
  type: DeviceType;
  typeLocked: boolean;
  notes: string;
  /** "Conectado a": id do equipamento onde o dispositivo está ligado; "" = automático (SNMP ou gateway). */
  uplinkId?: string;
}

/**
 * Valida o "conectado a": precisa existir e não pode fechar um ciclo (A ligado em B ligado em A),
 * considerando tanto os "conectado a" quanto as ligações monitoradas (que têm prioridade no mapa).
 */
async function resolveUplink(id: string, uplinkId: string): Promise<string | null> {
  if (!uplinkId) return null;
  if (uplinkId === id) throw new Error("Um dispositivo não pode estar conectado a si mesmo.");
  const [devices, links] = await Promise.all([
    prisma.device.findMany({ select: { id: true, uplinkId: true } }),
    prisma.topologyLink.findMany({ select: { fromDeviceId: true, toDeviceId: true } }),
  ]);
  if (!devices.some((d) => d.id === uplinkId)) throw new Error("Equipamento de destino não encontrado.");
  const parents = new Map<string, string[]>();
  const add = (child: string, parent: string) => parents.set(child, [...(parents.get(child) ?? []), parent]);
  for (const d of devices) if (d.uplinkId && d.id !== id) add(d.id, d.uplinkId);
  for (const l of links) add(l.toDeviceId, l.fromDeviceId);
  // O aparelho não pode aparecer acima do novo "conectado a".
  const stack = [uplinkId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === id) throw new Error("Essa ligação formaria um ciclo no mapa.");
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(parents.get(cur) ?? []));
  }
  return uplinkId;
}

/** Identificação manual: apelido, tipo (opcionalmente travado contra o scan) e notas. */
export async function updateDevice(id: string, input: DeviceIdentityInput): Promise<ToolResult<null>> {
  await requirePermission("inventory.edit");
  try {
    if (!DEVICE_TYPES.includes(input.type)) throw new Error("Tipo inválido.");
    const alias = input.alias.trim().slice(0, 80);
    const notes = input.notes.trim().slice(0, 2000);
    const uplink = input.uplinkId === undefined ? {} : { uplinkId: await resolveUplink(id, input.uplinkId) };
    await prisma.device.update({
      where: { id },
      data: { alias: alias || null, type: input.type, typeLocked: input.typeLocked, notes: notes || null, ...uplink },
    });
    revalidatePath(`/devices/${id}`);
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function quickSetDeviceType(
  id: string,
  type: DeviceType,
  lock?: boolean,
): Promise<ToolResult<null>> {
  try {
    await requirePermission("inventory.edit");
    if (!DEVICE_TYPES.includes(type)) throw new Error("Tipo inválido.");
    await prisma.device.update({
      where: { id },
      data: {
        type,
        ...(lock !== undefined ? { typeLocked: lock } : {}),
      },
    });
    revalidatePath("/");
    revalidatePath(`/devices/${id}`);
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function quickToggleDeviceLock(id: string, typeLocked: boolean): Promise<ToolResult<null>> {
  try {
    await requirePermission("inventory.edit");
    await prisma.device.update({
      where: { id },
      data: { typeLocked },
    });
    revalidatePath("/");
    revalidatePath(`/devices/${id}`);
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function bulkSetDeviceType(
  ids: string[],
  type: DeviceType,
  lock: boolean = true,
): Promise<ToolResult<number>> {
  try {
    await requirePermission("inventory.edit");
    if (!DEVICE_TYPES.includes(type)) throw new Error("Tipo inválido.");
    if (!ids.length) return { ok: true, data: 0 };
    const res = await prisma.device.updateMany({
      where: { id: { in: ids } },
      data: { type, typeLocked: lock },
    });
    revalidatePath("/");
    return { ok: true, data: res.count };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function bulkToggleDeviceLock(
  ids: string[],
  typeLocked: boolean,
): Promise<ToolResult<number>> {
  try {
    await requirePermission("inventory.edit");
    if (!ids.length) return { ok: true, data: 0 };
    const res = await prisma.device.updateMany({
      where: { id: { in: ids } },
      data: { typeLocked },
    });
    revalidatePath("/");
    return { ok: true, data: res.count };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function bulkDeleteDevices(ids: string[]): Promise<ToolResult<number>> {
  try {
    await requirePermission("inventory.edit");
    if (!ids.length) return { ok: true, data: 0 };
    await prisma.$transaction([
      prisma.mapPosition.deleteMany({ where: { nodeId: { in: ids } } }),
      prisma.device.deleteMany({ where: { id: { in: ids } } }),
    ]);
    revalidatePath("/");
    return { ok: true, data: ids.length };
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
