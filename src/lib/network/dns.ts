import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { createSystemResolver } from "./system-dns";

const execFileAsync = promisify(execFile);

function isLocalIp(ip: string): boolean {
  return Object.values(os.networkInterfaces()).some((addrs) => addrs?.some((a) => a.address === ip));
}

// O resolver padrão do Node pode apontar para um DNS que o Windows nem usa (ex: 127.0.0.1); usamos
// os servidores reais dos adaptadores. O resolver é criado uma vez por processo do servidor.
let systemResolver: Promise<dns.Resolver> | null = null;

async function reverseDns(ip: string, resolver?: dns.Resolver): Promise<string | null> {
  try {
    systemResolver ??= createSystemResolver();
    const names = await (resolver ?? (await systemResolver)).reverse(ip);
    return names[0]?.replace(/\.$/, "") ?? null;
  } catch {
    return null;
  }
}

/**
 * Fallback via NetBIOS (nbtstat), útil para máquinas Windows na LAN.
 * A saída do nbtstat é localizada (UNIQUE/GROUP em inglês, EXCLUSIVO/GRUPO em pt-BR...),
 * então pegamos o primeiro nome <00> que não seja de grupo, sem depender do idioma. O comando
 * consulta todas as interfaces de rede em sequência e costuma levar 4-5s, daí o timeout folgado.
 */
async function netbiosName(ip: string): Promise<string | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync("nbtstat", ["-A", ip], { timeout: 8000 });
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*(\S[^<]*?)\s*<00>\s+(\S+)/);
      if (match && !/^gr/i.test(match[2])) return match[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve o hostname de um IP tentando DNS reverso (servidor do SO e, se informado, o DNS do
 * gateway — que em muitos roteadores conhece os nomes dos clientes DHCP) e, em seguida, NetBIOS.
 */
export async function resolveHostname(ip: string, gatewayResolver?: dns.Resolver): Promise<string | null> {
  // A própria máquina que escaneia não responde a si mesma via NetBIOS; usa o nome do SO.
  if (isLocalIp(ip)) return os.hostname();
  const viaDns = (await reverseDns(ip)) ?? (gatewayResolver ? await reverseDns(ip, gatewayResolver) : null);
  if (viaDns) return viaDns;
  return netbiosName(ip);
}

/** Cria um resolver DNS apontando direto para o gateway (ignora o DNS configurado no SO). */
export function createGatewayResolver(gatewayIp: string): dns.Resolver {
  const resolver = new dns.Resolver({ timeout: 1500, tries: 1 });
  resolver.setServers([gatewayIp]);
  return resolver;
}
