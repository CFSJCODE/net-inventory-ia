import type { NormalizedIncident, OfficialSnapshot, ServiceStatus } from "../types";

/**
 * Netflix: a página "A Netflix está fora do ar?" (help.netflix.com/pt/is-netflix-down) é montada a partir
 * de um JSON aberto, sem chave (conferido em 15/11/2026):
 *   https://help.netflix.com/pt/api/notifications
 * Sem problema conhecido ele devolve `[]`. Cada aviso traz `downNotification` (true = aviso de queda do
 * serviço, o que a página mostra no lugar de "A Netflix está funcionando"), `level` e `cannedMessage`, um
 * trecho de HTML com o título em <h1> e o texto em <p>. Os outros avisos, que não são de queda, e os
 * alertas da conta (`type: "UMS_ALERT"`) ficam de fora: não dizem nada sobre o serviço.
 */

export const NETFLIX_PAGE_URL = "https://help.netflix.com/pt/is-netflix-down";

export interface NetflixNotification {
  type?: string;
  notificationId?: string | number;
  notificationType?: string;
  level?: string;
  downNotification?: boolean;
  cannedMessage?: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Texto puro de um trecho de HTML: sem tags, com as entidades comuns decodificadas e espaços juntos. */
export function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function firstTag(html: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(html);
  const text = match ? htmlText(match[1]) : "";
  return text || null;
}

/** Nível do aviso: "ERROR"/"CRITICAL" é queda; os demais (aviso, informação) são instabilidade. */
function noticeStatus(level: string | undefined): ServiceStatus {
  const l = (level ?? "").toUpperCase();
  return l === "ERROR" || l === "CRITICAL" ? "DOWN" : "DEGRADED";
}

export function parseNetflixNotifications(data: unknown, now = new Date()): OfficialSnapshot {
  if (!Array.isArray(data)) throw new Error("Netflix: resposta inesperada (não é uma lista de avisos)");
  const notices = (data as NetflixNotification[]).filter((n) => n && n.downNotification === true && n.type !== "UMS_ALERT");
  if (!notices.length) return { status: "OK", description: "A Netflix está funcionando", components: null, incidents: [] };

  const incidents: NormalizedIncident[] = notices.map((n, i) => {
    const html = n.cannedMessage ?? "";
    const title = firstTag(html, "h1") ?? (htmlText(html) || "Aviso de instabilidade da Netflix");
    return {
      externalId: String(n.notificationId ?? `aviso-${i}`),
      title: title.slice(0, 300),
      impact: noticeStatus(n.level) === "DOWN" ? "MAJOR" : "MINOR",
      state: "investigating",
      url: NETFLIX_PAGE_URL,
      affected: firstTag(html, "p")?.slice(0, 300) ?? null,
      // A fonte não diz quando começou: vale a primeira vez que o aviso foi visto (o upsert não reescreve).
      startedAt: now,
      resolvedAt: null,
    };
  });
  const status: ServiceStatus = notices.some((n) => noticeStatus(n.level) === "DOWN") ? "DOWN" : "DEGRADED";
  return { status, description: incidents[0].title, components: null, incidents };
}
