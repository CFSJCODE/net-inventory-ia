"use server";

import { requirePermission, requireSession } from "@/lib/auth/server";
import { buildTopology, type Topology } from "@/lib/network/topology";
import type { ToolResult } from "./tool-actions";

export async function getTopology(snmpCommunity: string | null): Promise<ToolResult<Topology>> {
  // Com community, a topologia consulta os switches via SNMP — isso é operar a rede, não só ler o inventário.
  if (snmpCommunity?.trim()) await requirePermission("network.operate");
  else await requireSession();
  try {
    return { ok: true, data: await buildTopology({ snmpCommunity: snmpCommunity?.trim() || undefined }) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
