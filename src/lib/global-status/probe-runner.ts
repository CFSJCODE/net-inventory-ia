import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { mapWithConcurrency } from "@/lib/network/concurrency";
import { STATUS_CATALOG } from "./catalog";
import { ensureCatalogSeeded } from "./collector";
import { DETECTED_ORIGIN, planDetected } from "./detected";
import {
  AGENT_VANTAGE_PREFIX,
  BASELINE_REFRESH_MS,
  BASELINE_WINDOW_MS,
  CLEARED_TARGET_DATA,
  CONNECTIVITY_SETTING,
  SERVER_VANTAGE,
  TARGET_CACHE_MS,
  advanceAgenda,
  agentRollupWindows,
  mergeWindows,
  buildRollups,
  cleanupCutoffs,
  clearedServiceData,
  connectivityValue,
  groupBaseline,
  hydrateTarget,
  isInternetTarget,
  isPausedTarget,
  isStale,
  maintenanceDue,
  nextConnectivity,
  nextEvidenceStep,
  pauseServiceTargets,
  pauseToWrite,
  pausedReason,
  pausedRoundDue,
  pausedRoundTargets,
  pausedServiceData,
  pausedTargetData,
  planRollup,
  probesEnabled,
  realignAgenda,
  reconcileTargets,
  recordTick,
  respreadServices,
  ringMaxAgeMs,
  selectDue,
  serviceData,
  settlePausedRound,
  sortByCatalog,
  storedConnectivity,
  type ConnectivityDecision,
  type LoadedTarget,
  type Measurement,
  type TargetState,
  type TickOutcome,
  type TickProgress,
} from "./probe-logic";
import { defaultGateway, runProbe } from "./probes";
import { BUCKET_MS, WINDOW_SIZE, type RecentCheck } from "./stats";
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
  /** O estado da conexão que o banco guarda (`connectivityValue`), até onde este processo sabe; null antes da leitura ao subir. */
  savedConnectivity: string | null;
  /** Leitura, ao subir, do estado da conexão que o processo anterior deixou gravado (uma por processo). */
  resumed?: Promise<void>;
  /** Marcação de pausa que o banco ainda não aceitou: o passo seguinte tenta gravar de novo. */
  pendingPause: PausedState | null;
  pausedRoundAt: number;
  /** Contador que troca os canários a cada rodada de evidência. */
  rotation: number;
  /** Início da última janela de 5 min já resumida; null até a primeira passada. */
  lastRolled: number | null;
  /** O mesmo para as medições dos agentes Windows; null até a primeira passada deste processo. */
  agentLastRolled: number | null;
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
    savedConnectivity: null,
    pendingPause: null,
    pausedRoundAt: 0,
    rotation: 0,
    lastRolled: null,
    agentLastRolled: null,
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
  const age = now - (r.logged.get(message) ?? 0);
  // Idade negativa: o relógio do sistema voltou, e a mensagem sai em vez de ficar calada até ele alcançar a hora antiga.
  if (age >= 0 && age < LOG_EVERY_MS) return;
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

/**
 * Começa do estado da conexão que o processo anterior deixou gravado (ver `storedConnectivity`): quem
 * sobe durante uma queda segue com ela fora, com o mesmo motivo e desde a mesma hora, e o primeiro
 * passo é uma rodada de verificação em vez de medir os serviços. Uma leitura por processo, antes de
 * qualquer passo e de qualquer resposta à página; se o banco recusar, quem pedir em seguida lê de novo.
 */
