import { median } from "./stats";

/**
 * Banda da rede local (iperf3): os testes que os agentes fazem contra o servidor iperf3 da máquina do
 * painel, resumidos por agente. Mede o caminho agente → switch → servidor, que as sondas de latência não
 * medem: um cabo negociando a 100 Mbit/s ou uma porta com erros aparece aqui antes de aparecer na latência.
 */

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
  vantage: string;
  label: string;
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
  return `Banda da rede local abaixo do habitual: ${drops.join(", ")}. Confira o cabo, a velocidade negociada na porta do switch e se há outra transferência grande na rede.`;
}

/** Resumo por agente, do agente com teste mais novo para o mais velho. Pura. */
export function summarizeThroughput(rows: readonly ThroughputRow[], labels: ReadonlyMap<string, string>, now: number): ThroughputSummary[] {
  const byVantage = new Map<string, ThroughputRow[]>();
  for (const r of rows) {
    const list = byVantage.get(r.vantage) ?? [];
    list.push(r);
    byVantage.set(r.vantage, list);
  }
  const out: ThroughputSummary[] = [];
  for (const [vantage, list] of byVantage) {
    const sorted = [...list].sort((a, b) => b.at.getTime() - a.at.getTime());
    const [latest, ...older] = sorted;
    const week = older.filter((r) => !r.error && now - r.at.getTime() <= WEEK_MS);
    const usualUploadMbps = usual(week, (r) => r.uploadMbps);
    const usualDownloadMbps = usual(week, (r) => r.downloadMbps);
    out.push({
      vantage,
      label: labels.get(vantage) ?? "Agente",
      server: `${latest.server}:${latest.port}`,
      latest: view(latest),
      usualUploadMbps,
      usualDownloadMbps,
      warning: throughputWarning(latest, usualUploadMbps, usualDownloadMbps),
      recent: sorted.slice(0, RECENT).map(view),
    });
  }
  return out.sort((a, b) => b.latest.at.localeCompare(a.latest.at));
}
