import net from "node:net";

/** Portas relevantes para heurística de classificação de dispositivos. */
export const CLASSIFICATION_PORTS = [22, 80, 443, 445, 554, 631, 1883, 3389, 8000, 8008, 8009, 9100] as const;

function checkPort(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const finish = (open: boolean) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, ip);
  });
}

/** Testa um pequeno conjunto de portas TCP comuns para ajudar na classificação do dispositivo. */
export async function scanCommonPorts(ip: string, timeoutMs = 400): Promise<number[]> {
  const results = await Promise.all(
    CLASSIFICATION_PORTS.map(async (port) => ({ port, open: await checkPort(ip, port, timeoutMs) })),
  );
  return results.filter((r) => r.open).map((r) => r.port);
}
