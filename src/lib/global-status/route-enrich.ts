import { promises as dnsPromises } from "node:dns";
import net from "node:net";
import { mapWithConcurrency } from "@/lib/network/concurrency";
import { parseAsOverview, parseNetworkInfo, ripestatUrl } from "./adapters/ripestat";
import { cityFromHostname, type City } from "./route-cities";
import { routerRole, type RouterRole } from "./route-roles";
import type { TraceHop } from "./traceroute";

/**
 * O que a fase 5 sabe de cada salto além do IP: o ASN dono do endereço e o nome dele, o nome reverso
 * (rDNS) e a cidade que esse nome indica.
 *
 * ASN pelo Team Cymru, via DNS (`<ip invertido>.origin.asn.cymru.com` → "28573 | 177.0.0.0/14 | BR | lacnic | …",
 * e `AS28573.asn.cymru.com` → "28573 | BR | lacnic | … | CLARO S.A., BR"), aberto e sem chave. Onde a
 * consulta TXT não sai (resolvedor que recusa, rede que bloqueia), o RIPEstat (`network-info` e
 * `as-overview`, por HTTP) responde no lugar, sem o país. Tudo fica em cache por 24 h, inclusive a
 * resposta "nada encontrado", para não perguntar de novo a cada rodada.
 */

export interface EnrichedHop extends TraceHop {
  asn: number | null;
  asName: string | null;
  /** País do registro do bloco de IPs (Team Cymru): diz onde a rede foi registrada, não onde o roteador está. */
  registryCountry: string | null;
  rdns: string | null;
  city: City | null;
  /** Papel do roteador pelo nome reverso (fase 7) ou pelo bloco do IX (fase 8). */
  role: RouterRole | null;
}

const TTL_MS = 24 * 60 * 60_000;
const DNS_TIMEOUT_MS = 2_500;
const HTTP_TIMEOUT_MS = 10_000;
const USER_AGENT = "NetInventory-StatusMonitor/1.0 (+https://github.com/CFSJCODE/net-inventory-ia)";
const CONCURRENCY = 4;

interface Cached<T> {
  value: T;
  at: number;
}
type Cache<T> = Map<string, Cached<T>>;

export interface OriginInfo {
  asn: number | null;
  country: string | null;
}

const g = globalThis as typeof globalThis & {
  __routeOrigin?: Cache<OriginInfo>;
  __routeAsName?: Cache<string | null>;
  __routeRdns?: Cache<string | null>;
};

async function cached<T>(cache: Cache<T>, key: string, nowMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < TTL_MS) return hit.value;
  const value = await load();
  cache.set(key, { value, at: nowMs });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return value;
}

/** Endereço que não aparece na Internet (rede local, CGNAT da operadora, loopback): não tem ASN nem rDNS público. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

/** Nome da consulta TXT de origem: "8.8.8.8" → "8.8.8.8.origin.asn.cymru.com" (invertido); IPv6 em nibbles. */
export function cymruOriginName(ip: string): string | null {
  if (net.isIPv4(ip)) return `${ip.split(".").reverse().join(".")}.origin.asn.cymru.com`;
  if (!net.isIPv6(ip)) return null;
  const [head, tail = ""] = ip.split("::");
  const parts = (s: string) => (s ? s.split(":") : []);
  const h = parts(head);
  const t = parts(tail);
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t].map((x) => x.padStart(4, "0"));
  return `${groups.join("").split("").reverse().join(".")}.origin6.asn.cymru.com`;
}

/** "28573 4230 | 177.0.0.0/14 | BR | lacnic | 2009-02-11" → o primeiro ASN e o país. */
export function parseCymruOrigin(txt: string): OriginInfo {
  const [asns, , country] = txt.split("|").map((s) => s.trim());
  const asn = Number((asns ?? "").split(/\s+/)[0]);
  return { asn: Number.isInteger(asn) && asn > 0 ? asn : null, country: /^[A-Z]{2}$/.test(country ?? "") ? country! : null };
}

/** "28573 | BR | lacnic | 2005-10-18 | CLARO S.A., BR" → "CLARO S.A." (sem o país repetido no fim). */
export function parseCymruAsName(txt: string): string | null {
  const name = txt.split("|")[4]?.trim();
  return name ? name.replace(/,\s*[A-Z]{2}$/, "").trim() || null : null;
}

function resolver() {
  return new dnsPromises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
}

async function txt(name: string): Promise<string | null> {
  const records = await resolver().resolveTxt(name);
  return records.length ? records[0].join("") : null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

const NOT_FOUND = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

/** ASN de origem e país do registro de um IP público. */
export function originOf(ip: string, nowMs = Date.now()): Promise<OriginInfo> {
  g.__routeOrigin ??= new Map();
  return cached(g.__routeOrigin, ip, nowMs, async () => {
    const name = cymruOriginName(ip);
    if (name) {
      try {
        const record = await txt(name);
        return record ? parseCymruOrigin(record) : { asn: null, country: null };
      } catch (err) {
        // "Não existe" é resposta: o bloco não está anunciado. Outro erro (sem DNS, recusa) cai no RIPEstat.
        if (NOT_FOUND.has((err as NodeJS.ErrnoException).code ?? "")) return { asn: null, country: null };
      }
    }
    try {
      const info = parseNetworkInfo(await getJson(ripestatUrl("network-info", ip)));
      return { asn: info?.asns[0] ?? null, country: null };
    } catch {
      return { asn: null, country: null };
    }
  });
}

/** Nome do dono de um ASN. */
export function asNameOf(asn: number, nowMs = Date.now()): Promise<string | null> {
  g.__routeAsName ??= new Map();
  return cached(g.__routeAsName, String(asn), nowMs, async () => {
    try {
      const record = await txt(`AS${asn}.asn.cymru.com`);
      if (record) return parseCymruAsName(record);
    } catch {
      // Sem DNS TXT: o RIPEstat responde.
    }
    try {
      return parseAsOverview(await getJson(ripestatUrl("as-overview", `AS${asn}`)));
    } catch {
      return null;
    }
  });
}

/** Nome reverso do IP; null sem registro ou sem resposta a tempo. */
export function rdnsOf(ip: string, nowMs = Date.now()): Promise<string | null> {
  g.__routeRdns ??= new Map();
  return cached(g.__routeRdns, ip, nowMs, async () => {
    try {
      const names = await resolver().reverse(ip);
      return names[0]?.replace(/\.$/, "").toLowerCase() || null;
    } catch {
      return null;
    }
  });
}

/** ASN, nome, rDNS e cidade de cada salto. Saltos sem resposta e endereços privados ficam só com o IP. */
export async function enrichHops(hops: readonly TraceHop[], nowMs = Date.now()): Promise<EnrichedHop[]> {
  return mapWithConcurrency([...hops], CONCURRENCY, async (hop): Promise<EnrichedHop> => {
    const base: EnrichedHop = { ...hop, asn: null, asName: null, registryCountry: null, rdns: null, city: null, role: null };
    if (!hop.ip || isPrivateIp(hop.ip)) return base;
    const [origin, rdns] = await Promise.all([originOf(hop.ip, nowMs), rdnsOf(hop.ip, nowMs)]);
    const asName = origin.asn ? await asNameOf(origin.asn, nowMs) : null;
    return { ...base, asn: origin.asn, asName, registryCountry: origin.country, rdns, city: cityFromHostname(rdns), role: routerRole(rdns) };
  });
}
