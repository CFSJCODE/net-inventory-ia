import { prisma } from "@/lib/prisma";
import { getJson } from "./route-enrich";
import { inPrefix, parsePrefix, type Prefix } from "./route-roles";
import { serialized } from "./write-queue";

/**
 * Blocos das LANs dos pontos de troca do Brasil (IX.br e outros), da PeeringDB (fase 8): um salto dentro
 * de um deles é uma troca de tráfego no IX. Atualizado uma vez por dia (AppSetting `globalStatus.ixPrefixes`);
 * a API pública da PeeringDB não pede chave para leitura.
 */
export const IX_PREFIXES_KEY = "globalStatus.ixPrefixes";
export const IX_REFRESH_MS = 24 * 60 * 60_000;
const IX_RETRY_MS = 6 * 60 * 60_000;
const PEERINGDB = "https://www.peeringdb.com/api";

export interface IxPrefixEntry {
  cidr: string;
  ix: string;
}

export interface StoredIxPrefixes {
  at: string;
  prefixes: IxPrefixEntry[];
  error?: string | null;
}

interface PdbList<T> {
  data?: T[];
}

/** Junta as três listas da PeeringDB (ix, ixlan, ixpfx) em bloco → nome do IX. Pura. */
export function buildIxPrefixes(
  ixs: readonly { id: number; name: string }[],
  lans: readonly { id: number; ix_id: number }[],
  pfxs: readonly { prefix: string; ixlan_id: number }[],
): IxPrefixEntry[] {
  const ixName = new Map(ixs.map((ix) => [ix.id, ix.name]));
  const lanIx = new Map(lans.map((l) => [l.id, ixName.get(l.ix_id)]));
  const out: IxPrefixEntry[] = [];
  for (const p of pfxs) {
    const ix = lanIx.get(p.ixlan_id);
    if (ix && parsePrefix(p.prefix)) out.push({ cidr: p.prefix, ix });
  }
  return out;
}

async function fetchIxPrefixes(): Promise<IxPrefixEntry[]> {
  const ixs = (await getJson<PdbList<{ id: number; name: string }>>(`${PEERINGDB}/ix?country=BR&fields=id,name`)).data ?? [];
  if (!ixs.length) return [];
  const lans = (await getJson<PdbList<{ id: number; ix_id: number }>>(`${PEERINGDB}/ixlan?ix_id__in=${ixs.map((i) => i.id).join(",")}&fields=id,ix_id`)).data ?? [];
  if (!lans.length) return [];
  const pfxs = (await getJson<PdbList<{ prefix: string; ixlan_id: number }>>(`${PEERINGDB}/ixpfx?ixlan_id__in=${lans.map((l) => l.id).join(",")}&fields=prefix,ixlan_id`)).data ?? [];
  return buildIxPrefixes(ixs, lans, pfxs);
}

export async function readIxPrefixes(): Promise<StoredIxPrefixes | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: IX_PREFIXES_KEY } }).catch(() => null);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as StoredIxPrefixes;
  } catch {
    return null;
  }
}

/** Atualiza a lista se passou de 1 dia (ou 6 h depois de uma falha). Nunca lança. */
export async function refreshIxPrefixes(nowMs = Date.now()): Promise<StoredIxPrefixes | null> {
  const stored = await readIxPrefixes();
  const age = stored ? nowMs - Date.parse(stored.at) : Infinity;
  if (stored && age < (stored.error ? IX_RETRY_MS : IX_REFRESH_MS)) return stored;
  let next: StoredIxPrefixes;
  try {
    const prefixes = await fetchIxPrefixes();
    next = prefixes.length ? { at: new Date(nowMs).toISOString(), prefixes } : { at: new Date(nowMs).toISOString(), prefixes: stored?.prefixes ?? [], error: "PeeringDB sem blocos" };
  } catch (err) {
    next = { at: new Date(nowMs).toISOString(), prefixes: stored?.prefixes ?? [], error: err instanceof Error ? err.message : String(err) };
  }
  const value = JSON.stringify(next);
  await serialized(() => prisma.appSetting.upsert({ where: { key: IX_PREFIXES_KEY }, create: { key: IX_PREFIXES_KEY, value }, update: { value } })).catch(() => undefined);
  return next;
}

export interface IxMatcher {
  match(ip: string | null): string | null;
}

export function ixMatcher(entries: readonly IxPrefixEntry[]): IxMatcher {
  const parsed = entries.flatMap((e) => {
    const p = parsePrefix(e.cidr);
    return p ? [{ prefix: p, ix: e.ix }] : [];
  }) as { prefix: Prefix; ix: string }[];
  return { match: (ip) => (ip ? (parsed.find((p) => inPrefix(ip, p.prefix))?.ix ?? null) : null) };
}
