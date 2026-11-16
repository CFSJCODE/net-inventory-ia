import { lookup } from "node:dns/promises";
import net from "node:net";
import { prisma } from "@/lib/prisma";
import { mapWithConcurrency } from "@/lib/network/concurrency";
import { CATEGORY_LABEL } from "./catalog";
import { parseAsOverview, parseCoveringPrefixes, parseNetworkInfo, parseRoutingStatus, parseWhatsMyIp, ripestatUrl, visibilityStatus, type ServiceRoute } from "./adapters/ripestat";
import { AUTO_GATEWAY, type ServiceCategory } from "./types";

/**
 * O que a fase 4 busca no RIPEstat além do IODA: a operadora deste servidor (para o IODA por ASN) e a
 * rota BGP de cada serviço medido. Consultas leves (≈1 s cada), uma vez por hora.
 */

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "NetInventory-StatusMonitor/1.0 (+https://github.com/CFSJCODE/net-inventory-ia)";
/** Prefixo e ASN de um endereço mudam pouco: redescobertos uma vez por dia. */
const PREFIX_TTL_MS = 24 * 60 * 60_000;
/** A operadora é redescoberta uma vez por dia (troca de plano, de roteador, de IP fixo). */
const ISP_TTL_MS = 24 * 60 * 60_000;
const ROUTE_CONCURRENCY = 4;
export const ISP_KEY = "globalStatus.isp";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${new URL(url).host}`);
  return (await res.json()) as T;
}

export interface IspInfo {
  asn: number;
  name: string | null;
  /** Quando foi descoberta (ISO 8601). */
  at: string;
  /** true = veio da tela de configuração, não da descoberta pelo IP público. */
  manual?: boolean;
}

async function readIsp(): Promise<IspInfo | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: ISP_KEY } }).catch(() => null);
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as IspInfo;
    return Number.isInteger(value.asn) && value.asn > 0 ? value : null;
  } catch {
    return null;
  }
}

/** A operadora gravada da última descoberta, sem ir à rede (para a tela de configuração). */
export function storedIsp(): Promise<IspInfo | null> {
  return readIsp();
}

/**
 * A operadora deste servidor: o ASN do IP público (como o RIPE vê a conexão) e o nome do dono. O IP
 * não é gravado, só o ASN e o nome. `manualAsn` (da tela de configuração) pula a descoberta.
 */
export async function resolveIsp(manualAsn: number | null, nowMs = Date.now()): Promise<IspInfo> {
  const stored = await readIsp();
  // O guardado só vale para o mesmo modo: voltar ao automático descobre de novo, sem herdar o ASN informado à mão.
  const sameSource = manualAsn === null ? !stored?.manual : !!stored?.manual && stored.asn === manualAsn;
  if (stored && sameSource && nowMs - Date.parse(stored.at) < ISP_TTL_MS) return stored;
  let asn = manualAsn;
  if (asn === null) {
    const ip = parseWhatsMyIp(await getJson(ripestatUrl("whats-my-ip")));
    const info = parseNetworkInfo(await getJson(ripestatUrl("network-info", ip)));
    asn = info?.asns[0] ?? null;
    if (!asn) throw new Error("Não foi possível descobrir a operadora deste servidor");
  }
  const name = await getJson<Parameters<typeof parseAsOverview>[0]>(ripestatUrl("as-overview", `AS${asn}`))
    .then(parseAsOverview)
    .catch(() => (stored?.asn === asn ? stored.name : null));
  const info: IspInfo = { asn, name, at: new Date(nowMs).toISOString(), ...(manualAsn !== null ? { manual: true } : {}) };
  const value = JSON.stringify(info);
  await prisma.appSetting.upsert({ where: { key: ISP_KEY }, create: { key: ISP_KEY, value }, update: { value } });
  return info;
}

/** "AS28573 · CLARO S.A." */
export function ispLabel(isp: Pick<IspInfo, "asn" | "name">): string {
  return isp.name ? `AS${isp.asn} · ${isp.name}` : `AS${isp.asn}`;
}

interface PrefixCache {
  prefix: string | null;
  asn: number | null;
  at: number;
}

const g = globalThis as typeof globalThis & { __globalStatusPrefixes?: Map<string, PrefixCache> };

/** O endereço cuja rota importa: o do TCP (a latência de rede do card) ou, sem ele, o do HTTP. */
export function routeHost(targets: readonly { kind: string; host: string }[]): string | null {
  const target = targets.find((t) => t.kind === "TCP") ?? targets.find((t) => t.kind === "HTTP") ?? targets.find((t) => t.kind === "ICMP");
  return target && target.host !== AUTO_GATEWAY && !target.host.startsWith("auto:") ? target.host : null;
}

async function prefixOf(host: string, nowMs: number): Promise<PrefixCache> {
  g.__globalStatusPrefixes ??= new Map();
  const cached = g.__globalStatusPrefixes.get(host);
  if (cached && nowMs - cached.at < PREFIX_TTL_MS) return cached;
  const ip = net.isIP(host) ? host : (await lookup(host, { family: 4 }).catch(() => lookup(host))).address;
  const info = parseNetworkInfo(await getJson(ripestatUrl("network-info", ip)));
  const entry: PrefixCache = { prefix: info?.prefix ?? null, asn: info?.asns[0] ?? null, at: nowMs };
  g.__globalStatusPrefixes.set(host, entry);
  return entry;
}

const errorText = (err: unknown) => (err instanceof Error ? (err.name === "TimeoutError" ? "RIPEstat não respondeu a tempo" : err.message) : String(err));

type RoutingStatusBody = Parameters<typeof parseRoutingStatus>[0] & Parameters<typeof parseCoveringPrefixes>[0];

/**
 * Bloco maior do mesmo ASN que cobre um prefixo pouco visto: o mais próximo que esteja visível no
 * mundo todo (até dois consultados), senão o mais próximo. Falha do RIPEstat aqui não derruba a rota.
 */
async function coverOf(body: RoutingStatusBody, prefix: string, asn: number | null): Promise<ServiceRoute["cover"]> {
  try {
    const candidates = parseCoveringPrefixes(body, asn).slice(0, 2);
    let first: ServiceRoute["cover"] = null;
    for (const cover of candidates) {
      const visibility = parseRoutingStatus(await getJson(ripestatUrl("routing-status", cover)), prefix);
      if (visibilityStatus(visibility) === "OK") return { prefix: cover, visibility };
      first ??= { prefix: cover, visibility };
    }
    return first;
  } catch {
    return null;
  }
}

/** A rota BGP de cada serviço medido (sem os da conexão local e os da faixa "Internet no Brasil"). */
export async function collectRoutes(nowMs = Date.now()): Promise<ServiceRoute[]> {
  const services = await prisma.statusService.findMany({
    where: { enabled: true, category: { notIn: ["INTERNET", "REGIONAL"] } },
    orderBy: { position: "asc" },
    select: { slug: true, name: true, category: true, targets: { where: { enabled: true }, select: { kind: true, host: true } } },
  });
  const measured = services.flatMap((s) => {
    const host = routeHost(s.targets);
    return host ? [{ ...s, host }] : [];
  });
  return mapWithConcurrency(measured, ROUTE_CONCURRENCY, async (s): Promise<ServiceRoute> => {
    const base = { slug: s.slug, name: s.name, group: CATEGORY_LABEL[s.category as ServiceCategory] ?? s.category };
    try {
      const { prefix, asn } = await prefixOf(s.host, nowMs);
      if (!prefix) return { ...base, prefix: null, asn, visibility: null, error: `${s.host} sem prefixo anunciado` };
      try {
        const body = await getJson<RoutingStatusBody>(ripestatUrl("routing-status", prefix));
        const visibility = parseRoutingStatus(body, prefix);
        return { ...base, prefix, asn, visibility, cover: visibilityStatus(visibility) === "OK" ? null : await coverOf(body, prefix, asn), error: null };
      } catch (err) {
        return { ...base, prefix, asn, visibility: null, error: errorText(err) };
      }
    } catch (err) {
      return { ...base, prefix: null, asn: null, visibility: null, error: errorText(err) };
    }
  });
}
