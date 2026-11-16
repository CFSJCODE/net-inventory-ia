"use server";

import { prisma } from "@/lib/prisma";
import { requirePermission, requireSession } from "@/lib/auth/server";
import { latestHealth, pollSwitchHealthNow } from "@/lib/network/switch-health/poller";
import { bucketSeries, correlations, portWindows, SWITCH_HEALTH_RANGES, type PortWindow, type SeriesPoint, type SwitchHealthRange } from "@/lib/network/switch-health/series";
import { getSwitchHealthSettings, saveSwitchHealthSettings, type SwitchHealthSettings } from "@/lib/network/switch-health/settings";
import type { Correlation, PortRates } from "@/lib/network/switch-health/counters";
import type { ToolResult } from "./tool-actions";


export interface SwitchHealthView {
  settings: SwitchHealthSettings;
  /** Última rodada do coletor (taxas de cada porta agora); null antes da segunda rodada. */
  latest: {
    at: number;
    errorsPerMin: number | null;
    crcPerMin: number | null;
    discardsPerMin: number | null;
    inBps: number | null;
    outBps: number | null;
    latencyMs: number | null;
    gatewayLatencyMs: number | null;
    worstPort: string | null;
    ports: PortRates[];
    error: string | null;
  } | null;
  rangeHours: SwitchHealthRange;
  stepMs: number;
  series: SeriesPoint[];
  correlation: { lan: Correlation; gateway: Correlation };
  /** Portas na janela (os dados por porta ficam 48 h: em 7 dias, cobre as últimas 48 h). */
  ports: PortWindow[];
  samples: number;
}

async function run<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getSwitchHealth(equipmentId: string, rangeHours: number): Promise<ToolResult<SwitchHealthView>> {
  return run(async () => {
    await requireSession();
    const range = (SWITCH_HEALTH_RANGES as readonly number[]).includes(rangeHours) ? (rangeHours as SwitchHealthRange) : 1;
    const to = Date.now();
    const from = to - range * 3_600_000;
    const [settings, rows, portRows] = await Promise.all([
      getSwitchHealthSettings(),
      prisma.switchHealthSample.findMany({
        where: { equipmentId, at: { gte: new Date(from) } },
        orderBy: { at: "asc" },
        select: { at: true, intervalSec: true, errorsPerMin: true, crcPerMin: true, discardsPerMin: true, inBps: true, outBps: true, latencyMs: true, gatewayLatencyMs: true },
      }),
      prisma.switchPortSample.findMany({
        where: { equipmentId, at: { gte: new Date(from) } },
        select: { ifIndex: true, name: true, inErrors: true, outErrors: true, inDiscards: true, outDiscards: true, crcErrors: true, errorsPerMin: true, utilPct: true },
      }),
    ]);
    const { stepMs, points } = bucketSeries(rows, from, to);
    const live = latestHealth(equipmentId);
    return {
      settings,
      latest: live
        ? {
            at: live.at,
            errorsPerMin: live.errorsPerMin,
            crcPerMin: live.crcPerMin,
            discardsPerMin: live.discardsPerMin,
            inBps: live.inBps,
            outBps: live.outBps,
            latencyMs: live.latencyMs,
            gatewayLatencyMs: live.gatewayLatencyMs,
            worstPort: live.worstPort,
            ports: live.ports,
            error: live.error,
          }
        : null,
      rangeHours: range,
      stepMs,
      series: points,
      correlation: correlations(rows),
      ports: portWindows(portRows),
      samples: rows.length,
    };
  });
}

export async function updateSwitchHealthSettings(input: SwitchHealthSettings): Promise<ToolResult<SwitchHealthSettings>> {
  return run(async () => {
    await requirePermission("settings.manage");
    const saved = await saveSwitchHealthSettings(input);
    // Ligou agora: a primeira rodada já serve de base para a próxima.
    if (saved.enabled) void pollSwitchHealthNow();
    return saved;
  });
}
