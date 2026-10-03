import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/server";

export async function GET() {
  // O middleware só confere o cookie; usuário desativado ou removido é barrado aqui.
  if (!(await getCurrentUser())) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const events = await prisma.deviceEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { device: { select: { id: true, hostname: true, ip: true } } },
  });
  return NextResponse.json(events);
}
