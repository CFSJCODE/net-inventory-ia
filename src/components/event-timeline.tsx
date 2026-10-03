import { PlusCircle, ArrowRightLeft, Tag, PowerOff, Power, Unplug, Cable, type LucideIcon } from "lucide-react";
import type { DeviceEventType } from "@prisma/client";
import { formatDateTime, formatRelativeTime } from "@/lib/format-time";
import Link from "next/link";
import { displayName } from "@/lib/device-name";

const EVENT_ICONS: Record<DeviceEventType, LucideIcon> = {
  DEVICE_DISCOVERED: PlusCircle,
  IP_CHANGED: ArrowRightLeft,
  HOSTNAME_CHANGED: Tag,
  WENT_OFFLINE: PowerOff,
  WENT_ONLINE: Power,
  LINK_DOWN: Unplug,
  LINK_UP: Cable,
};

const EVENT_COLORS: Record<DeviceEventType, string> = {
  DEVICE_DISCOVERED: "text-blue-500",
  IP_CHANGED: "text-amber-500",
  HOSTNAME_CHANGED: "text-amber-500",
  WENT_OFFLINE: "text-zinc-400",
  WENT_ONLINE: "text-emerald-500",
  LINK_DOWN: "text-red-500",
  LINK_UP: "text-emerald-500",
};

export interface TimelineEvent {
  id: string;
  type: DeviceEventType;
  message: string;
  createdAt: string | Date;
  device?: { id: string; hostname: string | null; alias?: string | null; ip: string } | null;
}

export function EventTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum evento registrado ainda.</p>;
  }

  return (
    <ol className="flex flex-col gap-4">
      {events.map((event) => {
        const Icon = EVENT_ICONS[event.type];
        return (
          <li key={event.id} className="flex gap-3">
            <div className={`mt-0.5 ${EVENT_COLORS[event.type]}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex flex-1 flex-col gap-0.5">
              <p className="text-sm">
                {event.device ? (
                  <Link href={`/devices/${event.device.id}`} className="font-medium hover:underline">
                    {displayName(event.device, event.device.ip)}
                  </Link>
                ) : null}{" "}
                {event.message}
              </p>
              <time className="text-xs text-muted-foreground" title={formatDateTime(event.createdAt)}>
                {formatRelativeTime(event.createdAt)}
              </time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
