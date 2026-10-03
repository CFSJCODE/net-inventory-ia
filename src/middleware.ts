import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

/**
 * Exige login em todo o app: páginas, rotas /api e server actions (que chegam como POST para a
 * página). A tela de login e os arquivos estáticos ficam fora pelo matcher abaixo.
 */
export async function middleware(request: NextRequest) {
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) {
    // O layout usa o caminho para mandar ao login quem tem cookie válido mas foi desativado
    // (o middleware roda no Edge e não consulta o banco; o layout consulta).
    const headers = new Headers(request.headers);
    headers.set("x-pathname", request.nextUrl.pathname);
    return NextResponse.next({ request: { headers } });
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  const next = request.nextUrl.pathname + request.nextUrl.search;
  if (next !== "/") loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Tudo exceto: tela de login, internos do Next e imagens públicas de /public (logo, ícones, fundo
  // do login) — a tela de login precisa delas antes de existir sessão.
  matcher: ["/((?!login|_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|webp|svg)$).*)"],
};
