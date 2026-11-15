import type { ServiceStatus } from "./types";

/**
 * Incidentes "detectados" (fase 4): o que as medições deste servidor viram, registrado como incidente
 * ao lado dos oficiais. É a parte do Downdetector que dá para fazer com honestidade sem relatos de
 * usuários: o estado medido já vem da regra de mediana + 3·MAD e das falhas seguidas (stats.ts), então
 * um pico isolado não abre incidente.
 *
 * Ciclo de vida, por serviço (no máximo um aberto):
 * - Medido degradado ou fora: abre (ou reabre do "monitorando") com impacto Menor ou Grave. Piorou de
 *   degradado para fora: o impacto sobe e fica no pior visto.
 * - Medido normal: passa a "monitorando"; depois de `RESOLVE_AFTER_MS` sem voltar a piorar, fecha, com
 *   a hora de fechamento = a hora em que voltou ao normal.
 * - "Sem dados" (medições pausadas pela conexão local, ou ainda sem amostras): nada muda. Uma queda da
 *   sua Internet não abre nem fecha incidente de ninguém.
 */

export const DETECTED_ORIGIN = "DETECTED";
/** Tempo em "monitorando" até fechar: evita abrir e fechar o mesmo incidente a cada oscilação. */
export const RESOLVE_AFTER_MS = 10 * 60_000;

export interface OpenDetected {
  id: string;
  impact: string;
  state: string;
  /** Hora da última mudança; em "monitorando" é a hora em que o serviço voltou ao normal. */
  updatedAt: Date;
}

export interface DetectedFields {
  externalId: string;
  title: string;
  impact: "MINOR" | "MAJOR";
  state: string;
  affected: string | null;
  startedAt: Date;
}

export type DetectedPlan =
  | { kind: "none" }
  | { kind: "create"; data: DetectedFields }
  | { kind: "update"; id: string; data: Partial<Pick<DetectedFields, "title" | "impact" | "state" | "affected">> & { resolvedAt?: Date } };

const IMPACT_OF: Partial<Record<ServiceStatus, "MINOR" | "MAJOR">> = { DEGRADED: "MINOR", DOWN: "MAJOR" };
const TITLE_OF: Record<"MINOR" | "MAJOR", string> = { MINOR: "Degradado nas medições deste servidor", MAJOR: "Fora do ar nas medições deste servidor" };

export function detectedTitle(impact: "MINOR" | "MAJOR"): string {
  return TITLE_OF[impact];
}

/** O que fazer com o incidente detectado de um serviço, dado o estado medido agora. */
export function planDetected(open: OpenDetected | null, measured: { measuredStatus: ServiceStatus | null; measuredReason: string | null }, now: Date): DetectedPlan {
  const impact = measured.measuredStatus ? IMPACT_OF[measured.measuredStatus] : undefined;
  if (impact) {
    if (!open) {
      return {
        kind: "create",
        data: { externalId: `m-${now.getTime()}`, title: detectedTitle(impact), impact, state: "investigating", affected: measured.measuredReason, startedAt: now },
      };
    }
    // Fica o pior impacto visto: um "fora do ar" que melhora para "degradado" ainda foi uma queda.
    const worse = impact === "MAJOR" && open.impact !== "MAJOR";
    if (!worse && open.state === "investigating") return { kind: "none" };
    return {
      kind: "update",
      id: open.id,
      data: { state: "investigating", affected: measured.measuredReason, ...(worse ? { impact, title: detectedTitle(impact) } : {}) },
    };
  }
  if (!open || measured.measuredStatus !== "OK") return { kind: "none" };
  if (open.state !== "monitoring") return { kind: "update", id: open.id, data: { state: "monitoring" } };
  if (now.getTime() - open.updatedAt.getTime() < RESOLVE_AFTER_MS) return { kind: "none" };
  return { kind: "update", id: open.id, data: { state: "resolved", resolvedAt: open.updatedAt } };
}
