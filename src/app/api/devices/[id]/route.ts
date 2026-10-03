import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  // O middleware só confere o cookie; usuário desativado ou removido é barrado aqui.
  if (!(await getCurrentUser())) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const { id } = await params;
  const device = await prisma.device.findUnique({
    where: { id },
    include: { events: { orderBy: { createdAt: "desc" } } },
  });

  if (!device) {
    return NextResponse.json({ error: "Dispositivo não encontrado" }, { status: 404 });
  }

  return NextResponse.json(device);
}
