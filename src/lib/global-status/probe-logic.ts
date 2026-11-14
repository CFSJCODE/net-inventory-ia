import { isIP } from "node:net";
import type { CatalogEntry } from "./catalog";
import { BUCKET_MS, WINDOW_SIZE, aggregateChecks, bucketStart, certWarningFor, evaluateTarget, type BucketStats, type CheckSample, type RecentCheck } from "./stats";
import {
  AUTO_GATEWAY,
  STATUS_SEVERITY,
  combineStatus,
  targetLabel,
  worstStatus,
  type LocalConnectivity,
  type ProbeKind,
  type ProbePhase,
  type ProbeResult,
  type ServiceStatus,
  type TargetStatus,
} from "./types";

/**
 * Regras do agendador das medições próprias, sem E/S: nada aqui toca rede, banco ou timer, e a hora
 * entra sempre como argumento. O `probe-runner.ts` só liga estas funções ao timer, às sondas e ao
 * banco; por isso cada regra tem um teste em `probe-logic.test.ts`.
 */

// ---------------------------------------------------------------- números do plano

/** A lista de alvos é relida do banco a cada 5 min (ou num passo forçado). */
export const TARGET_CACHE_MS = 5 * 60_000;
/** A linha de base de latência é relida a cada 5 min: é o ritmo em que as janelas fecham. */
export const BASELINE_REFRESH_MS = 5 * 60_000;
/** A linha de base olha as últimas 24 h. */
export const BASELINE_WINDOW_MS = 24 * 60 * 60_000;
/** Com a conexão local fora, uma rodada de verificação a cada 30 s. */
export const PAUSED_ROUND_MS = 30_000;
/** Canários por rodada de evidência. */
export const CANARY_COUNT = 3;
/** Âncoras necessárias para valerem como testemunhas da saída para a Internet. */
export const MIN_ANCHORS = 2;
/** Serviços diferentes falhando juntos para a causa ser tratada como local. */
export const SERVICES_FOR_LOCAL_CAUSE = 3;
/** Janelas são resumidas no máximo uma vez por minuto. */
export const ROLLUP_EVERY_MS = 60_000;
/** Folga depois do fim da janela: uma sonda que começou dentro dela ainda pode estar gravando. */
export const ROLLUP_SETTLE_MS = 60_000;
/** Janelas por passada: recuperar o atraso depois de uma parada não pode segurar o banco. */
export const MAX_ROLLUP_WINDOWS = 24;
/** A limpeza do histórico roda uma vez por hora. */
export const CLEANUP_EVERY_MS = 60 * 60_000;
/** Medições cruas ficam 48 h. */
export const CHECK_RETENTION_MS = 48 * 60 * 60_000;
/** Janelas de 5 min ficam 30 dias. */
export const ROLLUP_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Ponto de vista das medições feitas por este servidor (os agentes da fase 3 gravam o próprio id). */
export const SERVER_VANTAGE = "server";
/** Tamanho máximo do erro gravado numa medição. */
export const ERROR_MAX_LENGTH = 200;

/** `GLOBAL_STATUS_PROBES=off` desliga as medições; qualquer outro valor (ou nenhum) deixa ligado. */
export function probesEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "off";
}

// ---------------------------------------------------------------- alvos

/** O que o agendador sabe de um alvo: a linha de ProbeTarget e o serviço dono. */
export interface TargetInfo {
  id: string;
  serviceId: string;
  serviceSlug: string;
  /** Categoria do serviço; "INTERNET" marca os alvos que medem a conexão do próprio servidor. */
  category: string;
  /** Fonte oficial do serviço; "NONE" = o estado do card vem só das medições. */
  sourceType: string;
  key: string;
  kind: ProbeKind;
  host: string;
  url: string | null;
  port: number | null;
  intervalSec: number;
}

/** Alvo como veio do banco: a ficha e o último estado gravado. */
export interface LoadedTarget extends TargetInfo {
  status: string;
  statusReason: string | null;
  lastLatencyMs: number | null;
}

/** Estado em memória de um alvo. */
export interface TargetState extends TargetInfo {
  /** Próxima medição (ms desde 1970). */
  dueAt: number;
  /** Últimas medições, mais nova primeiro (até WINDOW_SIZE). */
  ring: RecentCheck[];
  status: TargetStatus;
  reason: string | null;
  lastLatencyMs: number | null;
  /** Alvos de Internet: já respondeu alguma vez. Enquanto não, a falta de resposta é bloqueio na rede, não queda. */
  everOk: boolean;
}

/** Uma medição de um passo: o alvo como estava ao medir, o instante em que a sonda começou e o resultado. */
export interface Measurement {
  target: TargetState;
  at: Date;
  result: ProbeResult;
}

/** Alvo de Internet: mede a conexão do próprio servidor (gateway, DNS do sistema e resolvedores públicos). */
export function isInternetTarget(target: Pick<TargetInfo, "category">): boolean {
  return target.category === "INTERNET";
}

