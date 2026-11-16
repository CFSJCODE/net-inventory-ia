import { prisma } from "@/lib/prisma";
import { getEmailAlertConfig } from "@/lib/alerts/email-settings";
import { deliver } from "@/lib/alerts/alert-monitor";
import { renderEmail, type EmailTone } from "@/lib/alerts/email-template";
import { measurementPaused } from "./probe-logic";
import { loadRouteOverview } from "./route-overview";
import { getGlobalStatusSettings, type GlobalStatusAlertSettings } from "./settings";
import { STATUS_SEVERITY, type ServiceStatus } from "./types";

/**
 * Alerta opcional por e-mail do painel "Status global" (fase 4). Desligado por padrão; ligado na tela
 * de configuração da página /status. Usa a chave do Resend, o remetente e o destinatário já cadastrados
 * em Alertas → Configurar e-mails, mas liga e desliga sozinho: os alertas dos equipamentos podem seguir
 * desligados.
 *
 * Roda depois de cada rodada do coletor (2 min). Regras:
 * - Avisa quando o status de um serviço chega ao nível escolhido (só "fora do ar", ou também
 *   "degradado") e quando volta ao normal, depois de 5 min no mesmo estado: uma oscilação de poucos
 *   minutos não vira e-mail.
 * - Todas as mudanças de uma rodada vão num e-mail só, e no máximo um e-mail a cada 10 min (o que
 *   mudar nesse intervalo vai no próximo).
 * - "Sem dados", "manutenção" e o card com as medições pausadas pela queda da conexão do servidor não
 *   são notícia: fica valendo o último estado avisado. A faixa "Sua Internet" fica de fora: com a sua conexão
 *   fora, o e-mail nem sairia.
 */

export const STATE_KEY = "globalStatus.alertState";
export const STABLE_MS = 5 * 60_000;
export const MIN_GAP_MS = 10 * 60_000;

export interface AlertState {
  /** Último estado avisado (ou registrado sem aviso) de cada serviço. */
  notified: Record<string, ServiceStatus>;
  /** Último e-mail enviado (ms desde 1970). */
  lastSentAt: number | null;
  /** Avisos de mudança de rota (incidentes ROUTE) já enviados (fase 9). */
  routeNotified?: string[];
}

/** Um aviso de mudança de rota em aberto (incidente de origem ROUTE). */
export interface RouteEvent {
  id: string;
  /** Revisão do aviso: o incidente aberto é reaproveitado quando a rota muda de novo (id + início). */
  key?: string;
  service: string;
  title: string;
}

/** Mudança de rota para o e-mail: passou a vir de fora do país pesa mais (fase 9, A2). */
export interface RouteChange extends RouteEvent {
  abroad: boolean;
}

/** Causa provável comum: serviços que mudaram juntos e são atendidos pelo mesmo lugar (fase 9, A3 e A4). */
export interface SharedCause {
  label: string;
  services: string[];
}

/** Os avisos de rota ainda não enviados, e a lista lembrada (só os ainda abertos). Pura. */
export function planRouteAlerts(open: readonly RouteEvent[], notified: readonly string[]): { changes: RouteChange[]; next: string[] } {
  const sent = new Set(notified);
  const keyOf = (e: RouteEvent) => e.key ?? e.id;
  const changes = open.filter((e) => !sent.has(keyOf(e))).map((e) => ({ ...e, abroad: /→ fora do Brasil/.test(e.title) && !/^Rota mudou: fora do Brasil/.test(e.title) }));
  return { changes, next: open.map(keyOf) };
}

/**
 * Serviços que entraram em alerta na mesma rodada e são atendidos pelo mesmo lugar (a mesma saída
 * internacional ou o mesmo PoP do CDN): um problema só, com a causa provável à frente. Pura.
 */
export function sharedCauses(changes: readonly StatusChange[], places: readonly { label: string; kind: string; services: { slug: string }[] }[]): SharedCause[] {
  const alerting = changes.filter((c) => c.kind === "alert");
  if (alerting.length < 2) return [];
  const out: SharedCause[] = [];
  for (const p of places) {
    if (p.kind !== "EXIT" && p.kind !== "EDGE") continue;
    const slugs = new Set(p.services.map((s) => s.slug));
    const hit = alerting.filter((c) => slugs.has(c.slug));
    if (hit.length >= 2) out.push({ label: p.label, services: hit.map((c) => c.name) });
  }
  return out.sort((a, b) => b.services.length - a.services.length);
}

export interface WatchedService {
  slug: string;
  name: string;
  category: string;
  status: ServiceStatus;
  lastChangeAt: Date | null;
  /** Frase que explica o estado (medido ou oficial). */
  reason: string | null;
  /** Medições paradas pela queda da conexão do servidor: o status do card não é um julgamento novo. */
  paused?: boolean;
}

