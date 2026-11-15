import { countryName, distanceKm, type City } from "./route-cities";
import type { EnrichedHop } from "./route-enrich";
import type { Cable, Landing } from "./subsea-cables";

/**
 * Onde o serviço é servido, a partir da rota (fase 5). É uma inferência: o cabo está na camada física e
 * o traceroute só enxerga roteadores IP (um túnel MPLS esconde saltos). As regras usam a física e os nomes:
 *
 * - Limite físico do RTT: a luz na fibra anda ~200 km por ms, então um RTT de X ms põe o destino a no
 *   máximo X × 100 km (ida e volta). Abaixo de 30 ms (3.000 km) nenhuma travessia oceânica cabe: o
 *   destino está no Brasil (Fortaleza–Miami são ~5.500 km em linha reta, ≥ 55 ms).
 * - Destino com o ASN da sua operadora: cache dentro da operadora (Netflix Open Connect, Google GGC).
 * - Travessia: o maior degrau do "piso" do RTT (o menor RTT dali até o fim da rota, que não sobe com os
 *   saltos lentos para responder ao ICMP). Um destino a 60 ms ou mais, ou um roteador de fora no caminho
 *   (pelo nome reverso), indica que a rota sai do país; com um degrau de 40 ms ou mais, o salto antes dele é
 *   a saída e o depois é a chegada.
 * - Cabo candidato: os cabos do Brasil com chegada no país do destino, descartando os que a física não
 *   permite (a distância entre as pontas exige mais RTT do que o medido). Pesam a cidade de saída perto de
 *   um ponto de chegada do cabo no Brasil, a cidade de chegada perto do ponto do outro lado e um dono do
 *   cabo com o mesmo nome do dono dos roteadores dos dois lados do degrau (a Claro é da América Movil,
 *   dona do AMX-1).
 * - Confiança: alta (cidades dos dois lados, degrau medido e um cabo à frente dos outros), média (país do
 *   destino visto num nome reverso, até 3 candidatos ou dono coincidente), baixa (o resto).
 */

export type RouteVerdict = "DOMESTIC" | "OPERATOR_CACHE" | "INTERNATIONAL" | "UNDETERMINED";
export type RouteConfidence = "HIGH" | "MEDIUM" | "LOW";

/** Velocidade da luz na fibra: ~200 km por ms, ou 100 km de distância por ms de ida e volta. */
export const KM_PER_RTT_MS = 100;
export const DOMESTIC_MAX_RTT_MS = 30;
export const OCEAN_MIN_RTT_MS = 60;
export const CROSSING_STEP_MS = 40;
const NEAR_HOME_KM = 400;
const NEAR_FOREIGN_KM = 800;
const MAX_CANDIDATES_SHOWN = 4;

export interface RouteInput {
  hops: readonly EnrichedHop[];
  /** RTT até o destino (o do traceroute quando o destino respondeu; senão o handshake TCP mais recente). */
  destRttMs: number | null;
  destAsn: number | null;
  destAsName: string | null;
  /** País do registro do IP de destino (Team Cymru), último recurso para o país. */
  destRegistryCountry: string | null;
  isp: { asn: number; name: string | null } | null;
  cables: readonly Cable[];
}

export interface CableCandidate {
  id: string;
  name: string;
  score: number;
}

export interface RouteInference {
  verdict: RouteVerdict;
  summary: string;
  destCountry: string | null;
  cable: { id: string; name: string } | null;
  candidates: CableCandidate[];
  confidence: RouteConfidence | null;
  /** TTL do último salto antes da travessia e do primeiro depois, quando houver degrau. */
  exitTtl: number | null;
  entryTtl: number | null;
  /** Tamanho do degrau, em ms. */
  stepMs: number | null;
}

const fmtMs = (ms: number) => `${Math.round(ms)} ms`;
const fmtKm = (km: number) => `${(Math.round(km / 100) * 100).toLocaleString("pt-BR")} km`;

interface Step {
  /** Índice (em `answered`) do último salto antes do degrau. */
  index: number;
  stepMs: number;
}

/** O maior degrau do piso do RTT entre saltos que responderam. */
export function biggestStep(answered: readonly { rttMs: number | null }[]): Step | null {
  const rtts = answered.map((h) => h.rttMs ?? Infinity);
  const floor = new Array<number>(rtts.length);
  let min = Infinity;
  for (let i = rtts.length - 1; i >= 0; i--) {
    min = Math.min(min, rtts[i]);
    floor[i] = min;
  }
  let best: Step | null = null;
  for (let i = 0; i + 1 < floor.length; i++) {
    if (!Number.isFinite(floor[i]) || !Number.isFinite(floor[i + 1])) continue;
    const stepMs = floor[i + 1] - floor[i];
    if (!best || stepMs > best.stepMs) best = { index: i, stepMs };
  }
  return best;
}