/** Âncora: alvo de Internet com IP literal (os resolvedores públicos), que responde sem depender de DNS. */
export function isAnchor(target: Pick<TargetInfo, "category" | "host">): boolean {
  return isInternetTarget(target) && isIP(target.host) !== 0;
}

/** O alvo de Internet que mede o gateway padrão. */
export function isGatewayTarget(target: Pick<TargetInfo, "category" | "host">): boolean {
  return isInternetTarget(target) && target.host === AUTO_GATEWAY;
}

function asTargetStatus(value: string): TargetStatus {
  return value === "OK" || value === "DEGRADED" || value === "DOWN" ? value : "UNKNOWN";
}

function asServiceStatus(value: string | null | undefined): ServiceStatus | null {
  return value && Object.hasOwn(STATUS_SEVERITY, value) ? (value as ServiceStatus) : null;
}

/**
 * Ordena os alvos como no catálogo: serviços na ordem do catálogo e, dentro de cada um, os alvos na
 * ordem em que foram declarados (chaves fora do catálogo por último). É a ordem que decide qual alvo
 * dá o motivo e a latência do serviço.
 */
export function sortByCatalog<T extends Pick<TargetInfo, "serviceSlug" | "key">>(targets: readonly T[], catalog: readonly Pick<CatalogEntry, "slug" | "targets">[]): T[] {
  const place = new Map<string, { index: number; keys: string[] }>();
  catalog.forEach((entry, index) => place.set(entry.slug, { index, keys: entry.targets.map((t) => t.key) }));
  const last = Number.MAX_SAFE_INTEGER;
  const rank = (t: T): [number, number] => {
    const entry = place.get(t.serviceSlug);
    const key = entry ? entry.keys.indexOf(t.key) : -1;
    return [entry ? entry.index : last, key === -1 ? last : key];
  };
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...targets].sort((a, b) => {
    const [serviceA, keyA] = rank(a);
    const [serviceB, keyB] = rank(b);
    return serviceA - serviceB || text(a.serviceSlug, b.serviceSlug) || keyA - keyB || text(a.key, b.key);
  });
}

// ---------------------------------------------------------------- agenda

const intervalMs = (intervalSec: number) => Math.max(1, intervalSec) * 1000;

/**
 * Primeira medição de cada alvo. Os alvos de mesmo intervalo são espalhados dentro do intervalo (no
 * máximo 60 s, para tudo ter um primeiro valor no primeiro minuto): em um grupo de m alvos ordenados
 * por id, o alvo j vence em início + (j ÷ m) × min(intervalo, 60 s). Sem isso todos venceriam juntos,
 * a cada intervalo, para sempre.
 */
export function firstDueTimes(targets: readonly Pick<TargetInfo, "id" | "intervalSec">[], start: number): Map<string, number> {
  const groups = new Map<number, string[]>();
  for (const t of targets) groups.set(t.intervalSec, [...(groups.get(t.intervalSec) ?? []), t.id]);
  const due = new Map<string, number>();
  for (const [intervalSec, ids] of groups) {
    const span = Math.min(intervalMs(intervalSec), 60_000);
    // Ordem de código dos caracteres, igual em qualquer sistema (localeCompare muda com o idioma).
    ids.sort();
    ids.forEach((id, j) => due.set(id, start + Math.round((j / ids.length) * span)));
  }
  return due;
}

/**
 * Próximo vencimento depois de uma medição: vencimento anterior + intervalo, o que mantém o alvo no
 * seu lugar da agenda mesmo quando o passo atrasa alguns segundos. Se isso já passou (o servidor
 * ficou parado), é agora + intervalo: as medições perdidas são puladas, nunca feitas em rajada.
 */
export function nextDueTime(previousDue: number, intervalSec: number, now: number): number {
  const next = previousDue + intervalMs(intervalSec);
  return next > now ? next : now + intervalMs(intervalSec);
}

/**
 * Vencimento de um alvo depois de medido no passo que começou em `now`. Passo forçado ("Atualizar
 * agora") e medição fora de hora (rodada de evidência) deixam a agenda como estava, para o
 * espalhamento sobreviver.
 */
export function dueAfterRun(dueAt: number, intervalSec: number, now: number, options: { force?: boolean } = {}): number {
  if (options.force || dueAt > now) return dueAt;
  return nextDueTime(dueAt, intervalSec, now);
}

/** Os alvos a medir no passo que começa em `now`: os vencidos, ou todos num passo forçado. */
export function selectDue<T extends { dueAt: number }>(targets: readonly T[], now: number, force = false): T[] {
  return force ? [...targets] : targets.filter((t) => t.dueAt <= now);
}

/** Avança a agenda dos alvos medidos (ver `dueAfterRun`). */
export function advanceAgenda(targets: ReadonlyMap<string, TargetState>, measuredIds: Iterable<string>, now: number, options: { force?: boolean } = {}): Map<string, TargetState> {
  const next = new Map(targets);
  for (const id of measuredIds) {
    const state = next.get(id);
    if (state) next.set(id, { ...state, dueAt: dueAfterRun(state.dueAt, state.intervalSec, now, options) });
  }
  return next;
}

