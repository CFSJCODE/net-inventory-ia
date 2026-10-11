import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/server";
import { isScanRunning } from "@/lib/scan-service";

export async function GET() {
  if (!(await getCurrentUser())) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  return NextResponse.json({ running: isScanRunning() }, { headers: { "Cache-Control": "no-store" } });
}
