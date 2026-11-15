import { worstStatus, type NormalizedComponent, type NormalizedIncident, type OfficialSnapshot, type ServiceStatus } from "../types";

/**
 * Adaptador da Amazon Web Services (`health.aws.amazon.com/public/currentevents`), o JSON que alimenta
 * o painel público da AWS. O arquivo vem em UTF-16 (com BOM): quem busca decodifica antes (`decodeAwsBody`).
 *
 * A AWS publica eventos por região, não um estado global. Cada evento traz `status`: "3" = interrupção do
 * serviço, "2" = desempenho degradado, "1" = informativo e "0" = resolvido. Interrupções em poucas regiões
 * deixam o card como degradado (a AWS inteira não caiu); só vira fora do ar quando `REGIONS_FOR_DOWN` ou mais
 * regiões estão em interrupção ao mesmo tempo. Cada região afetada aparece como um componente.
 */

export interface AwsEvent {
  arn?: string;
  date?: string;
  status?: string;
  region_name?: string;
  service_name?: string;
  summary?: string;
  event_log?: { summary?: string; message?: string; status?: number; timestamp?: number }[];
}

export const AWS_PAGE_URL = "https://health.aws.amazon.com/health/status";
/** Regiões em interrupção ao mesmo tempo para o card ir a "fora do ar". */
export const REGIONS_FOR_DOWN = 3;
/** Janela de eventos resolvidos que ainda vale mostrar no histórico. */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

/** O corpo da resposta como texto: UTF-16 (com BOM, nos dois sentidos) ou UTF-8. */
export function decodeAwsBody(bytes: ArrayBuffer): string {
  const head = new Uint8Array(bytes.slice(0, 2));
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

function eventStatus(status: string | undefined): ServiceStatus | null {
  if (status === "3") return "DOWN";
  if (status === "2") return "DEGRADED";
  return null;
}

/** Código da região (`sa-east-1`), tirado do ARN do evento. */
function regionOf(event: AwsEvent): string {
  return event.arn?.split(":")[3] || event.region_name || "global";
}

function toSeconds(value: unknown): Date | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

function toIncident(event: AwsEvent, now: Date): NormalizedIncident | null {
  const startedAt = toSeconds(event.date);
  if (!event.arn || !startedAt) return null;
  const log = event.event_log ?? [];
  const last = log[log.length - 1];
  const open = eventStatus(event.status) !== null || event.status === "1";
  const resolvedAt = open ? null : (toSeconds(last?.timestamp) ?? startedAt);
  if (resolvedAt && now.getTime() - resolvedAt.getTime() > RECENT_MS) return null;
  const what = (last?.summary ?? event.summary ?? "Incidente").trim();
  return {
    externalId: event.arn,
    title: `${event.service_name ?? "AWS"}: ${what}`.slice(0, 300),
    impact: event.status === "3" ? "MAJOR" : "MINOR",
    state: resolvedAt ? "resolved" : "ongoing",
    url: AWS_PAGE_URL,
    affected: event.region_name ?? null,
    startedAt,
    resolvedAt,
  };
}

export function parseAwsEvents(data: unknown, now = new Date()): OfficialSnapshot {
  if (!Array.isArray(data)) throw new Error("AWS: resposta inesperada (não é uma lista de eventos)");
  const events = data as AwsEvent[];
  const byRegion = new Map<string, NormalizedComponent>();
  for (const e of events) {
    const status = eventStatus(e.status);
    if (!status) continue;
    const region = regionOf(e);
    const prev = byRegion.get(region);
    byRegion.set(region, {
      externalId: region,
      name: e.region_name ? `${e.region_name} (${region})` : region,
      groupName: null,
      status: prev ? worstStatus([prev.status, status]) : status,
      position: prev?.position ?? byRegion.size,
    });
  }
  const components = Array.from(byRegion.values());
  const down = components.filter((c) => c.status === "DOWN").length;
  const status: ServiceStatus = down >= REGIONS_FOR_DOWN ? "DOWN" : components.length ? "DEGRADED" : "OK";
  const description = components.length
    ? `Eventos em ${components.length} ${components.length > 1 ? "regiões" : "região"}`
    : "Todos os serviços operando normalmente";
  const incidents = events.map((e) => toIncident(e, now)).filter((i): i is NormalizedIncident => i !== null);
  return { status, description, components, incidents };
}
