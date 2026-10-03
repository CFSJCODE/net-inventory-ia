import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mapWithConcurrency } from "./concurrency";

const execFileAsync = promisify(execFile);

async function pingOnce(ip: string, timeoutMs: number): Promise<boolean> {
  const isWindows = process.platform === "win32";
  const args = isWindows
    ? ["-n", "1", "-w", String(timeoutMs), ip]
    : ["-c", "1", "-W", String(Math.max(1, Math.round(timeoutMs / 1000))), ip];

  try {
    const { stdout } = await execFileAsync("ping", args, { timeout: timeoutMs + 1000 });
    return /ttl=/i.test(stdout);
  } catch {
    return false;
  }
}

/** Faz um ping sweep nos IPs informados e retorna os que responderam. */
export async function pingSweep(
  ips: string[],
  options: { concurrency?: number; timeoutMs?: number } = {},
): Promise<string[]> {
  const { concurrency = 40, timeoutMs = 600 } = options;
  const alive = await mapWithConcurrency(ips, concurrency, async (ip) => {
    const isAlive = await pingOnce(ip, timeoutMs);
    return isAlive ? ip : null;
  });
  return alive.filter((ip): ip is string => ip !== null);
}
