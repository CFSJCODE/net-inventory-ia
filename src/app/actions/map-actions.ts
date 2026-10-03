"use server";

import { requirePermission, requireSession } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";

export type MapPositions = Record<string, { x: number; y: number }>;

export async function getMapPositions(): Promise<MapPositions> {
  await requireSession();
  const rows = await prisma.mapPosition.findMany();
  return Object.fromEntries(rows.map((r) => [r.nodeId, { x: r.x, y: r.y }]));
}

/** Salva a posição (relativa ao gateway) de um nó arrastado no mapa. */
export async function saveMapPosition(nodeId: string, x: number, y: number): Promise<void> {
  await requirePermission("inventory.edit");
  if (!nodeId || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Posição inválida.");
  await prisma.mapPosition.upsert({
    where: { nodeId },
    update: { x, y },
    create: { nodeId, x, y },
  });
}

/** Descarta as posições manuais: o mapa volta ao layout automático. */
export async function resetMapPositions(): Promise<void> {
  await requirePermission("inventory.edit");
  await prisma.mapPosition.deleteMany();
}
