import type { Device } from "@prisma/client";
import { DEVICE_TYPE_LABELS } from "@/components/device-type-icon";
import type { DeviceSortKey, SortDirection } from "@/store/ui-store";
import { displayName } from "@/lib/device-name";

function ipToComparable(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return 0;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function valueFor(device: Device, key: DeviceSortKey): string | number {
  switch (key) {
    case "hostname":
      return displayName(device, "");
    case "ip":
      return ipToComparable(device.ip);
    case "type":
      return DEVICE_TYPE_LABELS[device.type];
    case "vendor":
      return device.vendor ?? "";
    case "status":
      return device.status;
    case "lastSeenAt":
      return new Date(device.lastSeenAt).getTime();
  }
}

export function sortDevices(devices: Device[], key: DeviceSortKey, direction: SortDirection): Device[] {
  const sorted = [...devices].sort((a, b) => compareValues(valueFor(a, key), valueFor(b, key)));
  return direction === "asc" ? sorted : sorted.reverse();
}