function nearestKm(city: City | null, landings: readonly Landing[]): number {
  if (!city || !landings.length) return Infinity;
  return Math.min(...landings.map((l) => distanceKm(city, l)));
}

/** Palavras do nome do dono do ASN que também aparecem nos donos do cabo. A Claro e a Embratel são da América Movil. */
const OWNER_ALIASES: [RegExp, string][] = [
  [/\b(claro|embratel|telmex|america movil|net servicos)\b/i, "america movil"],
  [/\b(telefonica|vivo|telxius)\b/i, "telxius"],
  [/\b(telefonica|vivo|telxius)\b/i, "telefonica"],
  [/\bgoogle\b/i, "google"],
  [/\b(facebook|meta)\b/i, "meta"],
  [/\bangola cables\b/i, "angola cables"],
  [/\bseaborn\b/i, "seaborn"],
  [/\balgar\b/i, "algar"],
  [/\b(tim|telecom italia|sparkle)\b/i, "sparkle"],
  [/\b(globenet|v\.tal|oi s\.?a)\b/i, "v.tal"],
  [/\b(globenet|v\.tal|oi s\.?a)\b/i, "globenet"],
  [/\b(lumen|level ?3|centurylink)\b/i, "lumen"],
  [/\bantel\b/i, "antel"],
  [/\bamazon\b/i, "amazon"],
  [/\bmicrosoft\b/i, "microsoft"],
];

export function ownerMatches(asNames: readonly (string | null)[], owners: string): boolean {
  // Sem acentos: o mapa escreve "América Movil".
  const o = owners.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return asNames.some((name) => !!name && OWNER_ALIASES.some(([pattern, owner]) => pattern.test(name) && o.includes(owner)));
}

function landingsIn(cable: Cable, country: string): Landing[] {
  return cable.landings.filter((l) => l.country === country);
}

