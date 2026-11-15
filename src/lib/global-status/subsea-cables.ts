import { prisma } from "@/lib/prisma";
import { mapWithConcurrency } from "@/lib/network/concurrency";
import { CABLE_COUNTRY_ISO } from "./route-cities";
import { serialized } from "./write-queue";

/**
 * Cabos submarinos que chegam ao Brasil (fase 5), do Submarine Cable Map da TeleGeography
 * (submarinecablemap.com, API v3 aberta; conferida em 15/11/2026):
 * - `country/brazil.json` → os cabos com ponto de chegada no Brasil;
 * - `cable/<id>.json` → donos, comprimento, ano de entrada em operação e os pontos de chegada com o país;
 * - `landing-point/landing-point-geo.json` → a coordenada de cada ponto de chegada.
 *
 * Os dados são da TeleGeography (uso não comercial, com atribuição): o painel busca em execução, guarda
 * só o resumo dos cabos do Brasil em AppSetting e renova uma vez por semana. Nada disso vai para o
 * repositório. Cabos planejados, ou com entrada em operação depois deste ano, ficam de fora.
 */

export const CABLE_MAP_BASE = "https://www.submarinecablemap.com/api/v3";
export const CABLE_MAP_PAGE = "https://www.submarinecablemap.com/";
export const CABLES_KEY = "globalStatus.cables";
/** A última falha ao buscar ou gravar os cabos ({ at, error }), para diagnóstico sem acesso aos logs do motor. */
export const CABLES_ERROR_KEY = "globalStatus.cablesError";
const REFRESH_MS = 7 * 24 * 60 * 60_000;
/** Uma falha ao buscar espera 30 min antes de tentar de novo (o cache velho, se houver, segue valendo). */
const RETRY_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "NetInventory-StatusMonitor/1.0 (+https://github.com/CFSJCODE/net-inventory-ia)";

export interface Landing {
  id: string;
  name: string;
  /** ISO alfa-2 quando conhecido; senão o nome em inglês que o mapa usa. */
  country: string;
  lat: number;
  lon: number;
}

export interface Cable {
  id: string;
  name: string;
  owners: string;
  lengthKm: number | null;
  rfsYear: number | null;
  landings: Landing[];
}

interface Stored {
  at: number;
  cables: Cable[];
}

interface CountryBody {
  cables?: { id?: string; is_planned?: boolean | null; rfs_year?: number | null }[];
}
interface CableBody {
  id?: string;
  name?: string;
  length?: string | null;
  owners?: string | null;
  rfs_year?: number | null;
  is_planned?: boolean | null;
  landing_points?: { id?: string; name?: string; country?: string | null }[];
}
interface LandingGeoBody {
  features?: { properties?: { id?: string }; geometry?: { coordinates?: [number, number] } }[];
}

/** "10,556 km" → 10556. */
export function parseLengthKm(text: string | null | undefined): number | null {
  const n = Number(String(text ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Cabos em operação com chegada no Brasil. Pura: recebe as respostas já baixadas. */
export function buildCables(country: CountryBody, details: readonly CableBody[], geo: LandingGeoBody, year: number): Cable[] {
  const coords = new Map<string, [number, number]>();
  for (const f of geo.features ?? []) {
    const id = f.properties?.id;
    const c = f.geometry?.coordinates;
    if (id && Array.isArray(c) && c.length === 2) coords.set(id, c);
  }
  const wanted = new Set((country.cables ?? []).filter((c) => c.id && !c.is_planned && (c.rfs_year == null || c.rfs_year <= year)).map((c) => c.id!));
  const cables: Cable[] = [];
  for (const d of details) {
    if (!d.id || !wanted.has(d.id) || d.is_planned) continue;
    const landings = (d.landing_points ?? []).flatMap((p): Landing[] => {
      const c = p.id ? coords.get(p.id) : undefined;
      if (!p.id || !c) return [];
      const name = (p.name ?? p.id).trim();
      const countryName = (p.country ?? "").trim();
      return [{ id: p.id, name, country: CABLE_COUNTRY_ISO[countryName] ?? countryName, lon: c[0], lat: c[1] }];
    });
    if (!landings.length) continue;
    cables.push({ id: d.id, name: (d.name ?? d.id).trim(), owners: (d.owners ?? "").trim(), lengthKm: parseLengthKm(d.length), rfsYear: d.rfs_year ?? null, landings });
  }
  return cables.sort((a, b) => a.name.localeCompare(b.name));
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${CABLE_MAP_BASE}/${path}`, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`Mapa de cabos: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function readStored(): Promise<Stored | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: CABLES_KEY } }).catch(() => null);
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as Stored;
    return typeof value.at === "number" && Array.isArray(value.cables) ? value : null;
  } catch {
    return null;
  }
}

const g = globalThis as typeof globalThis & { __subseaCables?: Stored; __subseaCablesFailedAt?: number };

/** Os cabos do Brasil: do processo, do banco ou da TeleGeography (uma vez por semana). Nunca lança. */
export async function brazilCables(nowMs = Date.now()): Promise<Cable[]> {
  g.__subseaCables ??= (await readStored()) ?? undefined;
  const current = g.__subseaCables;
  if (current && nowMs - current.at < REFRESH_MS) return current.cables;
  if (g.__subseaCablesFailedAt && nowMs - g.__subseaCablesFailedAt < RETRY_MS) return current?.cables ?? [];
  try {
    const country = await getJson<CountryBody>("country/brazil.json");
    const ids = (country.cables ?? []).map((c) => c.id).filter((id): id is string => !!id);
    const [details, geo] = await Promise.all([
      mapWithConcurrency(ids, 3, (id) => getJson<CableBody>(`cable/${encodeURIComponent(id)}.json`).catch(() => ({}) as CableBody)),
      getJson<LandingGeoBody>("landing-point/landing-point-geo.json"),
    ]);
    const cables = buildCables(country, details, geo, new Date(nowMs).getUTCFullYear());
    if (!cables.length) throw new Error("Mapa de cabos: nenhum cabo do Brasil na resposta");
    const stored: Stored = { at: nowMs, cables };
    // Vale para o processo já; uma falha ao gravar não joga fora o que foi baixado.
    g.__subseaCables = stored;
    g.__subseaCablesFailedAt = undefined;
    const value = JSON.stringify(stored);
    await serialized(() => prisma.appSetting.upsert({ where: { key: CABLES_KEY }, create: { key: CABLES_KEY, value }, update: { value } })).catch((err) => recordFailure(nowMs, `gravar: ${errorText(err)}`));
    return cables;
  } catch (err) {
    g.__subseaCablesFailedAt = nowMs;
    await recordFailure(nowMs, errorText(err));
    return current?.cables ?? [];
  }
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
}

/** Avisa no log e guarda a falha no banco: o host .NET não repassa a saída do motor ao journal. Nunca lança. */
async function recordFailure(nowMs: number, error: string): Promise<void> {
  console.warn(`[global-status] mapa de cabos indisponível: ${error}`);
  const value = JSON.stringify({ at: nowMs, error: error.slice(0, 500) });
  await serialized(() => prisma.appSetting.upsert({ where: { key: CABLES_ERROR_KEY }, create: { key: CABLES_ERROR_KEY, value }, update: { value } })).catch(() => undefined);
}
