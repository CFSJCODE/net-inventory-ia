import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { mapWithConcurrency } from "@/lib/network/concurrency";
import { STATUS_CATALOG } from "./catalog";
import { ensureCatalogSeeded } from "./collector";
import {
  BASELINE_REFRESH_MS,
  BASELINE_WINDOW_MS,
  SERVER_VANTAGE,
  TARGET_CACHE_MS,
  advanceAgenda,
  buildRollups,
  cleanupCutoffs,
  closedWindows,
  groupBaseline,
  hydrateTarget,
  isInternetTarget,
  isStale,
  maintenanceDue,
  nextConnectivity,
  nextEvidenceStep,
  pauseServiceTargets,
  pausedReason,
  pausedRoundDue,
  pausedRoundTargets,
  pausedServiceData,
  pausedTargetData,
  probesEnabled,
  reconcileTargets,
  recordTick,
  respreadServices,
  ringMaxAgeMs,
  rollupStart,
  selectDue,
  serviceData,
  settlePausedRound,
  sortByCatalog,
  type ConnectivityDecision,
  type LoadedTarget,
  type Measurement,
  type TargetState,
  type TickOutcome,
  type TickProgress,
} from "./probe-logic";
import { defaultGateway, runProbe } from "./probes";
import { BUCKET_MS, type RecentCheck } from "./stats";
import type { LocalConnectivity, ProbeKind } from "./types";
import { serialized } from "./write-queue";

/**
 * Agendador das medições próprias: decide o que medir a cada instante, grava as medições, resume em
 * janelas de 5 min, limpa o histórico e calcula o status medido de cada serviço.
 *
 * Este arquivo só liga o timer, as sondas e o banco. As regras (agenda, conexão local, veredito de
 * cada alvo, pausa, janelas) estão em `probe-logic.ts`, em funções puras e testadas uma a uma.
 */

/** Intervalo do agendador: a cada passo mede só os alvos que venceram. */
export const PROBE_TICK_MS = 5_000;
/** Sondas simultâneas, no máximo. */
export const PROBE_CONCURRENCY = 8;
/** O primeiro passo espera o servidor terminar de subir. */
const FIRST_TICK_DELAY_MS = 3_000;
/** Espera antes de repetir uma gravação que falhou (o banco pode estar ocupado com outro escritor). */
const WRITE_RETRY_MS = 500;
/** A mesma falha, repetida a cada passo, vira uma linha de log por minuto. */
const LOG_EVERY_MS = 60_000;

type PausedState = "offline" | "dns";

interface RunnerState {
  started: boolean;
  timer?: NodeJS.Timeout;
  /** Passo em andamento (um por vez). */
  running?: Promise<void>;
  /** "Atualizar agora" em andamento: quem pedir ao mesmo tempo espera o mesmo passo. */
  forced?: Promise<void>;
  /** Alvos habilitados e o estado de cada um, na ordem do catálogo. */
  targets: Map<string, TargetState>;
  targetsAt: number;
  announced: boolean;
  /** Linha de base de latência de cada alvo (medianas das janelas das últimas 24 h). */
  baselines: Map<string, number[]>;
  baselinesAt: number;
  connectivity: LocalConnectivity;
  pausedRoundAt: number;
  /** Contador que troca os canários a cada rodada de evidência. */
  rotation: number;
  /** Início da última janela de 5 min já resumida; null até a primeira passada. */
  lastRolled: number | null;
  rollupAt: number;
  cleanupAt: number;
  logged: Map<string, number>;
}

// O estado fica em globalThis (como no coletor): um hot reload em desenvolvimento não cria um segundo agendador.
const g = globalThis as typeof globalThis & { __globalStatusProbes?: RunnerState };

function runner(): RunnerState {
  g.__globalStatusProbes ??= {
    started: false,
    targets: new Map(),
    targetsAt: 0,
    announced: false,
    baselines: new Map(),
    baselinesAt: 0,
    connectivity: { state: "ok", since: null, reason: null },
    pausedRoundAt: 0,
    rotation: 0,
    lastRolled: null,
    rollupAt: 0,
    cleanupAt: 0,
    logged: new Map(),
  };
  return g.__globalStatusProbes;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).trim().split("\n").pop()!.slice(0, 300);

