import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/server";

export async function GET() {
  // O middleware só confere o cookie; usuário desativado ou removido é barrado aqui.
  if (!(await getCurrentUser())) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const runs = await prisma.scanRun.findMany({ orderBy: { startedAt: "desc" }, take: 10 });
  return NextResponse.json(runs);
}
