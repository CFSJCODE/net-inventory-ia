import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/server";

const DEFAULT_CIDR = "192.168.1.0/24";

export async function GET() {
  // O middleware só confere o cookie; usuário desativado ou removido é barrado aqui.
  if (!(await getCurrentUser())) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const config = await prisma.scanConfig.findFirst();
  return NextResponse.json(config ?? { cidr: DEFAULT_CIDR, lastRunAt: null });
}