/** A lista em memória (alvos ou linha de base) precisa ser relida: nunca foi, ficou velha ou o passo é forçado. */
export function isStale(loadedAt: number, now: number, maxAgeMs: number, force = false): boolean {
  return force || loadedAt <= 0 || now - loadedAt >= maxAgeMs;
}

/**
 * Junta a lista relida do banco com o estado em memória: alvo novo ganha um primeiro vencimento e o
 * último estado gravado na linha; alvo que sumiu (ou foi desabilitado) é descartado; os demais mantêm
 * agenda, medições recentes e estado, só com a ficha atualizada. `added` são os ids novos, que ainda
 * precisam do histórico (`hydrateTarget`).
 */
export function reconcileTargets(previous: ReadonlyMap<string, TargetState>, loaded: readonly LoadedTarget[], now: number): { targets: Map<string, TargetState>; added: string[] } {
  const firstDue = firstDueTimes(loaded, now);
  const targets = new Map<string, TargetState>();
  const added: string[] = [];
  for (const row of loaded) {
    const { status, statusReason, lastLatencyMs, ...info } = row;
    const kept = previous.get(row.id);
    if (kept) {
      targets.set(row.id, { ...kept, ...info });
      continue;
    }
    added.push(row.id);
    targets.set(row.id, { ...info, dueAt: firstDue.get(row.id) ?? now, ring: [], status: asTargetStatus(status), reason: statusReason, lastLatencyMs, everOk: false });
  }
  return { targets, added };
}

/**
 * Idade máxima das medições que entram no estado inicial de um alvo: 10 intervalos, no mínimo 10 min.
 * Mais velhas que isso são de outra época (antes de uma parada do servidor) e não se misturam às novas.
 */
export function ringMaxAgeMs(intervalSec: number): number {
  return Math.max(10 * intervalMs(intervalSec), 10 * 60_000);
}

/** As medições recentes de um alvo ao carregar: as `WINDOW_SIZE` mais novas dentro de `ringMaxAgeMs`, mais nova primeiro. */
export function initialRing(checks: readonly (RecentCheck & { at: Date })[], intervalSec: number, now: number): RecentCheck[] {
  const cutoff = now - ringMaxAgeMs(intervalSec);
  return checks
    .filter((c) => c.at.getTime() >= cutoff)
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, WINDOW_SIZE)
    .map(({ ok, latencyMs, lossPct, certDays }) => ({ ok, latencyMs, lossPct, certDays }));
}

/** Completa um alvo recém-carregado com o histórico do banco: as medições recentes e se já respondeu alguma vez. */
export function hydrateTarget(state: TargetState, history: { checks: readonly (RecentCheck & { at: Date })[]; everOk: boolean }, now: number): TargetState {
  return { ...state, ring: initialRing(history.checks, state.intervalSec, now), everOk: history.everOk };
}

/**
 * Ao voltar de uma pausa os alvos de serviço ganham vencimentos novos, espalhados como na partida:
 * todos ficaram vencidos durante a pausa e, sem isso, disparariam juntos no mesmo passo.
 */
export function respreadServices(targets: ReadonlyMap<string, TargetState>, now: number): Map<string, TargetState> {
  const services = [...targets.values()].filter((t) => !isInternetTarget(t));
  const due = firstDueTimes(services, now);
  const next = new Map(targets);
  for (const t of services) next.set(t.id, { ...t, dueAt: due.get(t.id) ?? now });
  return next;
}

// ---------------------------------------------------------------- conexão local ("sua Internet está fora")

/** Resultado de um alvo de serviço, como evidência sobre a conexão local. */
export interface ServiceEvidence {
  serviceId: string;
  ok: boolean;
  failedAt: ProbePhase | null;
}

export interface ConnectivityEvidence {
  /** Resultados dos alvos de serviço do passo, mais os canários. */
  services: ServiceEvidence[];
  /** Resultados recentes das âncoras mensuráveis. */
  anchors: { ok: boolean }[];
  /** Resultado do alvo do gateway quando ele é mensurável; null sem evidência do gateway. */
  gateway: { ok: boolean; ip: string | null } | null;
}

export interface ConnectivityDecision {
  state: LocalConnectivity["state"];
  /** Frase da faixa "Sua Internet"; null quando ok. */
  reason: string | null;
}

const CONNECTED: ConnectivityDecision = { state: "ok", reason: null };
export const DNS_REASON = "O DNS deste servidor não está resolvendo nomes.";

function offlineReason(gateway: ConnectivityEvidence["gateway"]): string {
  if (!gateway) return "Este servidor não alcança a Internet.";
  if (gateway.ok) return "O gateway responde, mas não há saída para a Internet.";
  return gateway.ip ? `O gateway ${gateway.ip} não responde.` : "O gateway padrão não responde.";
}

