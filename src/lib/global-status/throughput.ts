import { median } from "./stats";

/**
 * Banda medida pelos agentes, resumida por agente e destino:
 * - rede local (iperf3): contra o servidor iperf3 da máquina do painel. Mede o caminho agente → switch →
 *   servidor, que as sondas de latência não medem: um cabo negociando a 100 Mbit/s ou uma porta com erros
 *   aparece aqui antes de aparecer na latência;
 * - Internet: download e upload por HTTPS no speed.cloudflare.com (PoP mais próximo, no Rio), o caminho
 *   agente → modem → operadora → Internet.
 */

/** Destino do teste de banda de Internet do agente (porta 443). */
export const INTERNET_SPEED_HOST = "speed.cloudflare.com";

/** Teste de banda de Internet (Cloudflare), e não da rede local (iperf3). */
export const isInternetTest = (r: { server: string }) => r.server === INTERNET_SPEED_HOST;

/** Uma linha de ThroughputTest. */
export interface ThroughputRow {
  vantage: string;
  at: Date;
  server: string;
  port: number;
  uploadMbps: number | null;
  downloadMbps: number | null;
  retransmits: number | null;
  error: string | null;
}

export interface ThroughputTestView {
  at: string;
  uploadMbps: number | null;
  downloadMbps: number | null;
  retransmits: number | null;
  error: string | null;
}

export interface ThroughputSummary {
  /** Chave do resumo: agente e destino. */
  id: string;
  vantage: string;
  label: string;
  /** "internet" = Cloudflare; "lan" = iperf3 até a máquina do painel. */
  scope: "lan" | "internet";
  server: string;
  latest: ThroughputTestView;
  /** Mediana dos testes que deram certo nos últimos 7 dias (sem o mais novo); null com menos de 3. */
  usualUploadMbps: number | null;
  usualDownloadMbps: number | null;
  /** Frase quando o teste mais novo ficou bem abaixo do habitual, ou falhou; null quando normal. */
  warning: string | null;
  /** Até os 12 testes mais novos, do mais novo para o mais velho. */
  recent: ThroughputTestView[];
}

/** Fração do habitual abaixo da qual o teste mais novo é um aviso. */
export const THROUGHPUT_DROP_SHARE = 0.5;
/** Testes anteriores necessários para haver um "habitual". */
export const THROUGHPUT_MIN_HISTORY = 3;
/** Até quando os testes são guardados. */
export const THROUGHPUT_KEEP_MS = 30 * 24 * 60 * 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;
const RECENT = 12;

/** "906 Mbit/s", "58,3 Mbit/s". */
export function formatMbps(v: number): string {
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(".", ",")} Mbit/s`;
}

function view(r: ThroughputRow): ThroughputTestView {
  return { at: r.at.toISOString(), uploadMbps: r.uploadMbps, downloadMbps: r.downloadMbps, retransmits: r.retransmits, error: r.error };
}

function usual(rows: readonly ThroughputRow[], pick: (r: ThroughputRow) => number | null): number | null {
  const values = rows.map(pick).filter((v): v is number => v !== null);
  return values.length >= THROUGHPUT_MIN_HISTORY ? median(values) : null;
}

/** Aviso do teste mais novo: falhou, ou ficou abaixo de metade do habitual numa das direções. */
export function throughputWarning(latest: ThroughputRow, usualUp: number | null, usualDown: number | null): string | null {
  if (latest.error) return `O último teste falhou: ${latest.error}.`;
  const drops: string[] = [];
  if (usualDown && latest.downloadMbps !== null && latest.downloadMbps < usualDown * THROUGHPUT_DROP_SHARE) drops.push(`download ${formatMbps(latest.downloadMbps)} (costuma ser ${formatMbps(usualDown)})`);
  if (usualUp && latest.uploadMbps !== null && latest.uploadMbps < usualUp * THROUGHPUT_DROP_SHARE) drops.push(`upload ${formatMbps(latest.uploadMbps)} (costuma ser ${formatMbps(usualUp)})`);
  if (!drops.length) return null;
  if (isInternetTest(latest)) {
    return `Banda de Internet abaixo do habitual: ${drops.join(", ")}. Confira se há outra transferência grande na rede; se a rede local estiver normal, a queda é do modem ou da operadora.`;
  }
  return `Banda da rede local abaixo do habitual: ${drops.join(", ")}. Confira o cabo, a velocidade negociada na porta do switch e se há outra transferência grande na rede.`;
}

/**
 * Resumo por agente e destino (a rede local e a Internet têm habituais diferentes), do teste mais novo
 * para o mais velho; no mesmo agente, a rede local antes da Internet. Pura.
 */
export function summarizeThroughput(rows: readonly ThroughputRow[], labels: ReadonlyMap<string, string>, now: number): ThroughputSummary[] {
  const groups = new Map<string, ThroughputRow[]>();
  for (const r of rows) {
    const key = `${r.vantage}|${isInternetTest(r) ? "internet" : "lan"}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: ThroughputSummary[] = [];
  for (const [id, list] of groups) {
    const vantage = list[0].vantage;
    const sorted = [...list].sort((a, b) => b.at.getTime() - a.at.getTime());
    const [latest, ...older] = sorted;
    const week = older.filter((r) => !r.error && now - r.at.getTime() <= WEEK_MS);
    const usualUploadMbps = usual(week, (r) => r.uploadMbps);
    const usualDownloadMbps = usual(week, (r) => r.downloadMbps);
    const internet = isInternetTest(latest);
    out.push({
      id,
      vantage,
      label: labels.get(vantage) ?? "Agente",
      scope: internet ? "internet" : "lan",
      server: internet ? `${latest.server} (Cloudflare)` : `${latest.server}:${latest.port}`,
      latest: view(latest),
      usualUploadMbps,
      usualDownloadMbps,
      warning: throughputWarning(latest, usualUploadMbps, usualDownloadMbps),
      recent: sorted.slice(0, RECENT).map(view),
    });
  }
  const scopeOrder = (s: ThroughputSummary) => (s.scope === "lan" ? 0 : 1);
  return out.sort((a, b) => (a.vantage === b.vantage ? scopeOrder(a) - scopeOrder(b) : b.latest.at.localeCompare(a.latest.at)));
}
