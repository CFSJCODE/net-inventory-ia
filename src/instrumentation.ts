/** Executado uma vez quando o servidor Next sobe: inicia os serviços de fundo. */
export async function register() {
  // O monitor usa ping/sockets do Node, então só roda no runtime Node (não no Edge).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startLinkMonitor } = await import("@/lib/network/link-monitor");
    const { startScanScheduler } = await import("@/lib/scan-scheduler");
    const { mergeDuplicateDevices } = await import("@/lib/device-merge");
    startLinkMonitor();
    startScanScheduler();
    // Funde duplicados gravados por versões anteriores logo ao subir, sem esperar o próximo scan.
    void mergeDuplicateDevices().catch((err) => console.error("[device-merge] falha ao fundir duplicados:", err));
  }
}
