import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const isWindows = process.platform === "win32";

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Executa um script PowerShell e devolve o resultado como JSON. Usamos cmdlets com saída
 * estruturada (Get-NetNeighbor, Get-NetRoute, CIM) em vez de parsear `arp -a`/`route print`,
 * cuja saída é traduzida conforme o idioma do Windows. O ConvertTo-Json devolve um objeto
 * solto quando há um único item, então sempre normalizamos para array.
 */
export async function runPowerShellJson<T>(script: string, timeoutMs = 15000): Promise<T[]> {
  const command = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script} | ConvertTo-Json -Depth 4 -Compress`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  const text = stdout.trim();
  return text ? toArray(JSON.parse(text) as T | T[]) : [];
}

/** Executa um comando `ip -j ...` (iproute2) no Linux e devolve o JSON. */
export async function runIpJson<T>(args: string[]): Promise<T[]> {
  const { stdout } = await execFileAsync("ip", ["-j", ...args], { timeout: 10000 });
  const text = stdout.trim();
  return text ? toArray(JSON.parse(text) as T | T[]) : [];
}
