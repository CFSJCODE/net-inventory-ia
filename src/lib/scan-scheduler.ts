import { prisma } from "@/lib/prisma";
import { isScanRunning, runConfiguredScan } from "@/lib/scan-service";

const TICK_MS = 60_000;

const state = globalThis as typeof globalThis & { __scanSchedulerTimer?: NodeJS.Timeout };

/** Roda o scan configurado se o intervalo automático estiver ligado e o último scan já estiver vencido. */
async function tick(): Promise<void> {
  try {
    const config = await prisma.scanConfig.findFirst();
    if (!config?.intervalMinutes || isScanRunning()) return;
    const due = !config.lastRunAt || Date.now() - config.lastRunAt.getTime() >= config.intervalMinutes * 60_000;
    if (!due) return;
    const result = await runConfiguredScan();
    console.log(`[scan-scheduler] scan automático: ${result.devicesFound} dispositivo(s), ${result.newDevices} novo(s)`);
  } catch (err) {
    console.error("[scan-scheduler] falha no scan automático:", err);
  }
}

/** Inicia o agendador (uma vez por processo, via instrumentation). Checa a cada minuto. */
export function startScanScheduler(): void {
  if (state.__scanSchedulerTimer) return;
  state.__scanSchedulerTimer = setInterval(() => void tick(), TICK_MS);
  console.log("[scan-scheduler] ativo (verifica a cada 60s)");
}
