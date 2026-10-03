"use client";

import { useRef } from "react";
import type { AnimatedIcon, AnimatedIconHandle } from "@/components/page-title";
import { RadioTowerIcon } from "@/components/ui/radio-tower";
import { WaypointsIcon } from "@/components/ui/waypoints";
import { WrenchIcon } from "@/components/ui/wrench";
import { SparklesIcon } from "@/components/ui/sparkles";
import { BellIcon } from "@/components/ui/bell";

const FEATURES: { icon: AnimatedIcon; title: string; description: string }[] = [
  { icon: RadioTowerIcon, title: "Descoberta automática", description: "Inventário da rede com scans agendados, IPv4, IPv6, MAC e fabricante" },
  { icon: WaypointsIcon, title: "Topologia e ligações", description: "Mapa interativo da rede e monitoramento contínuo dos links" },
  { icon: WrenchIcon, title: "Ferramentas de rede", description: "ARP e port scan, SNMP, Wake-on-LAN, DNS, DHCP e rotas" },
  { icon: SparklesIcon, title: "Assistente com IA", description: "Identificação de dispositivos, análise de segurança e resumos" },
  { icon: BellIcon, title: "Alertas em tempo real", description: "Notificações quando um link cai ou um dispositivo novo aparece" },
];

/** Card de funcionalidade: o ícone anima ao passar o mouse em qualquer parte do card. */
function FeatureCard({ icon: Icon, title, description }: (typeof FEATURES)[number]) {
  const iconRef = useRef<AnimatedIconHandle>(null);
  return (
    <li
      onMouseEnter={() => iconRef.current?.startAnimation()}
      onMouseLeave={() => iconRef.current?.stopAnimation()}
      className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 backdrop-blur-sm transition-colors hover:border-primary/40 hover:bg-white/[0.09]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
        <Icon ref={iconRef} size={18} />
      </span>
      <span className="flex flex-col">
        <span className="text-sm font-medium text-white">{title}</span>
        <span className="text-xs text-white/65">{description}</span>
      </span>
    </li>
  );
}

export function LoginFeatures() {
  return (
    <ul className="flex flex-col gap-3">
      {FEATURES.map((f) => (
        <FeatureCard key={f.title} {...f} />
      ))}
    </ul>
  );
}
