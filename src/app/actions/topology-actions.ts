"use server";

import { requirePermission, requireSession } from "@/lib/auth/server";
import { can } from "@/lib/auth/permissions";
import { buildTopology, type Topology } from "@/lib/network/topology";
import type { ToolResult } from "./tool-actions";

export async function getTopology(snmpCommunity: string | null): Promise<ToolResult<Topology>> {
  // Com community, a topologia consulta os switches via SNMP — isso é operar a rede, não só ler o inventário.
  const user = snmpCommunity?.trim() ? await requirePermission("network.operate") : await requireSession();
  try {
    const topology = await buildTopology({ snmpCommunity: snmpCommunity?.trim() || undefined });
    if (!can(user.role, "network.operate")) delete topology.snmpCommunity;
    return { ok: true, data: topology };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