/**
 * Decide se as falhas de um passo são dos serviços ou da conexão deste servidor.
 *
 * Quando tudo falha junto a causa costuma ser local, mas uma queda grande de um provedor (Cloudflare,
 * AWS) também derruba vários serviços sem relação de uma vez, e é justamente aí que o painel importa.
 * Por isso os resolvedores públicos (as âncoras) são testemunhas independentes: se eles respondem, a
 * saída para a Internet funciona e as falhas são reais. As regras valem nesta ordem:
 *
 * 1. algum serviço respondeu: a conexão está ok;
 * 2. duas ou mais âncoras e nenhuma respondeu: sem Internet;
 * 3. menos de duas âncoras mensuráveis e falhas em 3 ou mais serviços diferentes: sem Internet (sem
 *    testemunhas, tantos serviços caindo juntos é mais provável ser daqui);
 * 4. falhas em 3 ou mais serviços diferentes, todas na resolução do nome: o DNS deste servidor não
 *    resolve (as âncoras respondem por IP, então a rota funciona);
 * 5. qualquer outro caso: a conexão está ok e as falhas são dos serviços.
 */
export function decideConnectivity(evidence: ConnectivityEvidence): ConnectivityDecision {
  const { services, anchors, gateway } = evidence;
  if (services.some((s) => s.ok)) return CONNECTED;
  const offline: ConnectivityDecision = { state: "offline", reason: offlineReason(gateway) };
  if (anchors.length >= MIN_ANCHORS && anchors.every((a) => !a.ok)) return offline;
  const manyServices = new Set(services.map((s) => s.serviceId)).size >= SERVICES_FOR_LOCAL_CAUSE;
  if (anchors.length < MIN_ANCHORS && manyServices) return offline;
  if (manyServices && services.every((s) => s.failedAt === "dns")) return { state: "dns", reason: DNS_REASON };
  return CONNECTED;
}

/** Os resultados de alvos de serviço como evidência. Sonda que não pôde rodar não prova nada e fica de fora. */
export function serviceEvidence(measurements: readonly Measurement[]): ServiceEvidence[] {
  return measurements
    .filter((m) => !isInternetTarget(m.target) && !m.result.unsupported)
    .map((m) => ({ serviceId: m.target.serviceId, ok: m.result.ok, failedAt: m.result.failedAt ?? null }));
}

/** Um passo só levanta suspeita sobre a conexão local quando mediu algum alvo de serviço e nenhum respondeu. */
export function needsEvidenceRound(services: readonly ServiceEvidence[]): boolean {
  return services.length > 0 && services.every((s) => !s.ok);
}

/**
 * Âncoras e gateway como evidência. Um alvo de Internet só é mensurável quando a sonda pôde rodar e
 * ele já respondeu alguma vez (antes, ou agora): numa rede que bloqueia ping ou a porta 53, a falta de
 * resposta não diz nada sobre a saída para a Internet.
 */
export function internetEvidence(measurements: readonly Measurement[], gatewayIp: string | null): Pick<ConnectivityEvidence, "anchors" | "gateway"> {
  const measurable = measurements.filter((m) => isInternetTarget(m.target) && !m.result.unsupported && (m.target.everOk || m.result.ok));
  const gateway = measurable.find((m) => isGatewayTarget(m.target));
  return {
    anchors: measurable.filter((m) => isAnchor(m.target)).map((m) => ({ ok: m.result.ok })),
    gateway: gateway ? { ok: gateway.result.ok, ip: gatewayIp } : null,
  };
}

/**
 * Escolhe os canários de uma rodada de evidência: alvos TCP de outros serviços, medidos só para saber
 * se a Internet responde (nunca gravados). Ficam de fora os serviços em `exclude` (os que falharam no
 * passo); entra um alvo por serviço, de categorias diferentes enquanto houver; `rotation` (um contador
 * que o agendador incrementa) muda a categoria inicial e o serviço dentro de cada categoria, para não
 * depender sempre dos mesmos três.
 */
export function pickCanaries<T extends Pick<TargetInfo, "serviceId" | "category" | "kind">>(
  candidates: readonly T[],
  options: { exclude?: Iterable<string>; count?: number; rotation?: number } = {},
): T[] {
  const exclude = new Set(options.exclude ?? []);
  const count = options.count ?? CANARY_COUNT;
  const rotation = Math.max(0, Math.floor(options.rotation ?? 0));

  // Um alvo TCP por serviço (o primeiro da lista), agrupado por categoria na ordem em que aparece.
  const byCategory = new Map<string, T[]>();
  const seen = new Set<string>();
  for (const c of candidates) {
    if (c.kind !== "TCP" || isInternetTarget(c) || exclude.has(c.serviceId) || seen.has(c.serviceId)) continue;
    seen.add(c.serviceId);
    byCategory.set(c.category, [...(byCategory.get(c.category) ?? []), c]);
  }
  const categories = [...byCategory.values()];

  const picked: T[] = [];
  // Primeiro uma categoria diferente por canário; a cada volta completa pelas categorias, o serviço seguinte de cada uma.
  for (let i = 0; i < categories.length && picked.length < count; i++) {
    const turn = rotation + i;
    const group = categories[turn % categories.length];
    picked.push(group[Math.floor(turn / categories.length) % group.length]);
  }
  // Faltando categorias, completa com outros serviços das mesmas.
  const rest = categories.flat().filter((c) => !picked.includes(c));
  for (let i = 0; i < rest.length && picked.length < count; i++) picked.push(rest[(rotation + i) % rest.length]);
  return picked;
}

