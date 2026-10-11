"use client";

import { useEffect, useRef, type ComponentType, type HTMLAttributes, type RefAttributes } from "react";
import { usePathname } from "next/navigation";
import { LayoutGridIcon } from "@/components/ui/layout-grid";
import { WaypointsIcon } from "@/components/ui/waypoints";
import { ActivityIcon } from "@/components/ui/activity";
import { HistoryIcon } from "@/components/ui/history";
import { WrenchIcon } from "@/components/ui/wrench";
import { SettingsIcon } from "@/components/ui/settings";
import { ShieldCheckIcon } from "@/components/ui/shield-check";
import { UserIcon } from "@/components/ui/user";
import { CpuIcon } from "@/components/ui/cpu";
import { BotMessageSquareIcon } from "@/components/ui/bot-message-square";
import { RouterIcon } from "@/components/ui/router";

/** Contrato comum dos ícones do lucide-animated: animam sozinhos no hover ou sob comando via ref. */
export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}
export type AnimatedIcon = ComponentType<HTMLAttributes<HTMLDivElement> & { size?: number } & RefAttributes<AnimatedIconHandle>>;

interface PageMeta {
  title: string;
  icon: AnimatedIcon;
}

const PAGES: Record<string, PageMeta> = {
  "/": { title: "Inventário de rede", icon: LayoutGridIcon },
  "/topology": { title: "Topologia da rede", icon: WaypointsIcon },
  "/topology/links": { title: "Ligações monitoradas", icon: ActivityIcon },
  "/history": { title: "Histórico", icon: HistoryIcon },
  "/assistant": { title: "Assistente IA", icon: BotMessageSquareIcon },
  "/tools": { title: "Ferramentas de rede", icon: WrenchIcon },
  "/equipment": { title: "Equipamentos", icon: RouterIcon },
  "/settings": { title: "Configurações", icon: SettingsIcon },
  "/users": { title: "Usuários e acessos", icon: ShieldCheckIcon },
  "/account": { title: "Minha conta", icon: UserIcon },
};

function metaFor(pathname: string): PageMeta {
  if (PAGES[pathname]) return PAGES[pathname];
  if (pathname.startsWith("/devices/")) return { title: "Detalhes do dispositivo", icon: CpuIcon };
  return { title: "NetInventory", icon: LayoutGridIcon };
}

/** Título da página atual no header fixo, com o ícone verde da seção (anima ao trocar de página). */
export function PageTitle() {
  const pathname = usePathname();
  const { title, icon: Icon } = metaFor(pathname);
  const iconRef = useRef<AnimatedIconHandle>(null);

  useEffect(() => {
    iconRef.current?.startAnimation();
  }, [pathname]);

  return (
    <div
      className="flex min-w-0 items-center gap-2"
      onMouseEnter={() => iconRef.current?.startAnimation()}
      onMouseLeave={() => iconRef.current?.stopAnimation()}
    >
      <Icon key={pathname} ref={iconRef} size={18} className="shrink-0 text-primary" />
      <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
    </div>
  );
}
