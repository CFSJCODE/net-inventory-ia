import type { Metadata } from "next";
import { Open_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AppSidebar } from "@/components/app-sidebar";
import { AiOnboardingDialog } from "@/components/ai/ai-onboarding-dialog";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { TopLoadingBar } from "@/components/top-loading-bar";
import { PageTitle } from "@/components/page-title";
import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser, getSession } from "@/lib/auth/server";
import { UserProvider } from "@/components/auth/user-provider";
import { NotificationsListener } from "@/components/notifications-listener";

const openSans = Open_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NetInventory",
  description: "Descoberta automática e inventário da rede local",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // O middleware só deixa passar sem sessão a tela de login, que é exibida sem sidebar/header.
  const user = await getCurrentUser();
  // Cookie válido, mas usuário desativado/removido ou senha trocada: volta ao login. Na própria tela de
  // login o middleware não roda (sem x-pathname), então não há redirecionamento em loop.
  if (!user && (await getSession()) && (await headers()).get("x-pathname")) redirect("/login");

  return (
    <html
      lang="pt-BR"
      className={`${openSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* Extensões do navegador (Grammarly, ColorZilla...) injetam atributos no <body> antes da hidratação.
          suppressHydrationWarning ignora só os atributos deste elemento, não os filhos. */}
      <body className="min-h-full bg-background text-foreground" suppressHydrationWarning>
        <Providers>
          {/* Suspense: a barra lê useSearchParams, que exige um boundary para não desligar a renderização estática. */}
          <Suspense fallback={null}>
            <TopLoadingBar />
          </Suspense>
          {!user ? (
            children
          ) : (
          <UserProvider user={user}>
          <SidebarProvider>
            <NotificationsListener />
            <AiOnboardingDialog />
            <AppSidebar username={user.username} />
            {/* min-w-0: sem isso o conteúdo cresce com tabelas largas e a página inteira rola na horizontal. */}
            <SidebarInset className="min-w-0">
              <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
                <SidebarTrigger />
                <Separator orientation="vertical" className="h-4" />
                <PageTitle />
              </header>
              <div className="flex-1">{children}</div>
            </SidebarInset>
          </SidebarProvider>
          </UserProvider>
          )}
        </Providers>
      </body>
    </html>
  );
}
