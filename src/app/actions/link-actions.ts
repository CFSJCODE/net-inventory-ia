"use server";

import { requirePermission, requireSession } from "@/lib/auth/server";
import type { LinkStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { displayName } from "@/lib/device-name";
import { checkAllLinks } from "@/lib/network/link-monitor";
import type { ToolResult } from "./tool-actions";

export interface LinkStatusRow {
  id: string;
  fromDeviceId: string;
  toDeviceId: string;
  fromLabel: string;
  toLabel: string;
  label: string | null;
  status: LinkStatus;
  statusSince: string | null;
  downReason: string | null;
  latencyMs: number | null;
  lastCheckAt: string | null;
}

export async function listLinks(): Promise<LinkStatusRow[]> {
  await requireSession();
  const links = await prisma.topologyLink.findMany({
    include: { fromDevice: true, toDevice: true },
    orderBy: { createdAt: "asc" },
  });
  return links.map((l) => ({
    id: l.id,
    fromDeviceId: l.fromDeviceId,
    toDeviceId: l.toDeviceId,
    fromLabel: displayName(l.fromDevice, l.fromDevice.ip),
    toLabel: displayName(l.toDevice, l.toDevice.ip),
    label: l.label,
    status: l.status,
    statusSince: l.lastChangeAt?.toISOString() ?? null,
    downReason: l.downReason,
    latencyMs: l.latencyMs,
    lastCheckAt: l.lastCheckAt?.toISOString() ?? null,
  }));
}

export async function createLink(fromDeviceId: string, toDeviceId: string, label: string): Promise<ToolResult<null>> {
  await requirePermission("inventory.edit");
  try {
    if (!fromDeviceId || !toDeviceId) throw new Error("Escolha os dois dispositivos.");
    if (fromDeviceId === toDeviceId) throw new Error("Uma ligação precisa de dois dispositivos diferentes.");
    const existing = await prisma.topologyLink.findFirst({
      where: {
        OR: [
          { fromDeviceId, toDeviceId },
          { fromDeviceId: toDeviceId, toDeviceId: fromDeviceId },
        ],
      },
    });
    if (existing) throw new Error("Essa ligação já existe.");

    await prisma.topologyLink.create({ data: { fromDeviceId, toDeviceId, label: label.trim() || null } });
    // Testa na hora para a ligação já aparecer com o estado real, sem esperar o próximo ciclo.
    await checkAllLinks();
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteLink(id: string): Promise<void> {
  await requirePermission("inventory.edit");
  await prisma.topologyLink.delete({ where: { id } });
}

export async function checkLinksNow(): Promise<void> {
  await requirePermission("network.operate");
  await checkAllLinks();
}
