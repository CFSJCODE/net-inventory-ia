import type { ProbeKind, ServiceCategory, SourceType } from "./types";

/** Alvo de medição própria de um serviço (vira um ProbeTarget). */
export interface CatalogTarget {
  /** Chave estável dentro do serviço (ex.: "http", "tcp", "ping", "dns"); o catálogo atualiza sem duplicar. */
  key: string;
  kind: ProbeKind;
  /** Host ou IP; "auto:gateway" = gateway padrão. Para DNS é o servidor consultado ("auto:system" = resolvedores do sistema). */
  host: string;
  /** HTTP: URL completa. DNS: nome consultado. */
  url?: string;
  port?: number;
  /** Intervalo em segundos; sem valor usa DEFAULT_INTERVAL_SEC do tipo. */
  intervalSec?: number;
}

export interface CatalogEntry {
  slug: string;
  name: string;
  category: ServiceCategory;
  sourceType: SourceType;
  /** Base da API oficial (Statuspage: raiz do site; Google: status.cloud.google.com; Azure: URL do feed); null sem fonte oficial. */
  sourceUrl: string | null;
  /** Página pública de status, para o link no card; null quando o serviço não publica uma. */
  pageUrl: string | null;
  /** Medições próprias (HTTP, TCP, ICMP, DNS, TLS). */
  targets: CatalogTarget[];
}

/** Intervalo padrão de cada tipo de medição, em segundos (plano aprovado: HTTP 60 s, TCP 30 s, ICMP 60 s, DNS 5 min, TLS 6 h). */
export const DEFAULT_INTERVAL_SEC: Record<ProbeKind, number> = { HTTP: 60, TCP: 30, ICMP: 60, DNS: 300, TLS: 21_600 };

/**
 * Serviços com fonte oficial aberta (verificados em 13/11/2026). A ordem é a de exibição dentro de
 * cada categoria. Novos provedores Statuspage entram só com uma linha aqui.
 */
export const STATUS_CATALOG: CatalogEntry[] = [
  { slug: "cloudflare", name: "Cloudflare", category: "CDN", sourceType: "STATUSPAGE", sourceUrl: "https://www.cloudflarestatus.com", pageUrl: "https://www.cloudflarestatus.com/", targets: [] },
  { slug: "akamai", name: "Akamai", category: "CDN", sourceType: "STATUSPAGE", sourceUrl: "https://www.akamaistatus.com", pageUrl: "https://www.akamaistatus.com/", targets: [] },
  { slug: "azure", name: "Microsoft Azure", category: "CLOUD", sourceType: "AZURE_RSS", sourceUrl: "https://azure.status.microsoft/en-us/status/feed/", pageUrl: "https://azure.status.microsoft/pt-br/status", targets: [] },
  { slug: "google-cloud", name: "Google Cloud", category: "CLOUD", sourceType: "GCP", sourceUrl: "https://status.cloud.google.com", pageUrl: "https://status.cloud.google.com/", targets: [] },
  { slug: "github", name: "GitHub", category: "DEV", sourceType: "STATUSPAGE", sourceUrl: "https://www.githubstatus.com", pageUrl: "https://www.githubstatus.com/", targets: [] },
  { slug: "openai", name: "OpenAI", category: "AI", sourceType: "STATUSPAGE", sourceUrl: "https://status.openai.com", pageUrl: "https://status.openai.com/", targets: [] },
  { slug: "discord", name: "Discord", category: "SOCIAL", sourceType: "STATUSPAGE", sourceUrl: "https://discordstatus.com", pageUrl: "https://discordstatus.com/", targets: [] },
  { slug: "reddit", name: "Reddit", category: "SOCIAL", sourceType: "STATUSPAGE", sourceUrl: "https://www.redditstatus.com", pageUrl: "https://www.redditstatus.com/", targets: [] },
  { slug: "twitch", name: "Twitch", category: "STREAMING", sourceType: "STATUSPAGE", sourceUrl: "https://status.twitch.com", pageUrl: "https://status.twitch.com/", targets: [] },
];

export const CATEGORY_LABEL: Record<ServiceCategory, string> = {
  CLOUD: "Nuvem",
  CDN: "CDN e borda",
  DEV: "Desenvolvimento",
  AI: "Inteligência artificial",
  SOCIAL: "Redes sociais e comunidades",
  STREAMING: "Streaming",
  INTERNET: "Internet",
};

export const CATEGORY_ORDER: ServiceCategory[] = ["CLOUD", "CDN", "AI", "DEV", "SOCIAL", "STREAMING", "INTERNET"];
