"use server";

import { requireSession } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { displayName } from "@/lib/device-name";

export type AlertType = "LINK_DOWN" | "LINK_UP" | "DEVICE_DISCOVERED";

export interface AlertEvent {
  id: string;
  type: AlertType;
  message: string;
  deviceId: string;
  deviceName: string;
  createdAt: string;
}

/** Eventos que viram notificação do navegador, criados depois de `sinceIso`. */
export async function getAlertsSince(sinceIso: string): Promise<AlertEvent[]> {
  await requireSession();
  const since = new Date(sinceIso);
  if (Number.isNaN(since.getTime())) return [];
  const events = await prisma.deviceEvent.findMany({
    where: { createdAt: { gt: since }, type: { in: ["LINK_DOWN", "LINK_UP", "DEVICE_DISCOVERED"] } },
    orderBy: { createdAt: "asc" },
    take: 20,
    include: { device: { select: { hostname: true, alias: true, ip: true } } },
  });
  return events.map((e) => ({
    id: e.id,
    type: e.type as AlertType,
    message: e.message,
    deviceId: e.deviceId,
    deviceName: displayName(e.device, e.device.ip),
    createdAt: e.createdAt.toISOString(),
  }));
}
