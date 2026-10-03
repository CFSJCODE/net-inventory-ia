/** Executado uma vez quando o servidor Next sobe: inicia os serviços de fundo. */
export async function register() {
  // O monitor usa ping/sockets do Node, então só roda no runtime Node (não no Edge).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startLinkMonitor } = await import("@/lib/network/link-monitor");
    const { startScanScheduler } = await import("@/lib/scan-scheduler");
    startLinkMonitor();
    startScanScheduler();
  }
}