/** Com passos de 5 s, um banco travado encheria o log: a mesma mensagem sai no máximo uma vez por minuto. */
function report(r: RunnerState, message: string, log: () => void): void {
  const now = Date.now();
  if (now - (r.logged.get(message) ?? 0) < LOG_EVERY_MS) return;
  if (r.logged.size > 50) r.logged.clear();
  r.logged.set(message, now);
  log();
}

/** Mede os alvos, no máximo PROBE_CONCURRENCY por vez. O `at` de cada medição é o instante em que a sonda começou. */
function measure(targets: TargetState[]): Promise<Measurement[]> {
  return mapWithConcurrency(targets, PROBE_CONCURRENCY, async (target) => {
    const at = new Date();
    try {
      return { target, at, result: await runProbe({ kind: target.kind, host: target.host, url: target.url, port: target.port }) };
    } catch (err) {
      // runProbe promete nunca rejeitar; se rejeitar, o defeito é da sonda e não pode virar queda do alvo.
      return { target, at, result: { ok: false, latencyMs: null, unsupported: true, error: `falha interna da sonda: ${errorText(err)}` } };
    }
  });
}

async function gatewayIp(): Promise<string | null> {
  try {
    return await defaultGateway();
  } catch {
    return null;
  }
}

/** Relê do banco os alvos habilitados dos serviços habilitados (a cada 5 min, ou num passo forçado). */
async function refreshTargets(r: RunnerState, now: number, force: boolean): Promise<void> {
  if (!isStale(r.targetsAt, now, TARGET_CACHE_MS, force)) return;
  const rows = await prisma.probeTarget.findMany({
    where: { enabled: true, service: { enabled: true } },
    select: {
      id: true, serviceId: true, key: true, kind: true, host: true, url: true, port: true, intervalSec: true, status: true, statusReason: true, lastLatencyMs: true,
      service: { select: { slug: true, category: true, sourceType: true } },
    },
  });
  const loaded: LoadedTarget[] = rows.map(({ service, kind, ...row }) => ({ ...row, kind: kind as ProbeKind, serviceSlug: service.slug, category: service.category, sourceType: service.sourceType }));
  const { targets, added } = reconcileTargets(r.targets, sortByCatalog(loaded, STATUS_CATALOG), now);
  await hydrate(targets, added, now);
  r.targets = targets;
  r.targetsAt = now;
  if (!r.announced) {
    r.announced = true;
    console.log(`[global-status] medindo ${targets.size} alvos a partir deste servidor (HTTP, TCP, ping e DNS)`);
  }
}

/** Histórico dos alvos que acabaram de entrar em memória: as medições recentes e, nos de Internet, se já responderam alguma vez. */
async function hydrate(targets: Map<string, TargetState>, added: string[], now: number): Promise<void> {
  if (!added.length) return;
  const fresh = added.map((id) => targets.get(id)!);

  // Uma consulta por intervalo (são poucos): a idade máxima das medições que entram depende dele.
  const idsByInterval = new Map<number, string[]>();
  for (const t of fresh) idsByInterval.set(t.intervalSec, [...(idsByInterval.get(t.intervalSec) ?? []), t.id]);
  const checks = new Map<string, (RecentCheck & { at: Date })[]>();
  for (const [intervalSec, ids] of idsByInterval) {
    const rows = await prisma.probeCheck.findMany({
      where: { targetId: { in: ids }, vantage: SERVER_VANTAGE, at: { gte: new Date(now - ringMaxAgeMs(intervalSec)) } },
      select: { targetId: true, at: true, ok: true, latencyMs: true, lossPct: true, certDays: true },
    });
    for (const row of rows) {
      const list = checks.get(row.targetId);
      if (list) list.push(row);
      else checks.set(row.targetId, [row]);
    }
  }

  const internetIds = fresh.filter(isInternetTarget).map((t) => t.id);
  const answered = new Set<string>();
  if (internetIds.length) {
    const [rollups, oks] = await Promise.all([
      prisma.probeRollup.groupBy({ by: ["targetId"], where: { targetId: { in: internetIds }, vantage: SERVER_VANTAGE, p50Ms: { not: null } }, _count: { _all: true } }),
      prisma.probeCheck.groupBy({ by: ["targetId"], where: { targetId: { in: internetIds }, vantage: SERVER_VANTAGE, ok: true }, _count: { _all: true } }),
    ]);
    for (const row of [...rollups, ...oks]) answered.add(row.targetId);
  }

  for (const t of fresh) targets.set(t.id, hydrateTarget(t, { checks: checks.get(t.id) ?? [], everOk: answered.has(t.id) }, now));
}

