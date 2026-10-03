import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/server";

export async function GET() {
  // O middleware só confere o cookie; usuário desativado ou removido é barrado aqui.
  if (!(await getCurrentUser())) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const devices = await prisma.device.findMany({ orderBy: { lastSeenAt: "desc" } });
  return NextResponse.json(devices);
}