function resumeConnectivity(r: RunnerState): Promise<void> {
  r.resumed ??= prisma.appSetting
    .findUnique({ where: { key: CONNECTIVITY_SETTING } })
    .then((row) => {
      r.connectivity = storedConnectivity(row?.value);
      r.savedConnectivity = connectivityValue(r.connectivity);
      if (r.connectivity.state !== "ok") console.warn(`[global-status] o servidor parou com a conexão local fora: ${r.connectivity.reason}`);
    })
    .catch((err) => {
      r.resumed = undefined;
      throw err;
    });
  return r.resumed;
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

/**
 * Últimas medições de cada alvo que o banco guarda como pausado (o servidor parou durante uma queda da
 * conexão local), de qualquer idade e da mais nova para a mais velha: nada foi medido durante a pausa,
 * então são elas as medições recentes que o alvo tinha em memória (ver `hydrateTarget`). Uma consulta
 * por alvo, pelo índice (targetId, at); só acontece nessa partida.
 */
async function lastChecksOfPaused(targets: TargetState[]): Promise<Map<string, RecentCheck[]>> {
  const last = new Map<string, RecentCheck[]>();
  for (const t of targets.filter(isPausedTarget)) {
    const rows = await prisma.probeCheck.findMany({
      where: { targetId: t.id, vantage: SERVER_VANTAGE },
      orderBy: { at: "desc" },
      take: WINDOW_SIZE,
      select: { ok: true, latencyMs: true, lossPct: true, certDays: true },
    });
    last.set(t.id, rows);
  }
  return last;
}

/**
 * Histórico dos alvos que acabaram de entrar em memória: as medições recentes e, nos de Internet, se já
 * responderam alguma vez. Os gravados como pausados recebem também as últimas medições, de qualquer idade.
 */
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

  const lastChecks = await lastChecksOfPaused(fresh);
  for (const t of fresh) {
    targets.set(t.id, hydrateTarget(t, { checks: checks.get(t.id) ?? [], everOk: answered.has(t.id), lastChecks: lastChecks.get(t.id) }, now));
  }
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
  await resumeConnectivity(r);
  const now = Date.now();
  await refreshTargets(r, now, force);
  await refreshBaselines(r, now);
  // Se o relógio do sistema voltou, os vencimentos que ficaram longe no futuro voltam para dentro do intervalo.
  r.targets = realignAgenda(r.targets, now);

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
    if (connectivity.state !== "ok" && (change === "lost" || change === "moved")) {
      r.targets = pauseServiceTargets(r.targets, pausedReason(connectivity.state));
      if (change === "lost") r.pausedRoundAt = decidedAt;
      console.warn(`[global-status] conexão local fora: ${connectivity.reason}`);
    } else if (change === "restored") {
      // Nada é gravado na volta: o próximo resultado de cada alvo o julga de novo.
      r.targets = respreadServices(r.targets, decidedAt);
      console.log("[global-status] conexão local restabelecida");
    }
    // A marcação de pausa fica pendente até o banco aceitar: se a gravação falhar, a próxima rodada repete.
    r.pendingPause = pauseToWrite(r.pendingPause, connectivity, change);
    // O estado da conexão vai junto enquanto difere do que o banco guarda: é dele que o próximo processo começa.
    const value = connectivityValue(connectivity);
    if (await persist(r, outcome, r.pendingPause, value === r.savedConnectivity ? null : value)) {
      r.pendingPause = null;
      r.savedConnectivity = value;
    }
  }
  await maintain(r);
}

/**
 * Grava o passo numa chamada só da fila de escrita. Falhou: tenta mais uma vez depois de 500 ms e, se
 * falhar de novo, descarta as medições do passo. Devolve se ficou gravado (ou se não havia o que gravar).
 */
async function persist(r: RunnerState, outcome: TickOutcome, pause: PausedState | null, connectivity: string | null): Promise<boolean> {
  if (!pause && !connectivity && !outcome.targetUpdates.length) return true;
  return serialized(async () => {
    try {
      await writeTick(outcome, pause, connectivity);
      return true;
    } catch {
      await sleep(WRITE_RETRY_MS);
      try {
        await writeTick(outcome, pause, connectivity);
        return true;
      } catch (err) {
        const message = `[global-status] medições não gravadas (o estado em memória segue valendo): ${errorText(err)}`;
        report(r, message, () => console.warn(message));
        return false;
      }
    }
  });
}

/**
 * Uma transação com as medições, os alvos e os serviços do passo; ao entrar em pausa, a marcação de
 * todos os serviços; e o estado da conexão (`connectivity`), quando o banco ainda não guarda o atual.
 */
