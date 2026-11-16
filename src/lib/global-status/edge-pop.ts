import { cityFromIata } from "./route-cities";

/**
 * PoP do CDN que atendeu a sonda HTTP, pelos cabeçalhos da resposta (fase 8). Funciona sem traceroute e
 * mesmo com o ICMP filtrado: o próprio CDN diz em qual cidade atendeu.
 *
 * - Cloudflare: `cf-ray: 8a1b2c3d4e5f6a7b-GRU`
 * - CloudFront: `x-amz-cf-pop: GRU3-P1`
 * - Fastly: `x-served-by: cache-gru-sbgr1234-GRU` (o último código é o PoP que respondeu)
 * - Vercel: `x-vercel-id: gru1::iad1::abc` (o primeiro é a borda)
 * - Akamai e Google Front End se identificam no `server`, sem dizer o PoP.
 */
export interface EdgePop {
  provider: string;
  /** Código de aeroporto do PoP ("GRU"); null quando o CDN não informa. */
  pop: string | null;
}

type Headers = Record<string, string | string[] | undefined>;

const first = (h: Headers, name: string): string | null => {
  const v = h[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() || null;
};

export function edgeFromHeaders(headers: Headers): EdgePop | null {
  const ray = first(headers, "cf-ray");
  if (ray) return { provider: "Cloudflare", pop: /-([A-Za-z]{3})$/.exec(ray)?.[1]?.toUpperCase() ?? null };
  const cfPop = first(headers, "x-amz-cf-pop");
  if (cfPop) return { provider: "CloudFront", pop: /^([A-Za-z]{3})/.exec(cfPop)?.[1]?.toUpperCase() ?? null };
  const servedBy = first(headers, "x-served-by");
  if (servedBy && /cache-/i.test(servedBy)) {
    const last = servedBy.split(",").pop()!.trim();
    const code = /-([A-Za-z]{3})$/.exec(last)?.[1] ?? /cache-([a-z]{3})/i.exec(last)?.[1] ?? null;
    return { provider: "Fastly", pop: code ? code.toUpperCase() : null };
  }
  const vercel = first(headers, "x-vercel-id");
  if (vercel) return { provider: "Vercel", pop: /^([a-z]{3})\d*::/i.exec(vercel)?.[1]?.toUpperCase() ?? null };
  const server = first(headers, "server") ?? "";
  if (/akamai/i.test(server)) return { provider: "Akamai", pop: null };
  if (/^(gws|esf|sffe|gfe)/i.test(server)) return { provider: "Google", pop: null };
  return null;
}

/** Como fica gravado em ProbeCheck.edge: "Cloudflare GRU", "Akamai". */
export function formatEdge(edge: EdgePop | null): string | null {
  return edge ? `${edge.provider}${edge.pop ? ` ${edge.pop}` : ""}` : null;
}

export function parseEdge(text: string | null | undefined): (EdgePop & { city: string | null; country: string | null }) | null {
  if (!text) return null;
  const match = /^(.+?)(?: ([A-Z]{3}))?$/.exec(text.trim());
  if (!match) return null;
  const city = cityFromIata(match[2] ?? null);
  return { provider: match[1], pop: match[2] ?? null, city: city?.name ?? null, country: city?.country ?? null };
}
