import { getJson } from "./route-enrich";

/**
 * Segunda opinião pelo RIPE Atlas (fase 10): os traceroutes públicos que sondas do RIPE Atlas no Brasil já
 * fazem até o mesmo destino. Só leitura (nenhuma medição é criada, sem chave): diz se o caminho que a sua
 * operadora escolhe é o de todo mundo ou só dela. Resultado em cache por 6 h por destino.
 */
const ATLAS = "https://atlas.ripe.net/api/v2";
const CACHE_MS = 6 * 60 * 60_000;
const MAX_MEASUREMENTS = 3;
const MAX_PROBES = 200;
export const ATLAS_DOMESTIC_MS = 30;

interface AtlasHopReply {
  from?: string;
  rtt?: number;
  x?: string;
}
export interface AtlasResult {
  prb_id: number;
  dst_addr?: string;
  result?: { hop: number; result?: AtlasHopReply[] }[];
}

export interface AtlasProbeRoute {
  probe: number;
  asn: number | null;
  reached: boolean;
  rttMs: number | null;
  hops: number;
}

export interface AtlasComparison {
  host: string;
  measurements: number[];
  probes: number;
  reached: number;
  medianRttMs: number | null;
  /** Fração das sondas que chegaram com menos de 30 ms (servidas no Brasil). */
  domesticShare: number | null;
  /** As sondas na mesma operadora do servidor. */
  sameIsp: { probes: number; medianRttMs: number | null } | null;
  /** Frase pronta para a tela. */
  summary: string;
  at: string;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};

/** Um resultado de traceroute do Atlas: chegou, RTT final (o menor do último salto) e quantos saltos. Pura. */
export function readAtlasResult(r: AtlasResult, probeAsn: number | null): AtlasProbeRoute {
  const hops = r.result ?? [];
  const last = hops[hops.length - 1];
  const replies = (last?.result ?? []).filter((x) => typeof x.rtt === "number" && x.from);
  const reached = !!r.dst_addr && replies.some((x) => x.from === r.dst_addr);
  const rtts = replies.map((x) => x.rtt!);
  return { probe: r.prb_id, asn: probeAsn, reached, rttMs: reached && rtts.length ? Math.round(Math.min(...rtts) * 10) / 10 : null, hops: hops.length };
}

/** Resume as rotas das sondas e compara com a do servidor. Pura. */
export function compareAtlas(host: string, measurements: number[], routes: readonly AtlasProbeRoute[], ours: { rttMs: number | null; verdict: string | null; ispAsn: number | null }, nowMs: number): AtlasComparison {
  const reached = routes.filter((r) => r.reached && r.rttMs !== null);
  const rtts = reached.map((r) => r.rttMs!);
  const domesticShare = reached.length ? reached.filter((r) => r.rttMs! < ATLAS_DOMESTIC_MS).length / reached.length : null;
  const same = ours.ispAsn ? reached.filter((r) => r.asn === ours.ispAsn) : [];
  const sameIsp = ours.ispAsn ? { probes: same.length, medianRttMs: median(same.map((r) => r.rttMs!)) } : null;
  const med = median(rtts);
  let summary: string;
  if (!routes.length) summary = `Nenhuma sonda do RIPE Atlas no Brasil rastreou ${host} recentemente.`;
  else if (!reached.length) summary = `${routes.length} sondas do RIPE Atlas no Brasil rastrearam ${host}, mas nenhuma chegou ao destino (o destino não responde ao rastreio).`;
  else {
    const pct = Math.round((domesticShare ?? 0) * 100);
    summary = `${reached.length} sondas do RIPE Atlas no Brasil chegaram a ${host}: mediana de ${med} ms, ${pct}% abaixo de ${ATLAS_DOMESTIC_MS} ms (servidas no Brasil).`;
    const abroad = ours.verdict === "INTERNATIONAL" || (ours.rttMs !== null && ours.rttMs >= 60);
    if (abroad && pct >= 50) summary += " A maioria das redes do Brasil é atendida aqui, mas a sua rota vai para fora: a escolha é da sua operadora.";
    // Acima de 30 ms ainda pode ser Brasil (São Paulo a Manaus passa de 50 ms): o tempo sozinho não prova que as sondas saem do país.
    else if (abroad && pct < 50) summary += ` A maioria das sondas também passa de ${ATLAS_DOMESTIC_MS} ms: não é só a sua operadora que demora, mas pelo tempo não dá para dizer se elas saem do país.`;
    else if (!abroad && ours.rttMs !== null) summary += ` A sua rota (${Math.round(ours.rttMs)} ms) está no mesmo padrão.`;
    if (sameIsp && sameIsp.probes) summary += ` Na sua operadora: ${sameIsp.probes} sonda${sameIsp.probes === 1 ? "" : "s"}, mediana de ${sameIsp.medianRttMs} ms.`;
  }
  return { host, measurements, probes: routes.length, reached: reached.length, medianRttMs: med, domesticShare, sameIsp, summary, at: new Date(nowMs).toISOString() };
}