/** O que um passo já mediu, na ordem em que a evidência é colhida. */
export interface TickProgress {
  /** Alvos vencidos (ou todos, num passo forçado). */
  measured: Measurement[];
  /** Canários; null = ainda não medidos. */
  canaries: Measurement[] | null;
  /** Alvos de Internet medidos na rodada de evidência; null = ainda não medidos. */
  internet: Measurement[] | null;
  /** IP do gateway padrão, para a frase da faixa; null quando não foi descoberto. */
  gatewayIp: string | null;
}

export type EvidenceStep =
  | { kind: "canaries"; targets: TargetState[] }
  | { kind: "internet"; targets: TargetState[] }
  | { kind: "done"; decision: ConnectivityDecision; record: Measurement[] };

/**
 * Próximo movimento de um passo com a conexão ok, dado o que já foi medido:
 *
 * - nenhum alvo de serviço medido, ou algum respondeu: fim, grava tudo;
 * - todos os serviços medidos falharam: medir os canários (serviços que não falharam neste passo);
 * - algum canário respondeu: fim, as falhas são reais e são gravadas;
 * - nenhum canário respondeu: medir os alvos de Internet que o passo ainda não mediu, para as âncoras
 *   e o gateway estarem frescos, e decidir com `decideConnectivity`;
 * - decisão "ok": grava o passo como está; "offline" ou "dns": os resultados dos serviços são
 *   descartados (a culpa não é deles) e só os de Internet são gravados.
 *
 * Canários são evidência e nunca entram em `record`.
 */
export function nextEvidenceStep(targets: readonly TargetState[], progress: TickProgress, rotation: number): EvidenceStep {
  const { measured, canaries, internet } = progress;
  const services = serviceEvidence(measured);
  if (!needsEvidenceRound(services)) return { kind: "done", decision: CONNECTED, record: measured };

  if (canaries === null) {
    const failed = services.map((s) => s.serviceId);
    return { kind: "canaries", targets: pickCanaries(targets, { exclude: failed, count: CANARY_COUNT, rotation }) };
  }
  const canaryEvidence = serviceEvidence(canaries);
  if (canaryEvidence.some((c) => c.ok)) return { kind: "done", decision: CONNECTED, record: measured };

  if (internet === null) {
    const already = new Set(measured.map((m) => m.target.id));
    return { kind: "internet", targets: targets.filter((t) => isInternetTarget(t) && !already.has(t.id)) };
  }
  const fresh = [...measured.filter((m) => isInternetTarget(m.target)), ...internet];
  const decision = decideConnectivity({ services: [...services, ...canaryEvidence], ...internetEvidence(fresh, progress.gatewayIp) });
  return { kind: "done", decision, record: decision.state === "ok" ? [...measured, ...internet] : fresh };
}

/** Com a conexão fora, a rodada de verificação roda a cada 30 s e em todo passo forçado. */
export function pausedRoundDue(lastRoundAt: number, now: number, force = false): boolean {
  return force || now - lastRoundAt >= PAUSED_ROUND_MS;
}

/** O que a rodada com a conexão fora mede: todos os alvos de Internet e 3 canários. Alvos de serviço ficam parados. */
export function pausedRoundTargets(targets: readonly TargetState[], rotation: number): { internet: TargetState[]; canaries: TargetState[] } {
  return { internet: targets.filter((t) => isInternetTarget(t)), canaries: pickCanaries(targets, { count: CANARY_COUNT, rotation }) };
}

/** Decide a rodada com a conexão fora: os canários fazem o papel dos serviços; só os resultados de Internet são gravados. */
export function settlePausedRound(internet: readonly Measurement[], canaries: readonly Measurement[], gatewayIp: string | null): { decision: ConnectivityDecision; record: Measurement[] } {
  const decision = decideConnectivity({ services: serviceEvidence(canaries), ...internetEvidence(internet, gatewayIp) });
  return { decision, record: [...internet] };
}

/** O que mudou na conexão local: caiu, voltou, trocou de tipo (sem Internet ↔ sem DNS) ou nada. */
export type ConnectivityChange = "none" | "lost" | "moved" | "restored";

/**
 * Aplica uma decisão ao estado da conexão. `since` marca quando ela saiu de "ok" e é mantido enquanto
 * continua fora, mesmo trocando de tipo; a frase acompanha a decisão mais recente.
 */
