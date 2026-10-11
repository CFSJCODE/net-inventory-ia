"use server";

import { requirePermission } from "@/lib/auth/server";
import { readEquipmentStatus, type EquipmentStatus } from "@/lib/network/equipment-status";
import type { ToolResult } from "./tool-actions";

const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function assertHost(host: string): string {
  const v = host.trim();
  if (IPV4_RE.test(v) || HOSTNAME_RE.test(v)) return v;
  throw new Error("Host inválido.");
}

export async function runEquipmentStatus(input: {
  host: string;
  community: string;
}): Promise<ToolResult<EquipmentStatus>> {
  await requirePermission("network.operate");
  try {
    const data = await readEquipmentStatus(assertHost(input.host), input.community || "public");
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