async function writeTick(outcome: TickOutcome, pause: PausedState | null, connectivity: string | null): Promise<void> {
  const now = new Date();
  const touched = outcome.services.map((s) => s.serviceId);
  // Lidos aqui dentro da fila: o coletor pode ter mudado o estado oficial e o status desde o começo do passo.
  const current = await prisma.statusService.findMany({
    // Na pausa entram os serviços medidos (os da faixa "Internet no Brasil" não têm alvos: a visão deles é de fora).
    where: pause ? { OR: [{ id: { in: touched } }, { category: { not: "INTERNET" }, targets: { some: {} } }] } : { id: { in: touched } },
    select: { id: true, category: true, officialState: true, status: true },
  });
  const byId = new Map(current.map((s) => [s.id, s]));
  // Incidentes detectados só dos provedores: a conexão do próprio servidor aparece na faixa "Sua Internet".
  const judged = outcome.services.filter((s) => byId.get(s.serviceId)?.category !== "INTERNET").map((s) => s.serviceId);
  const openDetected = judged.length
    ? await prisma.statusIncident.findMany({ where: { serviceId: { in: judged }, origin: DETECTED_ORIGIN, resolvedAt: null }, select: { id: true, serviceId: true, impact: true, state: true, updatedAt: true } })
    : [];
  const detectedBy = new Map(openDetected.map((i) => [i.serviceId, i]));

  const writes: Prisma.PrismaPromise<unknown>[] = [];
  if (outcome.rows.length) writes.push(prisma.probeCheck.createMany({ data: outcome.rows }));
  for (const { id, data } of outcome.targetUpdates) writes.push(prisma.probeTarget.updateMany({ where: { id }, data }));
  for (const s of outcome.services) {
    const row = byId.get(s.serviceId);
    if (row) writes.push(prisma.statusService.updateMany({ where: { id: s.serviceId }, data: serviceData(s.summary, row, { sourceType: s.sourceType, at: s.at, now }) }));
    if (!row || row.category === "INTERNET") continue;
    const plan = planDetected(detectedBy.get(s.serviceId) ?? null, s.summary, now);
    if (plan.kind === "create") writes.push(prisma.statusIncident.create({ data: { serviceId: s.serviceId, origin: DETECTED_ORIGIN, url: null, resolvedAt: null, ...plan.data } }));
    else if (plan.kind === "update") writes.push(prisma.statusIncident.updateMany({ where: { id: plan.id }, data: plan.data }));
  }
  if (pause) {
    // Os cards passam a mostrar só o status oficial; os alvos de serviço ficam "Sem dados" com a frase da pausa.
    const paused = current.filter((s) => s.category !== "INTERNET");
    writes.push(prisma.probeTarget.updateMany({ where: { serviceId: { in: paused.map((s) => s.id) } }, data: pausedTargetData(pause) }));
    for (const s of paused) writes.push(prisma.statusService.updateMany({ where: { id: s.id }, data: pausedServiceData(s, pause, now) }));
  }
  if (connectivity) writes.push(prisma.appSetting.upsert({ where: { key: CONNECTIVITY_SETTING }, create: { key: CONNECTIVITY_SETTING, value: connectivity }, update: { value: connectivity } }));
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
    await rollUpAgents(r, now).catch((err) => {
      const message = `[global-status] falha ao resumir as medições dos agentes: ${errorText(err)}`;
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
  const plan = planRollup(known, now);
  if (!plan) return;
  const { windows } = plan;
  if (!windows.length) {
    r.lastRolled = plan.lastRolled;
    return;
  }
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
  r.lastRolled = plan.lastRolled;
}

/**
 * Resumo dos agentes Windows (fase 3). Duas partes numa passada: as janelas ainda não resumidas (ao subir,
 * continua de onde o banco parou, como o resumo do servidor, para não perder o que o host .NET gravou
 * enquanto o motor estava parado) e as últimas janelas fechadas de novo, porque o lote do agente chega até
 * um minuto depois da medição e pode atrasar com a rede do PC. O upsert deixa a repetição sem efeito.
 */
async function rollUpAgents(r: RunnerState, now: number): Promise<void> {
  const agents = { vantage: { startsWith: AGENT_VANTAGE_PREFIX } };
  let known = { lastRolled: r.agentLastRolled, newestRollup: null as number | null, oldestCheck: null as number | null };
  if (known.lastRolled === null) {
    const newest = await prisma.probeRollup.findFirst({ where: agents, orderBy: { bucket: "desc" }, select: { bucket: true } });
    const oldest = newest ? null : await prisma.probeCheck.findFirst({ where: agents, orderBy: { at: "asc" }, select: { at: true } });
    known = { lastRolled: null, newestRollup: newest?.bucket.getTime() ?? null, oldestCheck: oldest?.at.getTime() ?? null };
  }
  const plan = planRollup(known, now);
  const windows = mergeWindows(plan?.windows ?? [], agentRollupWindows(now));
  await serialized(async () => {
    const checks = await prisma.probeCheck.findMany({
      where: { ...agents, at: { gte: new Date(windows[0]), lt: new Date(windows[windows.length - 1] + BUCKET_MS) } },
      select: { targetId: true, vantage: true, at: true, ok: true, latencyMs: true, lossPct: true },
    });
    const rows = buildRollups(checks, windows);
    if (!rows.length) return;
    await prisma.$transaction(
      rows.map(({ targetId, vantage, bucket, ...stats }) =>
        prisma.probeRollup.upsert({ where: { targetId_vantage_bucket: { targetId, vantage, bucket } }, create: { targetId, vantage, bucket, ...stats }, update: stats }),
      ),
    );
  });
  if (plan) r.agentLastRolled = plan.lastRolled;
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

/**
 * Com as medições desligadas, apaga o que elas deixaram nos serviços e nos alvos: ninguém mais atualiza
 * o estado medido, e sem isso o último (um "fora do ar", por exemplo) ficaria nos cards para sempre. O
 * estado gravado da conexão sai junto: religadas, as medições não retomam uma queda de antes. O
 * histórico (medições e janelas) fica onde está e sai pela idade quando as medições forem religadas.
 */
async function clearMeasuredState(): Promise<void> {
  // Espera a gravação do catálogo que sobe junto, mas não depende dela: a limpeza só mexe em linhas que
  // já existem. Se o banco recusar o catálogo, quem pedir de novo (o coletor, a página) grava depois.
  await ensureCatalogSeeded().catch(() => undefined);
  const clear = async () => {
    const now = new Date();
    const services = await prisma.statusService.findMany({
      where: { OR: [{ measuredStatus: { not: null } }, { measuredReason: { not: null } }, { latencyMs: { not: null } }] },
      select: { id: true, officialState: true, status: true },
    });
    const writes: Prisma.PrismaPromise<unknown>[] = services.map((s) => prisma.statusService.updateMany({ where: { id: s.id }, data: clearedServiceData(s, now) }));
    writes.push(prisma.probeTarget.updateMany({ where: { OR: [{ status: { not: "UNKNOWN" } }, { statusReason: { not: null } }, { lastLatencyMs: { not: null } }, { lastError: { not: null } }] }, data: CLEARED_TARGET_DATA }));
    writes.push(prisma.appSetting.deleteMany({ where: { key: CONNECTIVITY_SETTING } }));
    // Sem medições ninguém mais fecharia os incidentes detectados: fecham agora.
    writes.push(prisma.statusIncident.updateMany({ where: { origin: DETECTED_ORIGIN, resolvedAt: null }, data: { state: "resolved", resolvedAt: now } }));
    await prisma.$transaction(writes);
  };
  // Como as gravações de um passo: uma segunda tentativa depois de 500 ms (o banco pode estar ocupado ao subir).
  await serialized(async () => {
    try {
      await clear();
    } catch {
      await sleep(WRITE_RETRY_MS);
      await clear();
    }
  });
}

/** Inicia o agendador (uma vez por processo, via instrumentation). `GLOBAL_STATUS_PROBES=off` desliga. */
export function startProbeRunner(): void {
  const r = runner();
  if (r.started) return;
  r.started = true;
  if (!probesEnabled(process.env.GLOBAL_STATUS_PROBES)) {
    console.log("[global-status] medições próprias desligadas (GLOBAL_STATUS_PROBES=off)");
    void clearMeasuredState().catch((err) => console.warn(`[global-status] o estado medido antes de desligar as medições não foi apagado: ${errorText(err)}`));
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

/**
 * Estado da conexão do próprio servidor, para a faixa "Sua Internet". Num processo que acabou de subir
 * espera a leitura do estado gravado (ver `resumeConnectivity`): a página não vê "ok" antes de o
 * agendador saber como o processo anterior parou. Com as medições desligadas não há o que ler.
 */
export async function getLocalConnectivity(): Promise<LocalConnectivity> {
  const r = runner();
  // Uma leitura que o banco recusa não derruba a consulta da página: vale o que o agendador sabe, e quem pedir depois lê de novo.
  if (probesEnabled(process.env.GLOBAL_STATUS_PROBES)) await resumeConnectivity(r).catch(() => undefined);
  return { ...r.connectivity };
}
