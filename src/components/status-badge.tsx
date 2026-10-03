import { Badge } from "@/components/ui/badge";
import type { DeviceStatus } from "@prisma/client";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: DeviceStatus }) {
  const isOnline = status === "ONLINE";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-normal",
        isOnline
          ? "border-emerald-900 bg-emerald-950 text-emerald-400"
          : "border-zinc-800 bg-zinc-900 text-zinc-400",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", isOnline ? "bg-emerald-500" : "bg-zinc-400")} />
      {isOnline ? "Online" : "Offline"}
    </Badge>
  );
}