/** Os cabos do Brasil que podem levar a rota até `country`, do mais para o menos provável. */
export function rankCables(
  cables: readonly Cable[],
  opts: { country: string; exitCity: City | null; entryCity: City | null; destRttMs: number | null; asNames: readonly (string | null)[] },
): CableCandidate[] {
  const ranked: CableCandidate[] = [];
  for (const cable of cables) {
    const home = landingsIn(cable, "BR");
    const away = landingsIn(cable, opts.country);
    if (!home.length || !away.length) continue;
    // A física: a menor distância entre uma ponta no Brasil e uma do outro lado exige ao menos esse RTT.
    const spanKm = Math.min(...home.flatMap((h) => away.map((a) => distanceKm(h, a))));
    if (opts.destRttMs !== null && opts.destRttMs < spanKm / KM_PER_RTT_MS) continue;
    let score = 0;
    if (nearestKm(opts.exitCity, home) <= NEAR_HOME_KM) score += 2;
    if (nearestKm(opts.entryCity, away) <= NEAR_FOREIGN_KM) score += 2;
    if (ownerMatches(opts.asNames, cable.owners)) score += 1;
    ranked.push({ id: cable.id, name: cable.name, score });
  }
  return ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function lastCity(hops: readonly EnrichedHop[], country: "BR" | "foreign"): City | null {
  const list = country === "BR" ? [...hops].reverse() : hops;
  return list.find((h) => h.city && (country === "BR" ? h.city.country === "BR" : h.city.country !== "BR"))?.city ?? null;
}

export function inferRoute(input: RouteInput): RouteInference {
  const answered = input.hops.filter((h) => h.ip !== null && h.rttMs !== null);
  const maxHopRtt = answered.length ? Math.max(...answered.map((h) => h.rttMs!)) : null;
  const rtt = input.destRttMs ?? maxHopRtt;
  const base: RouteInference = { verdict: "UNDETERMINED", summary: "", destCountry: null, cable: null, candidates: [], confidence: null, exitTtl: null, entryTtl: null, stepMs: null };

  if (input.isp && input.destAsn === input.isp.asn) {
    const who = input.isp.name ? `${input.isp.name} (AS${input.isp.asn})` : `AS${input.isp.asn}`;
    return { ...base, verdict: "OPERATOR_CACHE", destCountry: "BR", summary: `Servido de dentro da sua operadora, ${who}${rtt !== null ? `, a ${fmtMs(rtt)}` : ""}: um cache instalado na própria rede.` };
  }
  if (rtt === null) return { ...base, summary: "Sem tempo de resposta medido até o destino: não dá para dizer onde ele está." };

  const step = biggestStep(answered);
  const crossing = step && step.stepMs >= CROSSING_STEP_MS ? step : null;
  // O Brasil é grande (São Paulo–Manaus pede ~50 ms): abaixo de 60 ms a rota só sai do país com um roteador
  // de fora no caminho, visto pelo nome reverso.
  const foreignSeen = answered.some((h) => h.city && h.city.country !== "BR");
  if (rtt < DOMESTIC_MAX_RTT_MS && !foreignSeen) {
    const where = lastCity(answered, "BR");
    return {
      ...base,
      verdict: "DOMESTIC",
      destCountry: "BR",
      summary: `Servido no Brasil${where ? `, provavelmente em ${where.name}` : ""}: com ${fmtMs(rtt)} de ida e volta o destino está a no máximo ${fmtKm(rtt * KM_PER_RTT_MS)}; uma travessia do oceano passaria de ${fmtMs(OCEAN_MIN_RTT_MS)}.`,
    };
  }
  if (rtt < OCEAN_MIN_RTT_MS && !foreignSeen) {
    return { ...base, summary: `${fmtMs(rtt)} até o destino, sem um degrau de travessia na rota: pode ser outra região do Brasil ou um país vizinho.` };
  }

  // A rota sai do país.
  const before = crossing ? answered.slice(0, crossing.index + 1) : answered;
  const after = crossing ? answered.slice(crossing.index + 1) : [];
  const exitCity = lastCity(before, "BR");
  const entryCity = lastCity(after, "foreign");
  const rdnsCountry = entryCity?.country ?? lastCity(answered, "foreign")?.country ?? null;
  const registryCountry = [...after.map((h) => h.registryCountry), input.destRegistryCountry].find((c) => !!c && c !== "BR") ?? null;
  const destCountry = rdnsCountry ?? registryCountry;
  // Quem opera a travessia são os roteadores dos dois lados do degrau; sem degrau, vale qualquer um da rota.
  const asNames = crossing ? [before[before.length - 1].asName, after[0]?.asName ?? null] : [...answered.map((h) => h.asName), input.destAsName];
  const candidates = destCountry ? rankCables(input.cables, { country: destCountry, exitCity, entryCity, destRttMs: rtt, asNames }) : [];
  const top = candidates[0] ?? null;
  const tied = top ? candidates.filter((c) => c.score === top.score).length : 0;

  let confidence: RouteConfidence | null = null;
  if (top) {
    if (exitCity && entryCity && crossing && top.score >= 4 && tied === 1) confidence = "HIGH";
    else if (rdnsCountry && (candidates.length <= 3 || (top.score > 0 && tied === 1))) confidence = "MEDIUM";
    else confidence = "LOW";
  }

  const parts: string[] = [];
  const to = countryName(destCountry);
  const leg = exitCity && entryCity ? `por ${exitCity.name} e chega em ${entryCity.name}` : entryCity ? `e chega em ${entryCity.name}` : exitCity ? `por ${exitCity.name}` : "";
  parts.push(`Sai do Brasil${leg ? ` ${leg}` : ""}${to ? ` (${to})` : ""}`);
  if (crossing) parts.push(`o salto da travessia soma ${fmtMs(crossing.stepMs)}, ao menos ${fmtKm(crossing.stepMs * KM_PER_RTT_MS)} de fibra`);
  else parts.push(`${fmtMs(rtt)} até o destino, ao menos ${fmtKm(rtt * KM_PER_RTT_MS)} de fibra`);
  let summary = `${parts.join(": ")}.`;
  if (top) {
    const others = candidates.slice(1, MAX_CANDIDATES_SHOWN).map((c) => c.name);
    const word = confidence === "HIGH" ? "alta" : confidence === "MEDIUM" ? "média" : "baixa";
    summary += ` Cabo provável: ${top.name} (confiança ${word}${others.length ? `; outros possíveis: ${others.join(", ")}` : ""}).`;
  } else if (destCountry) {
    summary += ` Nenhum cabo do Brasil com chegada em ${to} cabe no tempo medido: a rota pode passar por outro país.`;
  } else {
    summary += " Os nomes dos roteadores não dizem o país de chegada, então o cabo fica sem palpite.";
  }

  return {
    verdict: "INTERNATIONAL",
    summary,
    destCountry,
    cable: top ? { id: top.id, name: top.name } : null,
    candidates: candidates.slice(0, MAX_CANDIDATES_SHOWN),
    confidence,
    exitTtl: crossing ? before[before.length - 1].ttl : null,
    entryTtl: crossing && after.length ? after[0].ttl : null,
    stepMs: crossing ? Math.round(crossing.stepMs * 10) / 10 : null,
  };
}

/** Sequência de ASNs da rota, sem repetir vizinhos: "28573 4230 15169". */
export function asPathOf(hops: readonly { asn: number | null }[], destAsn: number | null): string | null {
  const path: number[] = [];
  for (const asn of [...hops.map((h) => h.asn), destAsn]) if (asn && path[path.length - 1] !== asn) path.push(asn);
  return path.length ? path.join(" ") : null;
}