export interface StatusChange {
  slug: string;
  name: string;
  from: ServiceStatus | null;
  to: ServiceStatus;
  reason: string | null;
  kind: "alert" | "recovery";
}

const isNews = (s: ServiceStatus) => s !== "UNKNOWN" && s !== "MAINTENANCE";

/** O que avisar nesta rodada e o estado lembrado depois do aviso. Pura. */
export function planStatusAlerts(services: readonly WatchedService[], notified: Readonly<Record<string, ServiceStatus>>, level: GlobalStatusAlertSettings["level"], now: Date): { changes: StatusChange[]; next: Record<string, ServiceStatus> } {
  const next: Record<string, ServiceStatus> = {};
  const changes: StatusChange[] = [];
  const threshold = STATUS_SEVERITY[level];
  for (const s of services) {
    const was = notified[s.slug];
    if (s.category === "INTERNET") continue;
    // Com a conexão do servidor fora, o card mostra só o oficial: nem queda nem volta, fica o último avisado.
    if (s.paused || !isNews(s.status)) {
      if (was) next[s.slug] = was;
      continue;
    }
    const stable = !s.lastChangeAt || now.getTime() - s.lastChangeAt.getTime() >= STABLE_MS;
    if (!stable) {
      if (was) next[s.slug] = was;
      continue;
    }
    const bad = STATUS_SEVERITY[s.status] >= threshold;
    const wasBad = was !== undefined && STATUS_SEVERITY[was] >= threshold;
    next[s.slug] = s.status;
    if (bad && (!wasBad || STATUS_SEVERITY[s.status] > STATUS_SEVERITY[was])) changes.push({ slug: s.slug, name: s.name, from: was ?? null, to: s.status, reason: s.reason, kind: "alert" });
    else if (!bad && wasBad) changes.push({ slug: s.slug, name: s.name, from: was, to: s.status, reason: s.reason, kind: "recovery" });
  }
  return { changes, next };
}

const STATUS_WORD: Record<ServiceStatus, string> = { OK: "normalizado", DEGRADED: "degradado", DOWN: "fora do ar", MAINTENANCE: "em manutenção", UNKNOWN: "sem dados" };

export interface EmailExtras {
  routes?: readonly RouteChange[];
  causes?: readonly SharedCause[];
  /** Concentração das rotas internacionais numa só saída ("Embratel → Miami", 0,9). */
  singleExit?: { label: string; share: number } | null;
}

/** Assunto e corpo do e-mail de uma rodada. Pura. */
export function buildStatusEmail(changes: readonly StatusChange[], now: Date, extras: EmailExtras = {}): { subject: string; html: string; text: string } {
  const routes = extras.routes ?? [];
  const causes = extras.causes ?? [];
  const alerts = changes.filter((c) => c.kind === "alert");
  const tone: EmailTone = alerts.some((c) => c.to === "DOWN") ? "critical" : alerts.length || routes.some((r) => r.abroad) ? "warning" : "ok";
  const first = changes[0];
  const title = causes.length
    ? `${causes[0].label}: ${causes[0].services.length} serviços afetados juntos`
    : changes.length === 1
      ? `${first.name}: ${STATUS_WORD[first.to]}`
      : changes.length
        ? `${changes.length} serviços mudaram de estado`
        : routes.length === 1
          ? `${routes[0].service}: ${routes[0].abroad ? "passou a vir de fora do Brasil" : "rota mudou"}`
          : `${routes.length} rotas mudaram`;
  const when = now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
  const sections: { title: string; rows: [string, string][] }[] = [];
  if (causes.length)
    sections.push({ title: "Causa provável", rows: causes.map((c): [string, string] => [c.label, `${c.services.join(", ")} mudaram juntos e são atendidos por aqui`]) });
  if (changes.length)
    sections.push({ title: "Mudanças", rows: changes.map((c): [string, string] => [c.name, `${c.from ? `${STATUS_WORD[c.from]} → ` : ""}${STATUS_WORD[c.to]}${c.reason ? ` · ${c.reason}` : ""}`]) });
  if (routes.length) sections.push({ title: "Rotas", rows: routes.map((r): [string, string] => [r.service, r.title.replace(/^Rota mudou: /, "")]) });
  const summaryParts = [
    changes.length ? `Mudança no status dos serviços acompanhados pelo NetInventory: ${changes.map((c) => `${c.name} ${STATUS_WORD[c.to]}`).join(", ")}.` : "",
    routes.length ? `Rota mudou: ${routes.map((r) => r.service).join(", ")}.` : "",
  ].filter(Boolean);
  const notes = [
    "Cada aviso sai depois de 5 minutos no mesmo estado, e no máximo um e-mail a cada 10 minutos.",
    ...(extras.singleExit ? [`${Math.round(extras.singleExit.share * 100)}% das rotas internacionais saem por ${extras.singleExit.label}: um problema nessa saída afeta todas elas.`] : []),
    "Para desligar estes avisos, abra Status global → Configurar.",
  ];
  const rendered = renderEmail({
    tone,
    label: alerts.length ? "STATUS GLOBAL" : changes.length ? "RECUPERADO" : "ROTA",
    title,
    subtitle: when,
    summary: summaryParts.join(" "),
    sections,
    notes,
  });
  return { subject: `[NetInventory] ${title}`, ...rendered };
}

