"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartNoAxesCombined, MessageSquare, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { href: "/assistant/settings", label: "Configuração da IA", icon: Settings2 },
  { href: "/assistant/usage", label: "Uso e limites", icon: ChartNoAxesCombined },
  { href: "/assistant", label: "Chat", icon: MessageSquare },
];

export function AssistantNavigation() {
  const pathname = usePathname();
  return (
    <nav aria-label="Submenus do Assistente IA" className="grid grid-cols-1 gap-2 rounded-xl border bg-card p-2 sm:grid-cols-3">
      {SECTIONS.map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}
          className={cn("flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            pathname === href ? "bg-primary/10 text-primary" : "text-muted-foreground")}>
          <Icon className="size-4" />{label}
        </Link>
      ))}
    </nav>
  );
}
