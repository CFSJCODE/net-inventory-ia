import net from "node:net";
import { mapWithConcurrency } from "./concurrency";

/**
 * Portas usadas só para provar que um host está ligado quando ele não responde ao ping.
 * Windows com firewall padrão descarta ICMP, mas costuma expor RDP/SMB/RPC; outros
 * aparelhos costumam ter SSH ou HTTP. Uma conexão recusada (RST) também prova que o host existe.
 */
export const LIVENESS_PORTS = [135, 139, 445, 3389, 5985, 22, 80, 443, 8080, 62078] as const;

/** Resolve `true` se o host respondeu na porta, seja aceitando a conexão ou recusando-a. */
function portAnswers(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const finish = (alive: boolean) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(alive);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", (err: NodeJS.ErrnoException) => finish(err.code === "ECONNREFUSED"));
    socket.connect(port, ip);
  });
}

/** Testa as portas em paralelo e retorna assim que qualquer uma provar que o host está ligado. */
export function isAliveViaTcp(
  ip: string,
  ports: readonly number[] = LIVENESS_PORTS,
  timeoutMs = 700,
): Promise<boolean> {
  if (ports.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let pending = ports.length;
    for (const port of ports) {
      portAnswers(ip, port, timeoutMs).then((alive) => {
        if (alive) resolve(true);
        else if (--pending === 0) resolve(false);
      });
    }
  });
}

/** Sonda TCP para os IPs que não responderam ao ping; retorna os que estão ligados. */
export async function tcpSweep(
  ips: string[],
  options: { concurrency?: number; timeoutMs?: number; ports?: readonly number[] } = {},
): Promise<string[]> {
  const { concurrency = 64, timeoutMs = 700, ports = LIVENESS_PORTS } = options;
  const alive = await mapWithConcurrency(ips, concurrency, async (ip) =>
    (await isAliveViaTcp(ip, ports, timeoutMs)) ? ip : null,
  );
  return alive.filter((ip): ip is string => ip !== null);
}