export function nextConnectivity(current: LocalConnectivity, decision: ConnectivityDecision, now: number): { connectivity: LocalConnectivity; change: ConnectivityChange } {
  if (decision.state === "ok") {
    if (current.state === "ok") return { connectivity: current, change: "none" };
    return { connectivity: { state: "ok", since: null, reason: null }, change: "restored" };
  }
  if (current.state === "ok") {
    return { connectivity: { state: decision.state, since: new Date(now).toISOString(), reason: decision.reason }, change: "lost" };
  }
  return { connectivity: { state: decision.state, since: current.since, reason: decision.reason }, change: current.state === decision.state ? "none" : "moved" };
}

// ---------------------------------------------------------------- pausa

/** Frase gravada nos serviços e nos alvos enquanto as medições estão pausadas. */
export function pausedReason(state: "offline" | "dns"): string {
  return state === "dns" ? "Medições pausadas: o DNS deste servidor não resolve nomes." : "Medições pausadas: sem Internet neste servidor.";
}

/** Em memória, os alvos de serviço ficam "Sem dados" com a frase da pausa; os de Internet seguem sendo medidos. */
export function pauseServiceTargets(targets: ReadonlyMap<string, TargetState>, reason: string): Map<string, TargetState> {
  const next = new Map<string, TargetState>();
  for (const [id, t] of targets) next.set(id, isInternetTarget(t) ? t : { ...t, status: "UNKNOWN", reason });
  return next;
}

export interface PausedServiceData {
  measuredStatus: "UNKNOWN";
  measuredReason: string;
  status: ServiceStatus;
  lastChangeAt?: Date;
}

/** Linha de um serviço ao pausar: o medido vira "Sem dados" e o card passa a mostrar só o status oficial. */
export function pausedServiceData(current: { officialState: string | null; status: string }, state: "offline" | "dns", now: Date): PausedServiceData {
  const status = combineStatus(asServiceStatus(current.officialState), "UNKNOWN");
  return { measuredStatus: "UNKNOWN", measuredReason: pausedReason(state), status, ...(status !== current.status ? { lastChangeAt: now } : {}) };
}

// ---------------------------------------------------------------- gravação e veredito

/** Uma linha de ProbeCheck. */
export interface CheckRow {
  targetId: string;
  vantage: string;
  at: Date;
  ok: boolean;
  latencyMs: number | null;
  httpStatus: number | null;
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  totalMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  certDays: number | null;
  error: string | null;
}

/** O que muda na linha do alvo a cada medição. */
export interface TargetUpdate {
  status: TargetStatus;
  statusReason: string | null;
  lastCheckAt: Date;
  lastLatencyMs: number | null;
  lastError: string | null;
}

export interface RecordedResult {
  /** Estado do alvo em memória depois do resultado. */
  state: TargetState;
  /** Linha de ProbeCheck; null quando o resultado não vira medição. */
  row: CheckRow | null;
  update: TargetUpdate;
}

