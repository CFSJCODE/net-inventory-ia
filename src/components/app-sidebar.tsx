"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { LogOut, UserRound } from "lucide-react";
import { logout } from "@/app/actions/auth-actions";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { LayoutGridIcon } from "@/components/ui/layout-grid";
import { HistoryIcon } from "@/components/ui/history";
import { SettingsIcon } from "@/components/ui/settings";
import { WaypointsIcon } from "@/components/ui/waypoints";
import { WrenchIcon } from "@/components/ui/wrench";
import { BotMessageSquareIcon } from "@/components/ui/bot-message-square";
import type { AnimatedIcon, AnimatedIconHandle } from "@/components/page-title";
import { useAiStatus } from "@/components/ai/ai-common";
import { useCurrentUser } from "@/components/auth/user-provider";
import { ShieldCheckIcon } from "@/components/ui/shield-check";
import { can, type Permission } from "@/lib/auth/permissions";

interface NavItem {
  href: string;
  label: string;
  icon: AnimatedIcon;
  /** Selo curto à direita do nome (ex: "IA"), para destacar o item sem mudar o ícone. */
  badge?: string;
  /** Depende da chave da OpenAI: fica desabilitado enquanto não houver chave cadastrada. */
  requiresAi?: boolean;
  /** Só aparece para quem tem esta permissão (ex.: Usuários, só para administradores). */
  permission?: Permission;
  children?: { href: string; label: string }[];
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Inventário", icon: LayoutGridIcon },
  {
    href: "/topology",
    label: "Topologia",
    icon: WaypointsIcon,
    children: [
      { href: "/topology", label: "Mapa" },
      { href: "/topology/links", label: "Ligações monitoradas" },
    ],
  },
  { href: "/history", label: "Histórico", icon: HistoryIcon },
  { href: "/assistant", label: "Assistente", icon: BotMessageSquareIcon, badge: "IA", requiresAi: true },
  { href: "/tools", label: "Ferramentas", icon: WrenchIcon },
  { href: "/users", label: "Usuários", icon: ShieldCheckIcon, permission: "users.manage" },
  { href: "/settings", label: "Configurações", icon: SettingsIcon },
];

/**
 * Item ativo: sem fundo, só uma barra verde vertical à esquerda e o ícone verde. A barra é um
 * ::before que aparece com data-active; o hover continua com o fundo padrão da sidebar.
 */
const ACTIVE_BAR =
  "before:absolute before:rounded-full before:bg-primary before:opacity-0 before:transition-opacity before:content-['']";

/** Item do menu cujo ícone anima ao passar o mouse em qualquer parte do item, não só no ícone. */
function NavItemButton({ item, isActive, disabledReason }: { item: NavItem; isActive: boolean; disabledReason?: string | null }) {
  const disabled = !!disabledReason;
  const iconRef = useRef<AnimatedIconHandle>(null);
  const Icon = item.icon;
  const label = item.badge ? `${item.label} ${item.badge}` : item.label;
  return (
    <SidebarMenuButton
      // Desabilitado: vira texto sem link (não navega nem por teclado) e mostra o motivo no tooltip.
      render={disabled ? <span aria-disabled /> : <Link href={item.href} />}
      isActive={isActive}
      tooltip={disabled ? `${label} — ${disabledReason}` : label}
      className={cn(
        "relative data-active:bg-transparent data-active:text-sidebar-foreground data-active:hover:bg-sidebar-accent",
        ACTIVE_BAR,
        "before:inset-y-1.5 before:left-0 before:w-[3px] data-active:before:opacity-100",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
      onMouseEnter={() => iconRef.current?.startAnimation()}
      onMouseLeave={() => iconRef.current?.stopAnimation()}
    >
      <Icon ref={iconRef} size={16} className={cn("shrink-0", isActive && "text-primary")} />
      <span>{item.label}</span>
      {item.badge && (
        // ml-auto empurra o selo para a direita; some com a sidebar recolhida (só ícones).
        <span className="ml-auto rounded-full border border-primary/40 bg-primary/10 px-1.5 py-px text-[10px] leading-none font-semibold tracking-wide text-primary group-data-[collapsible=icon]:hidden">
          {item.badge}
        </span>
      )}
    </SidebarMenuButton>
  );
}

export function AppSidebar({ username }: { username: string }) {
  const pathname = usePathname();
  const { data: ai } = useAiStatus();
  const role = useCurrentUser()?.role;

  function disabledReason(item: NavItem): string | null {
    if (!item.requiresAi) return null;
    if (!can(role, "ai.use")) return "seu perfil de acesso não inclui IA";
    if (ai?.configured === false) return "configure a IA em Configurações";
    return null;
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link href="/" className="flex items-center gap-2 px-2 py-1.5 font-semibold">
          <Image src="/logo.png" alt="NetInventory" width={20} height={20} className="shrink-0" />
          <span className="truncate group-data-[collapsible=icon]:hidden">NetInventory</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.filter((item) => !item.permission || can(role, item.permission)).map((item) => (
                <SidebarMenuItem key={item.href}>
                  <NavItemButton
                    item={item}
                    // Item com submenu fica ativo em qualquer página da seção (ex: /topology/links).
                    isActive={item.children ? pathname.startsWith(item.href) : pathname === item.href}
                    disabledReason={disabledReason(item)}
                  />
                  {item.children && (
                    <SidebarMenuSub>
                      {item.children.map((child) => (
                        // A barra do subitem fica sobre a linha vertical do submenu (border-l do <ul>),
                        // que está 11px à esquerda do item (1px de borda + 10px de padding).
                        <SidebarMenuSubItem key={child.href} className={cn("relative", ACTIVE_BAR, "before:inset-y-0.5 before:-left-3 before:w-[3px] has-[[data-active]]:before:opacity-100")}>
                          <SidebarMenuSubButton
                            render={<Link href={child.href} />}
                            isActive={pathname === child.href}
                            className="data-active:bg-transparent data-active:font-medium data-active:text-sidebar-foreground data-active:hover:bg-sidebar-accent"
                          >
                            <span>{child.label}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link href="/account" />} isActive={pathname === "/account"} tooltip={`Minha conta (${username})`} className="text-muted-foreground">
              <UserRound size={16} className="shrink-0" />
              <span className="flex-1 truncate">{username}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <form action={logout}>
              <SidebarMenuButton type="submit" tooltip="Sair" className="text-muted-foreground">
                <LogOut size={16} className="shrink-0" />
                <span>Sair</span>
              </SidebarMenuButton>
            </form>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
