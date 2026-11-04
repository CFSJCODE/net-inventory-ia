import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/server";
import { HomeOverview } from "@/components/home-overview";

/**
 * Tela inicial (netinventory.local/): apresenta o app, um resumo da rede e cada menu do painel.
 * O inventário fica em /inventory.
 */
export default async function Home() {
  const user = await getCurrentUser();
  const [devices, online, linksDown] = await Promise.all([
    prisma.device.count(),
    prisma.device.count({ where: { status: "ONLINE" } }),
    prisma.topologyLink.count({ where: { status: "DOWN" } }),
  ]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-3 py-8">
      <HomeOverview role={user?.role ?? null} summary={{ devices, online, linksDown }} />
    </div>
  );
}