async function readState(): Promise<AlertState | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: STATE_KEY } });
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as AlertState;
    return {
      notified: value.notified ?? {},
      lastSentAt: typeof value.lastSentAt === "number" ? value.lastSentAt : null,
      routeNotified: Array.isArray(value.routeNotified) ? value.routeNotified.filter((x) => typeof x === "string") : [],
    };
  } catch {
    return null;
  }
}

async function writeState(state: AlertState): Promise<void> {
  const value = JSON.stringify(state);
  await prisma.appSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value }, update: { value } });
}

const g = globalThis as typeof globalThis & { __globalStatusAlertWarned?: boolean };

/** Uma rodada do alerta por e-mail (chamada pelo coletor). */
export async function notifyStatusChanges(now = new Date()): Promise<void> {
  const settings = (await getGlobalStatusSettings()).alerts;
  if (!settings.enabled) {
    // Desligado não lembra nada: ao religar, o que estiver fora do ar é avisado.
    await prisma.appSetting.deleteMany({ where: { key: STATE_KEY } });
    return;
  }
  const config = await getEmailAlertConfig();
  if (!config.apiKey || !config.to.trim()) {
    if (!g.__globalStatusAlertWarned) console.warn("[global-status] alerta por e-mail ligado, mas sem chave do Resend ou destinatário em Alertas → Configurar e-mails");
    g.__globalStatusAlertWarned = true;
    return;
  }
  g.__globalStatusAlertWarned = false;

  const rows = await prisma.statusService.findMany({
    where: { enabled: true },
    select: { slug: true, name: true, category: true, status: true, lastChangeAt: true, measuredStatus: true, measuredReason: true, officialStatus: true, officialState: true },
  });
  const services: WatchedService[] = rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    category: r.category,
    status: r.status as ServiceStatus,
    lastChangeAt: r.lastChangeAt,
    // O motivo de quem puxou o estado para baixo: o medido quando é ele, senão a frase do provedor.
    reason: r.measuredReason ?? (r.officialState && r.officialState !== "OK" ? r.officialStatus : null),
    paused: measurementPaused(r),
  }));
  const state = (await readState()) ?? { notified: {}, lastSentAt: null, routeNotified: [] };
  const { changes, next } = planStatusAlerts(services, state.notified, settings.level, now);
  // Mudanças de rota em aberto (fase 9): avisadas uma vez cada.
  const openRoutes = await prisma.statusIncident.findMany({
    where: { origin: "ROUTE", resolvedAt: null, service: { enabled: true } },
    select: { id: true, title: true, startedAt: true, service: { select: { name: true } } },
    orderBy: { startedAt: "asc" },
  });
  const route = planRouteAlerts(
    openRoutes.map((r) => ({ id: r.id, key: `${r.id}@${r.startedAt.getTime()}`, service: r.service.name, title: r.title })),
    state.routeNotified ?? [],
  );
  if (!changes.length && !route.changes.length) {
    const nextState = { ...state, notified: next, routeNotified: route.next };
    if (JSON.stringify(nextState) !== JSON.stringify(state)) await writeState(nextState);
    return;
  }
  // Dentro do intervalo mínimo nada é lembrado: as mudanças seguem pendentes para o próximo e-mail.
  if (state.lastSentAt !== null && now.getTime() - state.lastSentAt < MIN_GAP_MS) return;
  // Causa comum: só quando dois ou mais serviços entraram em alerta juntos (a visão de rotas é lida só então).
  let causes: SharedCause[] = [];
  let singleExit: EmailExtras["singleExit"] = null;
  if (changes.filter((c) => c.kind === "alert").length >= 2 || route.changes.length) {
    const overview = await loadRouteOverview(now.getTime()).catch(() => null);
    if (overview) {
      causes = sharedCauses(changes, overview.places);
      singleExit = overview.singleExit && (causes.length || route.changes.some((r) => r.abroad)) ? overview.singleExit : null;
    }
  }
  const email = buildStatusEmail(changes, now, { routes: route.changes, causes, singleExit });
  // Falhou: `deliver` registra o erro (aparece em Alertas) e a próxima rodada tenta de novo.
  await deliver(config, email.subject, email.html, email.text);
  await writeState({ notified: next, lastSentAt: now.getTime(), routeNotified: route.next });
}
