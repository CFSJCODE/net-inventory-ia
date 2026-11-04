"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LayoutGridIcon } from "@/components/ui/layout-grid";
import { HistoryIcon } from "@/components/ui/history";
import { SettingsIcon } from "@/components/ui/settings";
import { BellIcon } from "@/components/ui/bell";
import { WaypointsIcon } from "@/components/ui/waypoints";
import { WrenchIcon } from "@/components/ui/wrench";
import { RouterIcon } from "@/components/ui/router";
import { BotMessageSquareIcon } from "@/components/ui/bot-message-square";
import { ShieldCheckIcon } from "@/components/ui/shield-check";
import { ServerIcon } from "@/components/ui/server";
import type { AnimatedIcon, AnimatedIconHandle } from "@/components/page-title";
import { can, type Permission, type UserRole } from "@/lib/auth/permissions";

interface Section {
  href: string;
  title: string;
  description: string;
  icon: AnimatedIcon;
  permission?: Permission;
  /** Só existe com o host .NET (agentes Windows); some no painel rodando sozinho. */
  dotnetOnly?: boolean;
  links?: { href: string; label: string }[];
}

// Mesma ordem e nomes da barra lateral, cada um com o que a seção faz.
const SECTIONS: Section[] = [
  { href: "/inventory", title: "Inventário", icon: LayoutGridIcon, description: "Todos os dispositivos descobertos na rede, com IP, MAC, fabricante, tipo e status." },
  {
    href: "/topology", title: "Topologia", icon: WaypointsIcon, description: "Mapa interativo da rede e o estado das ligações entre os equipamentos.",
    links: [{ href: "/topology", label: "Mapa" }, { href: "/topology/links", label: "Ligações monitoradas" }],
  },
  { href: "/history", title: "Histórico", icon: HistoryIcon, description: "Linha do tempo de novos dispositivos, mudanças de IP e quedas de ligação." },
  {
    href: "/assistant", title: "Assistente", icon: BotMessageSquareIcon, permission: "ai.use", description: "IA para identificar dispositivos, analisar a segurança e responder sobre a rede.",
    links: [{ href: "/assistant/settings", label: "Configuração da IA" }, { href: "/assistant/usage", label: "Uso e limites" }, { href: "/assistant", label: "Chat" }],
  },
  { href: "/tools", title: "Ferramentas", icon: WrenchIcon, description: "ARP e port scan, SNMP, Wake-on-LAN, DNS, DHCP e tabela de rotas." },
  { href: "/equipment", title: "Equipamentos", icon: RouterIcon, description: "Switches e roteadores lidos por SNMP: portas, CPU, memória e temperatura." },
  { href: "/alerts", title: "Alertas", icon: BellIcon, permission: "settings.manage", description: "Avisos por e-mail quando algo cai, volta ou passa dos limites." },
  { href: "/users", title: "Usuários", icon: ShieldCheckIcon, permission: "users.manage", description: "Contas de acesso ao painel e o perfil de cada uma." },
  { href: "/settings", title: "Configurações", icon: SettingsIcon, description: "Faixa e frequência do scan, regras de IP e preferências do painel." },
  {
    href: "/console/agents", title: "Servidor", icon: ServerIcon, dotnetOnly: true, description: "Agentes Windows, conexão, host e segurança do servidor.",
    links: [{ href: "/console/agents", label: "Agentes" }, { href: "/console/connection", label: "Conexão" }],
  },
];

/** Card de uma seção: o ícone anima ao passar o mouse em qualquer parte do card, como na barra lateral. */
function SectionCard({ section }: { section: Section }) {
  const iconRef = useRef<AnimatedIconHandle>(null);
  const Icon = section.icon;
  // As páginas do servidor são do host .NET, fora do roteador do Next: navegação completa.
  const external = section.href.startsWith("/console/");
  return (
    <Card
      className="relative transition-colors hover:ring-primary/40"
      onMouseEnter={() => iconRef.current?.startAnimation()}
      onMouseLeave={() => iconRef.current?.stopAnimation()}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon ref={iconRef} size={18} className="shrink-0 text-primary" />
          {external ? (
            <a href={section.href} className="after:absolute after:inset-0">{section.title}</a>
          ) : (
            <Link href={section.href} className="after:absolute after:inset-0">{section.title}</Link>
          )}
        </CardTitle>
        <CardDescription>{section.description}</CardDescription>
      </CardHeader>
      {section.links && (
        <CardContent className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {section.links.map((link) =>
            external ? (
              <a key={link.href} href={link.href} className="relative z-10 text-muted-foreground hover:text-foreground">{link.label}</a>
            ) : (
              <Link key={link.href} href={link.href} className="relative z-10 text-muted-foreground hover:text-foreground">{link.label}</Link>
            ),
          )}
        </CardContent>
      )}
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "bad" }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={tone === "bad" && value > 0 ? "text-2xl font-semibold text-destructive" : tone === "ok" ? "text-2xl font-semibold text-primary" : "text-2xl font-semibold"}>
        {value.toLocaleString("pt-BR")}
      </span>
    </div>
  );
}

export function HomeOverview({ role, summary }: { role: UserRole | null; summary: { devices: number; online: number; linksDown: number } }) {
  // O grupo Servidor só existe quando o painel roda atrás do host .NET (o /health dele diz isso).
  const [dotnet, setDotnet] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/health", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((health) => { if (alive) setDotnet(health?.implementation === "dotnet-host"); })
      .catch(() => { /* painel sem o host .NET: o card Servidor fica de fora */ });
    return () => { alive = false; };
  }, []);

  const sections = SECTIONS.filter((s) => (!s.permission || can(role, s.permission)) && (!s.dotnetOnly || dotnet));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3 text-xl">
            <Image src="/logo.png" alt="" width={28} height={28} className="shrink-0" />
            Bem-vindo ao NetInventory
          </CardTitle>
          <CardDescription className="max-w-3xl">
            Inventário, mapa e monitoramento da sua rede local num só painel. O NetInventory descobre sozinho os
            dispositivos da rede, acompanha quem está online, desenha a topologia e avisa quando algo muda.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end justify-between gap-6">
          <div className="flex gap-10">
            <Stat label="Dispositivos" value={summary.devices} />
            <Stat label="Online agora" value={summary.online} tone="ok" />
            <Stat label="Ligações fora do ar" value={summary.linksDown} tone="bad" />
          </div>
          <Link href="/inventory" className={buttonVariants()}>
            Abrir inventário
            <ArrowRight size={16} />
          </Link>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold tracking-tight">Menus do painel</h2>
        <p className="text-sm text-muted-foreground">Cada seção da barra lateral, e o que você encontra nela.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => (
          <SectionCard key={section.href} section={section} />
        ))}
      </div>
    </>
  );
}