const g = globalThis as typeof globalThis & { __atlasCache?: Map<string, AtlasComparison>; __atlasProbes?: { at: number; asn: Map<number, number | null> } };

async function brazilProbes(nowMs: number): Promise<Map<number, number | null>> {
  if (g.__atlasProbes && nowMs - g.__atlasProbes.at < 24 * 60 * 60_000) return g.__atlasProbes.asn;
  const body = await getJson<{ results?: { id: number; asn_v4: number | null }[] }>(`${ATLAS}/probes/?country_code=BR&status=1&page_size=500&fields=id,asn_v4`);
  const asn = new Map((body.results ?? []).map((p) => [p.id, p.asn_v4 ?? null]));
  g.__atlasProbes = { at: nowMs, asn };
  return asn;
}

/** Compara a rota do servidor com as do RIPE Atlas no Brasil (sob demanda, no detalhe). */
export async function atlasCompare(host: string, ours: { rttMs: number | null; verdict: string | null; ispAsn: number | null }, nowMs = Date.now()): Promise<AtlasComparison> {
  g.__atlasCache ??= new Map();
  const cached = g.__atlasCache.get(host);
  if (cached && nowMs - Date.parse(cached.at) < CACHE_MS) return compareAgain(cached, ours, nowMs);
  const list = await getJson<{ results?: { id: number }[] }>(`${ATLAS}/measurements/?type=traceroute&status=2&af=4&is_public=true&target=${encodeURIComponent(host)}&page_size=${MAX_MEASUREMENTS}&fields=id`);
  const ids = (list.results ?? []).map((m) => m.id).slice(0, MAX_MEASUREMENTS);
  const probes = await brazilProbes(nowMs);
  const probeIds = [...probes.keys()].slice(0, MAX_PROBES);
  const routes: AtlasProbeRoute[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!probeIds.length) break;
    const results = await getJson<AtlasResult[]>(`${ATLAS}/measurements/${id}/latest/?probe_ids=${probeIds.join(",")}`).catch(() => [] as AtlasResult[]);
    for (const r of Array.isArray(results) ? results : []) {
      if (seen.has(r.prb_id)) continue;
      seen.add(r.prb_id);
      routes.push(readAtlasResult(r, probes.get(r.prb_id) ?? null));
    }
  }
  const result = compareAtlas(host, ids, routes, ours, nowMs);
  g.__atlasCache.set(host, { ...result, __routes: routes } as AtlasComparison);
  return result;
}

/** O cache guarda as rotas das sondas: a frase é refeita com a rota atual do servidor. */
function compareAgain(cached: AtlasComparison, ours: { rttMs: number | null; verdict: string | null; ispAsn: number | null }, nowMs: number): AtlasComparison {
  const routes = (cached as AtlasComparison & { __routes?: AtlasProbeRoute[] }).__routes ?? [];
  return { ...compareAtlas(cached.host, cached.measurements, routes, ours, nowMs), at: cached.at };
}
