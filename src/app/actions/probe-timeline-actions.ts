"use server";

import { requireSession } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { AGENT_VANTAGE_PREFIX, SERVER_VANTAGE, probesEnabled } from "@/lib/global-status/probe-logic";
import { getGlobalStatusSettings } from "@/lib/global-status/settings";
import { buildTimeline, normalizeHours, stepForHours, type LaneInput, type LaneKey, type LaneSample, type Timeline } from "@/lib/global-status/timeline";
import { MULTI_DNS_RESOLVERS, type DnsAnswer } from "@/lib/global-status/types";
import { BASELINE_POINTS } from "@/lib/global-status/window-stats";

/** Serviço com o gateway e o DNS do sistema; e os resolvedores públicos cujo ping é a faixa WAN. */
const LOCAL_SLUG = "rede-local";
const WAN_SLUGS = ["dns-cloudflare", "dns-google", "dns-quad9"];
/** Histórico carregado antes do início, para a janela e a base já estarem cheias no primeiro passo (100 medições de 1 min + folga). */
const LOOKBACK_MS = Math.round(BASELINE_POINTS * 1.2) * 60_000;

export interface TimelineRequest {
  slug: string;
  hours?: number;
  /** "server" (padrão) ou "agent:<id>". */
  vantage?: string;
}

export interface TimelineResponse {
  timeline: Timeline | null;
  /** Motivo quando não há linha do tempo. */
  reason: string | null;
}

function parseAnswers(value: string | null): DnsAnswer[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as DnsAnswer[]) : null;
  } catch {
    return null;
  }
}

type CheckRow = Awaited<ReturnType<typeof loadChecks>>[number];

async function loadChecks(targetIds: string[], vantage: string, from: Date, to: Date) {
  if (!targetIds.length) return [];
  return prisma.probeCheck.findMany({
    where: { targetId: { in: targetIds }, vantage, at: { gte: from, lte: to } },
    orderBy: { at: "asc" },
    select: { at: true, ok: true, latencyMs: true, lossPct: true, error: true, httpStatus: true, dnsMs: true, connectMs: true, tlsMs: true, ttfbMs: true, totalMs: true, rcode: true, ttlSec: true, dnsAnswers: true },
  });
}

function toSample(c: CheckRow): LaneSample {
  return {
    at: c.at.getTime(),
    ok: c.ok,
    latencyMs: c.latencyMs,
    lossPct: c.lossPct,
    error: c.error,
    httpStatus: c.httpStatus,
    stages: { dnsMs: c.dnsMs, connectMs: c.connectMs, tlsMs: c.tlsMs, ttfbMs: c.ttfbMs, totalMs: c.totalMs },
    rcode: c.rcode,
    ttlSec: c.ttlSec,
    answers: parseAnswers(c.dnsAnswers),
  };
}

/**
 * Linha do tempo de um serviço (fase 6): gateway, WAN, DNS e HTTPS do ponto de medição escolhido,
 * alinhados por passo. O agente Windows não mede o DNS composto: para ele a faixa DNS é o DNS do
 * sistema do PC (alvo "dns" da Rede local).
 */
export async function getProbeTimeline(request: TimelineRequest): Promise<TimelineResponse> {
  await requireSession();
  const slug = typeof request?.slug === "string" ? request.slug : "";
  if (!slug) return { timeline: null, reason: "serviço não informado" };
  if (!probesEnabled(process.env.GLOBAL_STATUS_PROBES)) return { timeline: null, reason: "as medições próprias estão desligadas neste servidor" };
  const vantage = request.vantage === SERVER_VANTAGE || (typeof request.vantage === "string" && request.vantage.startsWith(AGENT_VANTAGE_PREFIX)) ? request.vantage : SERVER_VANTAGE;
  const hours = normalizeHours(request.hours);

  const services = await prisma.statusService.findMany({
    where: { slug: { in: [slug, LOCAL_SLUG, ...WAN_SLUGS] } },
    select: { slug: true, name: true, targets: { where: { enabled: true }, select: { id: true, key: true, kind: true, host: true } } },
  });
  const service = services.find((s) => s.slug === slug);
  const http = service?.targets.find((t) => t.kind === "HTTP");
  if (!service || !http) return { timeline: null, reason: "este serviço não tem medição HTTPS" };
  const local = services.find((s) => s.slug === LOCAL_SLUG);
  const gateway = local?.targets.find((t) => t.key === "gateway");
  const wan = services.filter((s) => WAN_SLUGS.includes(s.slug)).flatMap((s) => s.targets.filter((t) => t.kind === "ICMP"));
  const composite = vantage === SERVER_VANTAGE ? service.targets.find((t) => t.kind === "DNS_MULTI") : undefined;
  const dns = composite ?? local?.targets.find((t) => t.key === "dns");

  const end = new Date();
  const start = end.getTime() - hours * 3_600_000;
  const from = new Date(start - LOOKBACK_MS);
  const [settings, gatewayChecks, wanChecks, dnsChecks, httpChecks] = await Promise.all([
    getGlobalStatusSettings(),
    loadChecks(gateway ? [gateway.id] : [], vantage, from, end),
    loadChecks(wan.map((t) => t.id), vantage, from, end),
    loadChecks(dns ? [dns.id] : [], vantage, from, end),
    loadChecks([http.id], vantage, from, end),
  ]);

  const lanes: Record<LaneKey, LaneInput> = {
    gateway: { source: "ping no gateway padrão", samples: gatewayChecks.map(toSample) },
    wan: { source: `ping em ${wan.map((t) => t.host).join(", ") || "resolvedores públicos"}`, samples: wanChecks.map(toSample) },
    dns: {
      source: composite ? `${composite.host === "auto:multi" ? `DNS do sistema, ${MULTI_DNS_RESOLVERS.join(" e ")}` : composite.host}` : "DNS do sistema (example.com)",
      samples: dnsChecks.map(toSample),
    },
    https: { source: http.host, samples: httpChecks.map(toSample) },
  };
  const timeline = buildTimeline(lanes, { start, end: end.getTime(), stepMs: stepForHours(hours) }, { size: settings.probeWindow, serviceName: service.name });
  return { timeline, reason: null };
}
