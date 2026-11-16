/**
 * Histórico do caminho de cada serviço (fase 9): os trechos de tempo em que a rota ficou igual (mesma
 * sequência de ASNs e mesmo lugar de atendimento) e as marcas de troca na linha do tempo. Puro.
 */
export interface TraceLite {
  at: number;
  asPath: string | null;
  verdict: string;
  cableName: string | null;
  destCountry: string | null;
}

export interface PathSegment {
  from: number;
  to: number;
  asPath: string | null;
  place: string;
  traces: number;
}

const PLACE: Record<string, string> = {
  DOMESTIC: "no Brasil",
  CDN_EDGE: "na borda do CDN no Brasil",
  OPERATOR_CACHE: "dentro da operadora",
  INTERNATIONAL: "fora do Brasil",
  UNDETERMINED: "indefinido",
};

export function placeOfTrace(t: Pick<TraceLite, "verdict" | "cableName" | "destCountry">): string {
  const base = PLACE[t.verdict] ?? t.verdict;
  if (t.verdict !== "INTERNATIONAL") return base;
  return `${base}${t.destCountry ? ` (${t.destCountry})` : ""}${t.cableName ? `, cabo ${t.cableName}` : ""}`;
}

/** Chave que muda quando a rota muda de verdade: ASNs e lugar (CDN no Brasil e servidor no Brasil contam igual). */
function keyOf(t: TraceLite): string {
  const verdict = t.verdict === "CDN_EDGE" ? "DOMESTIC" : t.verdict;
  return `${t.asPath ?? ""}|${verdict}|${t.destCountry ?? ""}|${t.cableName ?? ""}`;
}

/** Trechos em ordem do mais novo para o mais antigo. Rotas indefinidas não abrem trecho (um rastreio que falhou não é troca). */
export function pathHistory(traces: readonly TraceLite[]): PathSegment[] {
  const sorted = [...traces].filter((t) => t.verdict !== "UNDETERMINED").sort((a, b) => a.at - b.at);
  const out: PathSegment[] = [];
  let currentKey: string | null = null;
  for (const t of sorted) {
    const key = keyOf(t);
    const last = out[out.length - 1];
    if (last && key === currentKey) {
      last.to = t.at;
      last.traces++;
      continue;
    }
    currentKey = key;
    out.push({ from: t.at, to: t.at, asPath: t.asPath, place: placeOfTrace(t), traces: 1 });
  }
  return out.reverse();
}

/** Marcas de troca de rota dentro da janela, para a trilha "Rota" da linha do tempo. */
export function routeChangeMarks(traces: readonly TraceLite[], start: number, end: number): { at: number; text: string }[] {
  const segments = pathHistory(traces).reverse();
  const marks: { at: number; text: string }[] = [];
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i];
    if (s.from < start || s.from > end) continue;
    const prev = segments[i - 1];
    const asText = prev.asPath !== s.asPath ? `ASNs ${prev.asPath ?? "?"} → ${s.asPath ?? "?"}` : null;
    const placeText = prev.place !== s.place ? `${prev.place} → ${s.place}` : null;
    marks.push({ at: s.from, text: [placeText, asText].filter(Boolean).join("; ") || "rota mudou" });
  }
  return marks;
}