// Um número que não é finito derrubaria a gravação do passo inteiro: vira ausência.
const finite = (value: number | null | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const whole = (value: number | null | undefined): number | null => (finite(value) === null ? null : Math.floor(value as number));
const cutError = (error: string | null | undefined): string | null => (error ? error.slice(0, ERROR_MAX_LENGTH) : null);

/** Frase de um alvo de Internet que nunca respondeu: provavelmente a rede bloqueia esse tipo de tráfego. */
export function neverAnsweredReason(kind: ProbeKind): string {
  if (kind === "ICMP") return "Sem resposta a ping até agora (o ICMP pode estar bloqueado nesta rede).";
  if (kind === "DNS") return "Sem resposta a consultas DNS até agora (o DNS externo pode estar bloqueado nesta rede).";
  return "Sem resposta até agora (este acesso pode estar bloqueado nesta rede).";
}

/** Resultado que não vira medição: o alvo fica "Sem dados" com o motivo, e o histórico não muda. */
function unmeasured(state: TargetState, at: Date, reason: string, error: string | null): RecordedResult {
  return {
    state: { ...state, status: "UNKNOWN", reason, lastLatencyMs: null },
    row: null,
    update: { status: "UNKNOWN", statusReason: reason, lastCheckAt: at, lastLatencyMs: null, lastError: error },
  };
}

/**
 * Grava um resultado e julga o alvo.
 *
 * - Sonda que não pôde rodar (`unsupported`): não é medição; o alvo fica "Sem dados" com o motivo.
 * - Alvo de Internet que nunca respondeu e falhou de novo: também não é medição. Um roteador que
 *   descarta ping ou um firewall que bloqueia a porta 53 não pode aparecer como queda permanente com
 *   0% de disponibilidade. A partir da primeira resposta o alvo conta normalmente.
 * - Nos demais casos: uma linha de ProbeCheck, a medição entra na frente das recentes e o veredito sai
 *   de `evaluateTarget` com a linha de base do alvo.
 */
export function recordResult(state: TargetState, result: ProbeResult, at: Date, baseline: readonly number[] = []): RecordedResult {
  const error = cutError(result.error);
  if (result.unsupported) return unmeasured(state, at, error ?? "A sonda não pôde rodar neste servidor.", error);
  if (isInternetTarget(state) && !state.everOk && !result.ok) return unmeasured(state, at, neverAnsweredReason(state.kind), error);

  const ok = result.ok;
  const latencyMs = ok ? finite(result.latencyMs) : null;
  const check: RecentCheck = { ok, latencyMs, lossPct: finite(result.lossPct), certDays: whole(result.certDays) };
  const ring = [check, ...state.ring].slice(0, WINDOW_SIZE);
  // O aviso de vencimento acompanha a validade total do certificado (um de 6 dias não fica em aviso permanente).
  const verdict = evaluateTarget(ring, [...baseline], { certWarningDays: certWarningFor(result.certLifetimeDays) });
  const lastError = ok ? null : error;
  return {
    state: { ...state, ring, status: verdict.status, reason: verdict.reason, lastLatencyMs: latencyMs, everOk: state.everOk || ok },
    row: {
      targetId: state.id,
      vantage: SERVER_VANTAGE,
      at,
      ok,
      latencyMs,
      httpStatus: whole(result.httpStatus),
      dnsMs: finite(result.dnsMs),
      connectMs: finite(result.connectMs),
      tlsMs: finite(result.tlsMs),
      ttfbMs: finite(result.ttfbMs),
      totalMs: finite(result.totalMs),
      lossPct: check.lossPct,
      jitterMs: finite(result.jitterMs),
      certDays: check.certDays,
      error: lastError,
    },
    update: { status: verdict.status, statusReason: verdict.reason, lastCheckAt: at, lastLatencyMs: latencyMs, lastError },
  };
}

export interface ServiceSummary {
  measuredStatus: ServiceStatus;
  measuredReason: string | null;
  latencyMs: number | null;
}

/** Tipos de alvo que dão a latência de rede do serviço, nesta ordem. HTTP nunca: o tempo dele inclui o trabalho do servidor. */
const LATENCY_KINDS: ProbeKind[] = ["TCP", "ICMP", "TLS", "DNS"];

const labelled = (target: Pick<TargetState, "kind" | "port" | "reason">) => `${targetLabel(target)}: ${target.reason}`;

/**
 * Resume um serviço a partir de todos os seus alvos (na ordem do catálogo).
 *
 * - Estado medido: o pior entre os alvos com estado conhecido; "Sem dados" quando nenhum tem.
 * - Motivo: "<rótulo do alvo>: <motivo>" do primeiro alvo nesse pior estado; nenhum quando está tudo
 *   normal; com todos em "Sem dados", o primeiro motivo que houver.
 * - Latência: a última do primeiro alvo que tiver uma, procurando por tipo (TCP, ping, TLS, DNS).
 */
export function summarizeService(targets: readonly Pick<TargetState, "kind" | "port" | "status" | "reason" | "lastLatencyMs">[]): ServiceSummary {
  let latencyMs: number | null = null;
  for (const kind of LATENCY_KINDS) {
    const withLatency = targets.find((t) => t.kind === kind && t.lastLatencyMs !== null);
    if (withLatency) {
      latencyMs = withLatency.lastLatencyMs;
      break;
    }
  }

  const known = targets.filter((t) => t.status !== "UNKNOWN");
  if (!known.length) {
    const withReason = targets.find((t) => t.reason);
    return { measuredStatus: "UNKNOWN", measuredReason: withReason ? labelled(withReason) : null, latencyMs };
  }
  const measuredStatus = worstStatus(known.map((t) => t.status));
  const worst = measuredStatus === "OK" ? undefined : known.find((t) => t.status === measuredStatus);
  return { measuredStatus, measuredReason: worst?.reason ? labelled(worst) : null, latencyMs };
}

export interface ServiceData extends ServiceSummary {
  status: ServiceStatus;
  lastChangeAt?: Date;
  lastCheckAt?: Date;
}

/**
 * Linha de um serviço depois de um passo: o status do card é o pior entre o oficial e o medido (lidos
 * do banco na hora de gravar, porque o coletor grava em paralelo). `lastCheckAt` só é escrito para
 * serviços sem fonte oficial; nos outros essa coluna é do coletor.
 */
export function serviceData(summary: ServiceSummary, current: { officialState: string | null; status: string }, options: { sourceType: string; at: Date; now: Date }): ServiceData {
  const status = combineStatus(asServiceStatus(current.officialState), summary.measuredStatus);
  return {
    ...summary,
    status,
    ...(status !== current.status ? { lastChangeAt: options.now } : {}),
    ...(options.sourceType === "NONE" ? { lastCheckAt: options.at } : {}),
  };
}

/** Tudo que um passo produz: o estado novo em memória e o que vai para o banco numa transação só. */
export interface TickOutcome {
  targets: Map<string, TargetState>;
  rows: CheckRow[];
  targetUpdates: { id: string; data: TargetUpdate }[];
  /** Um resumo por serviço que teve resultado no passo; `at` é a medição mais nova dele. */
  services: { serviceId: string; sourceType: string; at: Date; summary: ServiceSummary }[];
}

/** Aplica os resultados de um passo ao estado em memória e monta as gravações (`recordResult` e `summarizeService`). */
export function recordTick(targets: ReadonlyMap<string, TargetState>, record: readonly Measurement[], baselines: ReadonlyMap<string, readonly number[]>): TickOutcome {
  const next = new Map(targets);
  const rows: CheckRow[] = [];
  const targetUpdates: TickOutcome["targetUpdates"] = [];
  const touched = new Map<string, { sourceType: string; at: Date }>();
  for (const m of record) {
    const state = next.get(m.target.id);
    if (!state) continue;
    const recorded = recordResult(state, m.result, m.at, baselines.get(state.id));
    next.set(state.id, recorded.state);
    if (recorded.row) rows.push(recorded.row);
    targetUpdates.push({ id: state.id, data: recorded.update });
    const seen = touched.get(state.serviceId);
    touched.set(state.serviceId, { sourceType: state.sourceType, at: seen && seen.at > m.at ? seen.at : m.at });
  }
  // O resumo olha todos os alvos do serviço, não só os medidos agora; o Map preserva a ordem do catálogo.
  const all = [...next.values()];
  const services = Array.from(touched, ([serviceId, info]) => ({ serviceId, ...info, summary: summarizeService(all.filter((t) => t.serviceId === serviceId)) }));
  return { targets: next, rows, targetUpdates, services };
}

// ---------------------------------------------------------------- janelas de 5 min, linha de base e limpeza

/** O que está na hora de fazer na manutenção do fim do passo. */
export function maintenanceDue(last: { rollupAt: number; cleanupAt: number }, now: number): { rollup: boolean; cleanup: boolean } {
  return { rollup: now - last.rollupAt >= ROLLUP_EVERY_MS, cleanup: now - last.cleanupAt >= CLEANUP_EVERY_MS };
}

/**
 * Primeira janela a resumir: a seguinte à última resumida (em memória), ou a seguinte à mais nova
 * gravada no banco, ou a da medição mais antiga; nunca antes de 48 h atrás (as medições cruas mais
 * velhas que isso já foram apagadas). null = não há o que resumir. Tempos em ms desde 1970.
 */
export function rollupStart(known: { lastRolled: number | null; newestRollup: number | null; oldestCheck: number | null }, now: number): number | null {
  const from = known.lastRolled !== null ? known.lastRolled + BUCKET_MS : known.newestRollup !== null ? known.newestRollup + BUCKET_MS : known.oldestCheck !== null ? bucketStart(known.oldestCheck) : null;
  if (from === null) return null;
  return Math.max(bucketStart(from), bucketStart(now - CHECK_RETENTION_MS));
}

/**
 * Janelas fechadas a partir de `from`, no máximo `max`. Uma janela que começa em b está fechada quando
 * b + 5 min ≤ agora − 60 s.
 */
export function closedWindows(from: number, now: number, max = MAX_ROLLUP_WINDOWS): number[] {
  const windows: number[] = [];
  for (let b = bucketStart(from); windows.length < max && b + BUCKET_MS <= now - ROLLUP_SETTLE_MS; b += BUCKET_MS) windows.push(b);
  return windows;
}

/** Uma linha de ProbeRollup. */
export interface RollupRow extends BucketStats {
  targetId: string;
  vantage: string;
  bucket: Date;
}

/** Resume as medições das janelas pedidas: uma linha por alvo e janela com amostras. */
export function buildRollups(checks: readonly (CheckSample & { targetId: string; at: Date })[], windows: readonly number[]): RollupRow[] {
  const wanted = new Set(windows);
  const groups = new Map<string, { targetId: string; bucket: number; samples: CheckSample[] }>();
  for (const c of checks) {
    const bucket = bucketStart(c.at.getTime());
    if (!wanted.has(bucket)) continue;
    const key = `${bucket}|${c.targetId}`;
    const group = groups.get(key) ?? { targetId: c.targetId, bucket, samples: [] };
    group.samples.push({ ok: c.ok, latencyMs: c.latencyMs, lossPct: c.lossPct });
    groups.set(key, group);
  }
  return Array.from(groups.values(), (g) => ({ targetId: g.targetId, vantage: SERVER_VANTAGE, bucket: new Date(g.bucket), ...aggregateChecks(g.samples) }));
}

/** Linha de base de cada alvo: as medianas (p50) das suas janelas, na ordem recebida. */
export function groupBaseline(rollups: readonly { targetId: string; p50Ms: number | null }[]): Map<string, number[]> {
  const baselines = new Map<string, number[]>();
  for (const r of rollups) {
    if (r.p50Ms === null) continue;
    const values = baselines.get(r.targetId);
    if (values) values.push(r.p50Ms);
    else baselines.set(r.targetId, [r.p50Ms]);
  }
  return baselines;
}

/** Até quando o histórico é mantido: medições cruas 48 h, janelas de 5 min 30 dias. */
export function cleanupCutoffs(now: number): { checksBefore: Date; rollupsBefore: Date } {
  return { checksBefore: new Date(now - CHECK_RETENTION_MS), rollupsBefore: new Date(now - ROLLUP_RETENTION_MS) };
}
