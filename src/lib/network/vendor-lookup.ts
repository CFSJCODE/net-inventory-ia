import { lookupVendorByMac } from "./oui-data";
import { isRandomizedMac } from "@/lib/mac";

const MACVENDORS_API = "https://api.macvendors.com/";
const REQUEST_TIMEOUT_MS = 2500;
// A API gratuita do macvendors.com é sensível a rajadas (429 "Too Many Requests"),
// então as consultas são feitas uma de cada vez com um respiro entre elas.
const REQUEST_DELAY_MS = 700;

/** Cache em memória (por prefixo OUI) da API externa, válido durante o tempo de vida do processo. */
const onlineCache = new Map<string, string | null>();

function ouiPrefix(mac: string): string {
  return mac.toUpperCase().replace(/-/g, ":").split(":").slice(0, 3).join(":");
}

export const RANDOMIZED_MAC_LABEL = "Endereço aleatório (privacidade)";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retorna string (fabricante encontrado), null (prefixo confirmadamente sem fabricante,
 * HTTP 404) ou undefined (falha temporária — rate limit, timeout, rede — não deve ser
 * cacheada, tenta de novo no próximo scan).
 */
async function fetchVendorFromApi(prefix: string): Promise<string | null | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${MACVENDORS_API}${prefix}`, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const text = (await res.text()).trim();
    return text || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve o fabricante de uma lista de MACs: primeiro pela tabela local (offline, instantânea),
 * depois via api.macvendors.com para os prefixos desconhecidos (uma consulta por vez, com cache,
 * para respeitar o limite de requisições da API gratuita).
 */
export async function resolveVendors(macs: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const pendingByPrefix = new Map<string, string[]>();

  for (const mac of macs) {
    if (isRandomizedMac(mac)) {
      result.set(mac, RANDOMIZED_MAC_LABEL);
      continue;
    }

    const local = lookupVendorByMac(mac);
    if (local) {
      result.set(mac, local);
      continue;
    }

    const prefix = ouiPrefix(mac);
    if (onlineCache.has(prefix)) {
      result.set(mac, onlineCache.get(prefix) ?? null);
      continue;
    }

    const group = pendingByPrefix.get(prefix) ?? [];
    group.push(mac);
    pendingByPrefix.set(prefix, group);
  }

  const prefixes = Array.from(pendingByPrefix.keys());

  for (let i = 0; i < prefixes.length; i++) {
    const prefix = prefixes[i];
    const vendor = await fetchVendorFromApi(prefix);

    if (vendor !== undefined) {
      onlineCache.set(prefix, vendor);
    }
    for (const mac of pendingByPrefix.get(prefix) ?? []) {
      result.set(mac, vendor ?? null);
    }

    if (i < prefixes.length - 1) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  return result;
}
