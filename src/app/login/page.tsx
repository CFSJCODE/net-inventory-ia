import Image from "next/image";
import { redirect } from "next/navigation";
import { hasAnyUser } from "@/app/actions/auth-actions";
import { getCurrentUser } from "@/lib/auth/server";
import { LoginForm } from "@/components/login-form";
import { LoginFeatures } from "@/components/login-features";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getCurrentUser()) redirect(next?.startsWith("/") && !next.startsWith("//") ? next : "/");
  const firstAccess = !(await hasAnyUser());

  return (
    <main className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* Painel de apresentação: imagem de fundo com máscara escura em gradiente para dar leitura ao texto. */}
      <section className="relative hidden overflow-hidden lg:flex">
        <Image src="/background.jpg" alt="" fill priority sizes="50vw" className="object-cover object-[30%_center]" />
        {/* Forte embaixo (onde fica o texto), leve em cima (a cena aparece). */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/65 to-black/20" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/40 via-transparent to-transparent" />

        <div className="relative z-10 flex w-full flex-col justify-between p-10 xl:p-12">
          <div className="flex items-center gap-2.5">
            <Image src="/logo.png" alt="" width={32} height={32} />
            <span className="text-lg font-semibold tracking-tight text-white">NetInventory</span>
          </div>

          <div className="flex max-w-xl flex-col gap-6">
            <div className="flex flex-col gap-3">
              <h2 className="text-4xl font-semibold tracking-tight text-white">Sua rede, sob controle.</h2>
              <p className="text-base leading-relaxed text-white/75">
                Descubra, mapeie e monitore todos os dispositivos da rede local em um só lugar — com alertas e inteligência artificial.
              </p>
            </div>
            <LoginFeatures />
          </div>

          <p className="text-xs text-white/50">© {new Date().getFullYear()} NetInventory. Todos os direitos reservados.</p>
        </div>
      </section>

      {/* Formulário */}
      <section className="flex items-center justify-center bg-background px-4 py-12 sm:px-8">
        <div className="flex w-full max-w-md flex-col gap-8">
          <div className="flex items-center justify-center gap-2.5 lg:hidden">
            <Image src="/logo.png" alt="" width={32} height={32} />
            <span className="text-lg font-semibold tracking-tight">NetInventory</span>
          </div>

          <div className="rounded-2xl border bg-card px-6 py-10 shadow-xl shadow-black/20 sm:px-10 sm:py-12">
            <div className="mb-8 flex flex-col items-center gap-2 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">{firstAccess ? "Criar administrador" : "Bem-vindo de volta"}</h1>
              <p className="text-sm text-muted-foreground">
                {firstAccess
                  ? "Primeiro acesso: defina o usuário e a senha que vão proteger o NetInventory."
                  : "Entre com seu usuário e senha para acessar o painel da rede."}
              </p>
            </div>
            <LoginForm mode={firstAccess ? "setup" : "login"} next={next ?? "/"} />
          </div>
        </div>
      </section>
    </main>
  );
}
