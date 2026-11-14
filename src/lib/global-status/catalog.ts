import { AUTO_GATEWAY, AUTO_SYSTEM_DNS, DEFAULT_DNS_NAME, type ProbeKind, type ServiceCategory, type SourceType } from "./types";

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
 * Alvos de um serviço: um pedido HTTPS (tempos de DNS, TCP, TLS e resposta, mais a validade do certificado)
 * e o handshake TCP na porta 443, que dá a latência de rede do card. `tcpHost` troca o host do TCP quando
 * o serviço de verdade atende em outro nome (o chat do WhatsApp fica em g.whatsapp.net).
 */
function web(url: string, tcpHost?: string): CatalogTarget[] {
  const host = new URL(url).hostname;
  return [
    { key: "http", kind: "HTTP", host, url },
    { key: "tcp", kind: "TCP", host: tcpHost ?? host, port: 443 },
  ];
}

/** Resolvedor público: ping e consulta DNS direto no IP, sem depender do DNS do servidor. */
function resolver(ip: string): CatalogTarget[] {
  return [
    { key: "ping", kind: "ICMP", host: ip },
    { key: "dns", kind: "DNS", host: ip, url: DEFAULT_DNS_NAME },
  ];
}

/**
 * Serviços acompanhados. A ordem é a de exibição dentro de cada categoria.
 *
 * Fonte oficial (verificadas em 13/11/2026): os provedores com página de status aberta. Novos provedores
 * Statuspage entram só com uma linha aqui. Redes sociais e streaming sem página aberta ficam com
 * `sourceType: "NONE"`: o estado deles vem só das medições deste servidor.
 *
 * Endereços medidos (conferidos em 14/11/2026 com o agente de usuário da sonda; qualquer resposta abaixo
 * de 500 conta como "no ar"). A sonda repete o pedido a cada 60 s e descarta o corpo, então cada endereço
 * é o mais leve que ainda passa pela borda do serviço: um arquivo pequeno (robots.txt, security.txt), um
 * endpoint público sem login (Cloudflare trace, Discord gateway, metadados do Azure) ou uma resposta
 * curta (204 do YouTube, 302 do Telegram e do console do Google Cloud, 401 da API da OpenAI, 403 da
 * Akamai). Ficam de fora api.github.com (60 pedidos por hora sem token) e os sites que agregam relatos
 * de queda, que recusam robôs.
 *
 * Categoria INTERNET: a conexão do próprio servidor (gateway, DNS do sistema) e três resolvedores
 * públicos. São a base da faixa "Sua Internet" e as testemunhas que separam queda local de queda do serviço.
 */
export const STATUS_CATALOG: CatalogEntry[] = [
  { slug: "cloudflare", name: "Cloudflare", category: "CDN", sourceType: "STATUSPAGE", sourceUrl: "https://www.cloudflarestatus.com", pageUrl: "https://www.cloudflarestatus.com/", targets: web("https://www.cloudflare.com/cdn-cgi/trace") },
  { slug: "akamai", name: "Akamai", category: "CDN", sourceType: "STATUSPAGE", sourceUrl: "https://www.akamaistatus.com", pageUrl: "https://www.akamaistatus.com/", targets: web("https://www.akamai.com/") },
  { slug: "azure", name: "Microsoft Azure", category: "CLOUD", sourceType: "AZURE_RSS", sourceUrl: "https://azure.status.microsoft/en-us/status/feed/", pageUrl: "https://azure.status.microsoft/pt-br/status", targets: web("https://management.azure.com/metadata/endpoints?api-version=2022-09-01", "portal.azure.com") },
  { slug: "google-cloud", name: "Google Cloud", category: "CLOUD", sourceType: "GCP", sourceUrl: "https://status.cloud.google.com", pageUrl: "https://status.cloud.google.com/", targets: web("https://console.cloud.google.com/") },
  { slug: "github", name: "GitHub", category: "DEV", sourceType: "STATUSPAGE", sourceUrl: "https://www.githubstatus.com", pageUrl: "https://www.githubstatus.com/", targets: web("https://github.com/.well-known/security.txt") },
  { slug: "openai", name: "OpenAI", category: "AI", sourceType: "STATUSPAGE", sourceUrl: "https://status.openai.com", pageUrl: "https://status.openai.com/", targets: web("https://api.openai.com/v1/models") },
  { slug: "whatsapp", name: "WhatsApp", category: "SOCIAL", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://web.whatsapp.com/robots.txt", "g.whatsapp.net") },
  { slug: "instagram", name: "Instagram", category: "SOCIAL", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://www.instagram.com/robots.txt") },
  { slug: "facebook", name: "Facebook", category: "SOCIAL", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://www.facebook.com/security.txt") },
  { slug: "youtube", name: "YouTube", category: "SOCIAL", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://www.youtube.com/generate_204") },
  { slug: "x", name: "X (Twitter)", category: "SOCIAL", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://x.com/robots.txt") },
  { slug: "tiktok", name: "TikTok", category: "SOCIAL", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://www.tiktok.com/robots.txt") },
  { slug: "telegram", name: "Telegram", category: "SOCIAL", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://api.telegram.org/") },
  { slug: "discord", name: "Discord", category: "SOCIAL", sourceType: "STATUSPAGE", sourceUrl: "https://discordstatus.com", pageUrl: "https://discordstatus.com/", targets: web("https://discord.com/api/v10/gateway") },
  { slug: "reddit", name: "Reddit", category: "SOCIAL", sourceType: "STATUSPAGE", sourceUrl: "https://www.redditstatus.com", pageUrl: "https://www.redditstatus.com/", targets: web("https://www.reddit.com/robots.txt") },
  { slug: "netflix", name: "Netflix", category: "STREAMING", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://www.netflix.com/robots.txt") },
  { slug: "prime-video", name: "Prime Video", category: "STREAMING", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://www.primevideo.com/robots.txt") },
  { slug: "disney-plus", name: "Disney+", category: "STREAMING", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://www.disneyplus.com/robots.txt") },
  { slug: "globoplay", name: "Globoplay", category: "STREAMING", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://globoplay.globo.com/robots.txt") },
  { slug: "spotify", name: "Spotify", category: "STREAMING", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://open.spotify.com/robots.txt") },
  { slug: "twitch", name: "Twitch", category: "STREAMING", sourceType: "STATUSPAGE", sourceUrl: "https://status.twitch.com", pageUrl: "https://status.twitch.com/", targets: web("https://www.twitch.tv/robots.txt") },
  {
    slug: "rede-local",
    name: "Rede local",
    category: "INTERNET",
    sourceType: "NONE",
    sourceUrl: null,
    pageUrl: null,
    targets: [
      { key: "gateway", kind: "ICMP", host: AUTO_GATEWAY },
      { key: "dns", kind: "DNS", host: AUTO_SYSTEM_DNS, url: DEFAULT_DNS_NAME },
    ],
  },
  { slug: "dns-cloudflare", name: "Cloudflare DNS (1.1.1.1)", category: "INTERNET", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: resolver("1.1.1.1") },
  { slug: "dns-google", name: "Google DNS (8.8.8.8)", category: "INTERNET", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: resolver("8.8.8.8") },
  { slug: "dns-quad9", name: "Quad9 (9.9.9.9)", category: "INTERNET", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: resolver("9.9.9.9") },
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
