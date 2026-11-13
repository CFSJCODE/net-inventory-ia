import type { ServiceCategory, SourceType } from "./types";

export interface CatalogEntry {
  slug: string;
  name: string;
  category: ServiceCategory;
  sourceType: SourceType;
  /** Base da API oficial (Statuspage: raiz do site; Google: status.cloud.google.com; Azure: URL do feed). */
  sourceUrl: string;
  pageUrl: string;
}

/**
 * Serviços com fonte oficial aberta (verificados em 13/11/2026). A ordem é a de exibição dentro de
 * cada categoria. Novos provedores Statuspage entram só com uma linha aqui.
 */
export const STATUS_CATALOG: CatalogEntry[] = [
  { slug: "cloudflare", name: "Cloudflare", category: "CDN", sourceType: "STATUSPAGE", sourceUrl: "https://www.cloudflarestatus.com", pageUrl: "https://www.cloudflarestatus.com/" },
  { slug: "akamai", name: "Akamai", category: "CDN", sourceType: "STATUSPAGE", sourceUrl: "https://www.akamaistatus.com", pageUrl: "https://www.akamaistatus.com/" },
  { slug: "azure", name: "Microsoft Azure", category: "CLOUD", sourceType: "AZURE_RSS", sourceUrl: "https://azure.status.microsoft/en-us/status/feed/", pageUrl: "https://azure.status.microsoft/pt-br/status" },
  { slug: "google-cloud", name: "Google Cloud", category: "CLOUD", sourceType: "GCP", sourceUrl: "https://status.cloud.google.com", pageUrl: "https://status.cloud.google.com/" },
  { slug: "github", name: "GitHub", category: "DEV", sourceType: "STATUSPAGE", sourceUrl: "https://www.githubstatus.com", pageUrl: "https://www.githubstatus.com/" },
  { slug: "openai", name: "OpenAI", category: "AI", sourceType: "STATUSPAGE", sourceUrl: "https://status.openai.com", pageUrl: "https://status.openai.com/" },
  { slug: "discord", name: "Discord", category: "SOCIAL", sourceType: "STATUSPAGE", sourceUrl: "https://discordstatus.com", pageUrl: "https://discordstatus.com/" },
  { slug: "reddit", name: "Reddit", category: "SOCIAL", sourceType: "STATUSPAGE", sourceUrl: "https://www.redditstatus.com", pageUrl: "https://www.redditstatus.com/" },
  { slug: "twitch", name: "Twitch", category: "STREAMING", sourceType: "STATUSPAGE", sourceUrl: "https://status.twitch.com", pageUrl: "https://status.twitch.com/" },
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
