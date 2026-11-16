import { prisma } from "@/lib/prisma";
import { ripestatUrl } from "./adapters/ripestat";
import { asNameOf, getJson } from "./route-enrich";
import { serialized } from "./write-queue";

/**
 * Upstreams da operadora pelo BGP (fase 8): os vizinhos "à esquerda" do ASN no RIPEstat `asn-neighbours`
 * (quem leva as rotas dele adiante). Mostra se existem outras saídas além da que as rotas medidas usam.
 * Atualizado uma vez por dia (AppSetting `globalStatus.upstreams`).
 */
export const UPSTREAMS_KEY = "globalStatus.upstreams";
const REFRESH_MS = 24 * 60 * 60_000;
const RETRY_MS = 6 * 60 * 60_000;
const MAX_SHOWN = 8;

export interface Upstream {
  asn: number;
  name: string | null;
  /** Quantos coletores do RIS veem essa adjacência (peso relativo). */
  power: number;
}

export interface StoredUpstreams {
  asn: number;
  at: string;
  upstreams: Upstream[];
  error?: string | null;
}

interface NeighboursData {
  neighbours?: { asn: number; type: string; power?: number }[];
}

/** Os vizinhos upstream ("left"), do mais visto para o menos. Pura. */
export function parseNeighbours(data: NeighboursData): { asn: number; power: number }[] {
  return (data.neighbours ?? [])
    .filter((n) => n.type === "left" && Number.isInteger(n.asn))
    .map((n) => ({ asn: n.asn, power: n.power ?? 0 }))
    .sort((a, b) => b.power - a.power);
}

export async function readUpstreams(): Promise<StoredUpstreams | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: UPSTREAMS_KEY } }).catch(() => null);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as StoredUpstreams;
  } catch {
    return null;
  }
}

export async function refreshUpstreams(asn: number | null, nowMs = Date.now()): Promise<StoredUpstreams | null> {
  if (!asn) return null;
  const stored = await readUpstreams();
  const fresh = stored && stored.asn === asn && nowMs - Date.parse(stored.at) < (stored.error ? RETRY_MS : REFRESH_MS);
  if (fresh) return stored;
  let next: StoredUpstreams;
  try {
    const body = await getJson<{ status?: string; data?: NeighboursData }>(ripestatUrl("asn-neighbours", `AS${asn}`));
    if (body.status !== "ok" || !body.data) throw new Error("RIPEstat asn-neighbours sem dados");
    const list = parseNeighbours(body.data).slice(0, MAX_SHOWN);
    const upstreams: Upstream[] = [];
    for (const n of list) upstreams.push({ ...n, name: await asNameOf(n.asn, nowMs).catch(() => null) });
    next = { asn, at: new Date(nowMs).toISOString(), upstreams };
  } catch (err) {
    next = { asn, at: new Date(nowMs).toISOString(), upstreams: stored?.asn === asn ? stored.upstreams : [], error: err instanceof Error ? err.message : String(err) };
  }
  const value = JSON.stringify(next);
  await serialized(() => prisma.appSetting.upsert({ where: { key: UPSTREAMS_KEY }, create: { key: UPSTREAMS_KEY, value }, update: { value } })).catch(() => undefined);
  return next;
}
