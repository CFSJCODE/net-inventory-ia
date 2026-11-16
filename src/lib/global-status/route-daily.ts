import { prisma } from "@/lib/prisma";
import { pathHistory, type TraceLite } from "./route-history";
import { exitLabel, exitPoint, type PeeringHop } from "./route-peering";
import { serialized } from "./write-queue";

/**
 * Resumo diário das rotas (fase 10): uma linha por serviço, ponto de medição e dia (horário de Brasília),
 * refeita de hora em hora para hoje e ontem a partir das rotas cruas (que ficam 7 dias). Fica 400 dias, para
 * comparar meses: quantos dias o serviço veio de fora, quantas trocas de caminho, por onde saiu.
 */
export const ROLLUP_EVERY_MS = 60 * 60_000;
export const DAILY_RETENTION_DAYS = 400;
const DAY_MS = 24 * 60 * 60_000;
const BRT_OFFSET = "-03:00";

/** "2026-11-16" no horário de Brasília (sem horário de verão desde 2019). */
export function brtDay(ms: number): string {
  return new Date(ms - 3 * 60 * 60_000).toISOString().slice(0, 10);
}

export function dayBounds(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00${BRT_OFFSET}`);
  return { start, end: start + DAY_MS };
}

const mostCommon = (values: readonly (string | null)[]): string | null => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
};

export interface DayTrace extends TraceLite {
  destRttMs: number | null;
  hops: readonly PeeringHop[];
}

/** A linha do dia a partir das rotas do dia. Pura. */
export function summarizeDay(traces: readonly DayTrace[]) {
  const valid = traces.filter((t) => t.verdict !== "UNDETERMINED" && t.verdict !== "PENDING");
  const international = valid.filter((t) => t.verdict === "INTERNATIONAL");
  const rtts = valid.map((t) => t.destRttMs).filter((v): v is number => v !== null);
  const exits = international.map((t) => {
    const exit = exitPoint(t.hops);
    return exit ? exitLabel(exit) : null;
  });
  return {
    traces: traces.length,
    international: international.length,
    domestic: valid.length - international.length,
    pathChanges: Math.max(0, pathHistory(valid).length - 1),
    topVerdict: mostCommon(valid.map((t) => t.verdict)),
    topAsPath: mostCommon(valid.map((t) => t.asPath)),
    topExit: mostCommon(exits),
    avgDestRttMs: rtts.length ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 10) / 10 : null,
  };
}

const g = globalThis as typeof globalThis & { __routeDailyAt?: number };

/** Refaz hoje e ontem, no máximo uma vez por hora, e apaga o que passou de 400 dias. */
export async function rollupRouteDays(nowMs = Date.now(), force = false): Promise<void> {
  if (!force && g.__routeDailyAt && nowMs - g.__routeDailyAt < ROLLUP_EVERY_MS) return;
  g.__routeDailyAt = nowMs;
  for (const day of [brtDay(nowMs - DAY_MS), brtDay(nowMs)]) {
    const { start, end } = dayBounds(day);
    const rows = await prisma.routeTrace.findMany({
      where: { at: { gte: new Date(start), lt: new Date(end) }, error: null },
      orderBy: { at: "asc" },
      select: { serviceId: true, vantage: true, at: true, asPath: true, verdict: true, cableName: true, destCountry: true, destRttMs: true, hops: { orderBy: { ttl: "asc" }, select: { ttl: true, ip: true, asn: true, asName: true, city: true, country: true, role: true } } },
    });
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.serviceId}\u0000${r.vantage}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const list of groups.values()) {
      const { serviceId, vantage } = list[0];
      const data = summarizeDay(list.map((r) => ({ ...r, at: r.at.getTime() })));
      await serialized(() =>
        prisma.routeDaily.upsert({ where: { serviceId_vantage_day: { serviceId, vantage, day } }, create: { serviceId, vantage, day, ...data }, update: data }),
      );
    }
  }
  const cutoff = brtDay(nowMs - DAILY_RETENTION_DAYS * DAY_MS);
  await serialized(() => prisma.routeDaily.deleteMany({ where: { day: { lt: cutoff } } }));
}

/** Os últimos 30 dias de um serviço, para o detalhe. */
export async function monthlyRoutes(serviceId: string, nowMs = Date.now()) {
  const since = brtDay(nowMs - 30 * DAY_MS);
  const days = await prisma.routeDaily.findMany({ where: { serviceId, vantage: "server", day: { gte: since } }, orderBy: { day: "asc" } });
  if (!days.length) return null;
  return {
    days: days.length,
    abroadDays: days.filter((d) => d.international > d.domestic).length,
    pathChanges: days.reduce((sum, d) => sum + d.pathChanges, 0),
    exits: [...new Set(days.map((d) => d.topExit).filter((e): e is string => !!e))],
    avgDestRttMs: (() => {
      const v = days.map((d) => d.avgDestRttMs).filter((x): x is number => x !== null);
      return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
    })(),
  };
}
