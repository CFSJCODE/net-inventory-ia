import { worstStatus, type NormalizedIncident, type OfficialSnapshot, type ServiceStatus } from "../types";

/**
 * Adaptador do feed RSS do Azure Status. O feed só lista incidentes ativos: sem itens = tudo normal.
 * Não há componentes estruturados nem impacto declarado, então o título define a gravidade.
 */

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : null;
}

const DOWN_WORDS = /\b(outage|unavailable|unable to access|down)\b/i;

export function parseAzureRss(xml: string): OfficialSnapshot {
  const items = Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi), (m) => m[0]);
  const incidents: NormalizedIncident[] = [];
  const statuses: ServiceStatus[] = [];
  for (const item of items) {
    const title = tag(item, "title") ?? "Incidente no Azure";
    const pub = tag(item, "pubDate");
    const startedAt = pub ? new Date(pub) : new Date();
    const severity: ServiceStatus = DOWN_WORDS.test(title) ? "DOWN" : "DEGRADED";
    statuses.push(severity);
    incidents.push({
      externalId: tag(item, "guid") ?? tag(item, "link") ?? title,
      title,
      impact: severity === "DOWN" ? "MAJOR" : "MINOR",
      state: "investigating",
      url: tag(item, "link"),
      affected: (tag(item, "description") ?? "").slice(0, 300) || null,
      startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
      resolvedAt: null,
    });
  }
  const status = items.length ? worstStatus(statuses) : "OK";
  const description = items.length
    ? `${items.length} incidente${items.length > 1 ? "s" : ""} ativo${items.length > 1 ? "s" : ""}`
    : "Nenhum incidente ativo";
  return { status, description, components: null, incidents };
}