/** Relê a linha de base de todos os alvos numa consulta só (a cada 5 min). */
async function refreshBaselines(r: RunnerState, now: number): Promise<void> {
  if (!isStale(r.baselinesAt, now, BASELINE_REFRESH_MS)) return;
  const rollups = await prisma.probeRollup.findMany({
    where: { vantage: SERVER_VANTAGE, bucket: { gte: new Date(now - BASELINE_WINDOW_MS) }, p50Ms: { not: null } },
    select: { targetId: true, p50Ms: true },
  });
  r.baselines = groupBaseline(rollups);
  r.baselinesAt = now;
}

/** Um passo: mede o que venceu, decide se as falhas são dos serviços ou da conexão local, grava e faz a manutenção. */
async function tick(r: RunnerState, force: boolean): Promise<void> {
  await ensureCatalogSeeded();
  const now = Date.now();
  await refreshTargets(r, now, force);
  await refreshBaselines(r, now);

  const all = Array.from(r.targets.values());
  let settled: { decision: ConnectivityDecision; record: Measurement[] } | null = null;

  if (r.connectivity.state === "ok") {
    const measured = await measure(selectDue(all, now, force));
    r.targets = advanceAgenda(r.targets, measured.map((m) => m.target.id), now, { force });
    // Enquanto a lógica pedir mais evidência (canários, depois âncoras e gateway), mede e pergunta de novo.
    const rotation = r.rotation;
    let progress: TickProgress = { measured, canaries: null, internet: null, gatewayIp: null };
    let step = nextEvidenceStep(all, progress, rotation);
    while (step.kind !== "done") {
      if (step.kind === "canaries") {
        r.rotation = rotation + 1;
        progress = { ...progress, canaries: await measure(step.targets) };
      } else {
        progress = { ...progress, internet: await measure(step.targets), gatewayIp: await gatewayIp() };
      }
      step = nextEvidenceStep(all, progress, rotation);
    }
    settled = step;
  } else if (pausedRoundDue(r.pausedRoundAt, now, force)) {
    r.pausedRoundAt = now;
    const round = pausedRoundTargets(all, r.rotation++);
    const results = await measure([...round.internet, ...round.canaries]);
    const internet = results.slice(0, round.internet.length);
    r.targets = advanceAgenda(r.targets, internet.map((m) => m.target.id), now, { force });
    settled = settlePausedRound(internet, results.slice(round.internet.length), await gatewayIp());
  }

  if (settled) {
    // O estado em memória muda antes de gravar: se a gravação falhar, ele segue valendo como calculado.
    const outcome = recordTick(r.targets, settled.record, r.baselines);
    r.targets = outcome.targets;
    const decidedAt = Date.now();
    const { connectivity, change } = nextConnectivity(r.connectivity, settled.decision, decidedAt);
    r.connectivity = connectivity;
    let pause: PausedState | null = null;
    if (connectivity.state !== "ok" && (change === "lost" || change === "moved")) {
      pause = connectivity.state;
      r.targets = pauseServiceTargets(r.targets, pausedReason(pause));
      if (change === "lost") r.pausedRoundAt = decidedAt;
      console.warn(`[global-status] conexão local fora: ${connectivity.reason}`);
    } else if (change === "restored") {
      // Nada é gravado na volta: o próximo resultado de cada alvo o julga de novo.
      r.targets = respreadServices(r.targets, decidedAt);
      console.log("[global-status] conexão local restabelecida");
    }
    await persist(r, outcome, pause);
  }
  await maintain(r);
}

