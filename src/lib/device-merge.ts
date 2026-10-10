import type { Device, Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { planDuplicateMerges, type MergePlan } from "@/lib/device-identity";

type Tx = Prisma.TransactionClient;

/**
 * Dados do registro mantido depois da fusão. Do mais antigo ficam o nome, o tipo e o que o usuário
 * editou; do visto mais recentemente vêm o IP, o status e o resto que o scan descobre. O que o
 * usuário editou só no duplicado (apelido, notas, tipo travado) é aproveitado para não se perder.
 */
export function mergedDeviceData(keep: Device, others: Device[], mac: string | null): Prisma.DeviceUpdateInput {
  const all = [keep, ...others];
  const freshest = [...all].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
  const data: Prisma.DeviceUpdateInput = {
    mac,
    ip: freshest.ip,
    status: freshest.status,
    lastSeenAt: freshest.lastSeenAt,
    firstSeenAt: new Date(Math.min(...all.map((d) => d.firstSeenAt.getTime()))),
    ipv6: freshest.ipv6 ?? keep.ipv6,
    openPorts: freshest.openPorts || keep.openPorts,
    vendor: freshest.vendor ?? keep.vendor,
    hostname: keep.hostname ?? freshest.hostname ?? others.find((d) => d.hostname)?.hostname ?? null,
    os: keep.os ?? others.find((d) => d.os)?.os ?? null,
    loggedUser: freshest.loggedUser ?? keep.loggedUser,
    alias: keep.alias ?? others.find((d) => d.alias)?.alias ?? null,
    notes: keep.notes ?? others.find((d) => d.notes)?.notes ?? null,
  };

  // "Conectado a": o do mantido vale; senão herda o do duplicado. Nunca aponta para o próprio aparelho.
  const ids = new Set(all.map((d) => d.id));
  const uplinkId = [keep, ...others].map((d) => d.uplinkId).find((u) => u && !ids.has(u)) ?? null;
  if (uplinkId !== keep.uplinkId) data.uplink = uplinkId ? { connect: { id: uplinkId } } : { disconnect: true };

  if (!keep.typeLocked) {
    const locked = others.find((d) => d.typeLocked);
    if (locked) {
      data.type = locked.type;
      data.typeLocked = true;
    } else if (keep.type === "UNKNOWN") {
      const known = others.find((d) => d.type !== "UNKNOWN");
      if (known) data.type = known.type;
    }
  }
  return data;
}

async function applyPlan(tx: Tx, plan: MergePlan): Promise<void> {
  const keep = await tx.device.findUnique({ where: { id: plan.keepId } });
  const others = await tx.device.findMany({ where: { id: { in: plan.mergeIds } } });
  if (!keep || others.length === 0) return;
  const mergeIds = others.map((d) => d.id);

  await tx.deviceEvent.updateMany({ where: { deviceId: { in: mergeIds } }, data: { deviceId: keep.id } });

  // Ligações da topologia: passam para o registro mantido; as que virariam laço ou repetição somem.
  const links = await tx.topologyLink.findMany({
    where: { OR: [{ fromDeviceId: { in: mergeIds } }, { toDeviceId: { in: mergeIds } }] },
  });
  const remap = (id: string) => (mergeIds.includes(id) ? keep.id : id);
  for (const link of links) {
    const fromDeviceId = remap(link.fromDeviceId);
    const toDeviceId = remap(link.toDeviceId);
    const clash =
      fromDeviceId === toDeviceId ||
      (await tx.topologyLink.findFirst({
        where: {
          id: { not: link.id },
          OR: [
            { fromDeviceId, toDeviceId },
            { fromDeviceId: toDeviceId, toDeviceId: fromDeviceId },
          ],
        },
      }));
    if (clash) await tx.topologyLink.delete({ where: { id: link.id } });
    else await tx.topologyLink.update({ where: { id: link.id }, data: { fromDeviceId, toDeviceId } });
  }

  // Posição no mapa: a do mantido vale; se ele não tem, herda a do duplicado.
  const positions = await tx.mapPosition.findMany({ where: { nodeId: { in: [keep.id, ...mergeIds] } } });
  if (!positions.some((p) => p.nodeId === keep.id)) {
    const inherited = positions.find((p) => mergeIds.includes(p.nodeId));
    if (inherited) await tx.mapPosition.create({ data: { nodeId: keep.id, x: inherited.x, y: inherited.y } });
  }
  await tx.mapPosition.deleteMany({ where: { nodeId: { in: mergeIds } } });

  // Quem estava "conectado a" um duplicado passa a apontar para o registro mantido.
  await tx.device.updateMany({ where: { uplinkId: { in: mergeIds }, id: { not: keep.id } }, data: { uplinkId: keep.id } });

  // Apaga antes de gravar o MAC no mantido: o MAC é único e pode estar num dos duplicados.
  await tx.device.deleteMany({ where: { id: { in: mergeIds } } });
  await tx.device.update({ where: { id: keep.id }, data: mergedDeviceData(keep, others, plan.mac) });
}

/**
 * Funde os duplicados já gravados no banco, mantendo o registro mais antigo de cada aparelho.
 * Idempotente: sem duplicados, não faz nada. Retorna quantos registros foram removidos.
 */
export async function mergeDuplicateDevices(client: PrismaClient = defaultPrisma): Promise<number> {
  const rows = await client.device.findMany({
    select: { id: true, ip: true, mac: true, hostname: true, firstSeenAt: true },
  });
  const plans = planDuplicateMerges(rows);
  let removed = 0;
  for (const plan of plans) {
    await client.$transaction((tx) => applyPlan(tx, plan));
    removed += plan.mergeIds.length;
  }
  if (removed > 0) console.log(`[device-merge] ${removed} registro(s) duplicado(s) fundido(s) no mais antigo`);
  return removed;
}
