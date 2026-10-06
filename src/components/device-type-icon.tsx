import type { ComponentType } from "react";
import { Monitor, Laptop, Printer, Network, Smartphone, Video, Tv, Cpu } from "lucide-react";
import { RouterIcon } from "@/components/ui/router";
import { ServerIcon } from "@/components/ui/server";
import { CircleHelpIcon } from "@/components/ui/circle-help";
import { CctvIcon } from "@/components/ui/cctv";
import type { DeviceType } from "@prisma/client";

type IconComponent = ComponentType<{
  size?: number;
  className?: string;
  "aria-label"?: string;
}>;

const ICONS: Record<DeviceType, IconComponent> = {
  COMPUTER: Monitor,
  NOTEBOOK: Laptop,
  MOBILE: Smartphone,
  PRINTER: Printer,
  CAMERA: CctvIcon,
  NVR: Video,
  SWITCH: Network,
  ROUTER: RouterIcon,
  SERVER: ServerIcon,
  SMART_TV: Tv,
  IOT: Cpu,
  UNKNOWN: CircleHelpIcon,
};

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  COMPUTER: "Computador",
  NOTEBOOK: "Notebook",
  MOBILE: "Celular",
  PRINTER: "Impressora",
  CAMERA: "Câmera IP",
  NVR: "NVR",
  SWITCH: "Switch",
  ROUTER: "Roteador",
  SERVER: "Servidor",
  SMART_TV: "Smart TV",
  IOT: "Dispositivo IoT",
  UNKNOWN: "Desconhecido",
};

export function DeviceTypeIcon({
  type,
  size = 16,
  className,
}: {
  type: DeviceType;
  size?: number;
  className?: string;
}) {
  const Icon = ICONS[type];
  return <Icon size={size} className={className} aria-label={DEVICE_TYPE_LABELS[type]} />;
}