/** Grava o passo numa chamada só da fila de escrita. Falhou: tenta mais uma vez depois de 500 ms e, se falhar de novo, descarta. */
async function persist(r: RunnerState, outcome: TickOutcome, pause: PausedState | null): Promise<void> {
  if (!pause && !outcome.targetUpdates.length) return;
  await serialized(async () => {
    try {
      await writeTick(outcome, pause);
    } catch {
      await sleep(WRITE_RETRY_MS);
      try {
        await writeTick(outcome, pause);
      } catch (err) {
        const message = `[global-status] medições não gravadas (o estado em memória segue valendo): ${errorText(err)}`;
        report(r, message, () => console.warn(message));
      }
    }
  });
}

/** Uma transação com as medições, os alvos e os serviços do passo e, ao entrar em pausa, a marcação de todos os serviços. */
async function writeTick(outcome: TickOutcome, pause: PausedState | null): Promise<void> {
  const now = new Date();
  const touched = outcome.services.map((s) => s.serviceId);
  // Lidos aqui dentro da fila: o coletor pode ter mudado o estado oficial e o status desde o começo do passo.
  const current = await prisma.statusService.findMany({
    where: pause ? { OR: [{ id: { in: touched } }, { category: { not: "INTERNET" } }] } : { id: { in: touched } },
    select: { id: true, category: true, officialState: true, status: true },
  });
  const byId = new Map(current.map((s) => [s.id, s]));

  const writes: Prisma.PrismaPromise<unknown>[] = [];
  if (outcome.rows.length) writes.push(prisma.probeCheck.createMany({ data: outcome.rows }));
  for (const { id, data } of outcome.targetUpdates) writes.push(prisma.probeTarget.updateMany({ where: { id }, data }));
  for (const s of outcome.services) {
    const row = byId.get(s.serviceId);
    if (row) writes.push(prisma.statusService.updateMany({ where: { id: s.serviceId }, data: serviceData(s.summary, row, { sourceType: s.sourceType, at: s.at, now }) }));
  }
  if (pause) {
    // Os cards passam a mostrar só o status oficial; os alvos de serviço ficam "Sem dados" com a frase da pausa.
    const paused = current.filter((s) => s.category !== "INTERNET");
    writes.push(prisma.probeTarget.updateMany({ where: { serviceId: { in: paused.map((s) => s.id) } }, data: pausedTargetData(pause) }));
    for (const s of paused) writes.push(prisma.statusService.updateMany({ where: { id: s.id }, data: pausedServiceData(s, pause, now) }));
  }
  if (writes.length) await prisma.$transaction(writes);
}

/** Manutenção do fim do passo, pelos horários: resumo das janelas (uma vez por minuto) e limpeza (uma vez por hora). */
async function maintain(r: RunnerState): Promise<void> {
  const now = Date.now();
  const due = maintenanceDue({ rollupAt: r.rollupAt, cleanupAt: r.cleanupAt }, now);
  if (due.rollup) {
    r.rollupAt = now;
    await rollUp(r, now).catch((err) => {
      const message = `[global-status] falha ao resumir as janelas de 5 min: ${errorText(err)}`;
      report(r, message, () => console.warn(message));
    });
  }
  if (due.cleanup) {
    r.cleanupAt = now;
    await cleanUp(now).catch((err) => {
      const message = `[global-status] falha ao limpar o histórico de medições: ${errorText(err)}`;
      report(r, message, () => console.warn(message));
    });
  }
}

/** Resume as janelas de 5 min já fechadas em linhas de ProbeRollup (no máximo 24 janelas por passada). */
async function rollUp(r: RunnerState, now: number): Promise<void> {
  let known = { lastRolled: r.lastRolled, newestRollup: null as number | null, oldestCheck: null as number | null };
  if (known.lastRolled === null) {
    // Servidor acabou de subir: continua de onde o banco parou.
    const newest = await prisma.probeRollup.findFirst({ where: { vantage: SERVER_VANTAGE }, orderBy: { bucket: "desc" }, select: { bucket: true } });
    const oldest = newest ? null : await prisma.probeCheck.findFirst({ where: { vantage: SERVER_VANTAGE }, orderBy: { at: "asc" }, select: { at: true } });
    known = { lastRolled: null, newestRollup: newest?.bucket.getTime() ?? null, oldestCheck: oldest?.at.getTime() ?? null };
  }
  const from = rollupStart(known, now);
  if (from === null) return;
  const windows = closedWindows(from, now);
  if (!windows.length) return;
  const last = windows[windows.length - 1];

  await serialized(async () => {
    const checks = await prisma.probeCheck.findMany({
      where: { vantage: SERVER_VANTAGE, at: { gte: new Date(windows[0]), lt: new Date(last + BUCKET_MS) } },
      select: { targetId: true, at: true, ok: true, latencyMs: true, lossPct: true },
    });
    const rows = buildRollups(checks, windows);
    if (!rows.length) return;
    await prisma.$transaction(
      rows.map(({ targetId, vantage, bucket, ...stats }) =>
        prisma.probeRollup.upsert({ where: { targetId_vantage_bucket: { targetId, vantage, bucket } }, create: { targetId, vantage, bucket, ...stats }, update: stats }),
      ),
    );
  });
  r.lastRolled = last;
}

/** Apaga as medições cruas com mais de 48 h e as janelas com mais de 30 dias. */
async function cleanUp(now: number): Promise<void> {
  const { checksBefore, rollupsBefore } = cleanupCutoffs(now);
  await serialized(() =>
    prisma.$transaction([prisma.probeCheck.deleteMany({ where: { at: { lt: checksBefore } } }), prisma.probeRollup.deleteMany({ where: { bucket: { lt: rollupsBefore } } })]),
  );
}

/**
 * Roda um passo e resolve quando as gravações dele terminam. Um passo por vez: o do timer que encontra
 * outro em andamento é pulado (devolve o que está rodando); o forçado espera o atual e roda em seguida.
 * Nunca rejeita.
 */
export function runProbeTick(options: { force?: boolean } = {}): Promise<void> {
  if (!probesEnabled(process.env.GLOBAL_STATUS_PROBES)) return Promise.resolve();
  const r = runner();
  if (r.running) return options.force ? r.running.then(() => runProbeTick(options)) : r.running;
  r.running = tick(r, options.force === true)
    .catch((err) => {
      const message = `[global-status] falha nas medições: ${errorText(err)}`;
      report(r, message, () => console.error(message, err));
    })
    .finally(() => {
      r.running = undefined;
    });
  return r.running;
}

/** Inicia o agendador (uma vez por processo, via instrumentation). `GLOBAL_STATUS_PROBES=off` desliga. */
export function startProbeRunner(): void {
  const r = runner();
  if (r.started) return;
  r.started = true;
  if (!probesEnabled(process.env.GLOBAL_STATUS_PROBES)) {
    console.log("[global-status] medições próprias desligadas (GLOBAL_STATUS_PROBES=off)");
    return;
  }
  // Os timers não seguram o processo aberto (unref): quem mantém o servidor de pé é o próprio Next.
  r.timer = setTimeout(() => {
    void runProbeTick();
    r.timer = setInterval(() => void runProbeTick(), PROBE_TICK_MS);
    r.timer.unref();
  }, FIRST_TICK_DELAY_MS);
  r.timer.unref();
}

/** Mede todos os alvos habilitados agora, ignorando a agenda ("Atualizar agora"). */
export function runProbesNow(): Promise<void> {
  if (!probesEnabled(process.env.GLOBAL_STATUS_PROBES)) return Promise.resolve();
  const r = runner();
  r.forced ??= runProbeTick({ force: true }).finally(() => {
    r.forced = undefined;
  });
  return r.forced;
}

/** Estado da conexão do próprio servidor, para a faixa "Sua Internet". */
export function getLocalConnectivity(): LocalConnectivity {
  return { ...(g.__globalStatusProbes?.connectivity ?? { state: "ok", since: null, reason: null }) };
}
