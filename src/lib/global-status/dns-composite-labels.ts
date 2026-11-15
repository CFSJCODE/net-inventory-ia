import { SYSTEM_RESOLVER, type DnsRcode } from "./types";

/** Textos do DNS composto, sem dependência do Node (usados também na tela). */

const RCODE_TEXT: Record<DnsRcode, string> = {
  NOERROR: "ok",
  NODATA: "sem registro A",
  NXDOMAIN: "nome não encontrado (NXDOMAIN)",
  SERVFAIL: "falha do servidor (SERVFAIL)",
  REFUSED: "consulta recusada",
  TIMEOUT: "sem resposta (timeout)",
  ERROR: "falha na consulta",
};

export function rcodeText(rcode: DnsRcode): string {
  return RCODE_TEXT[rcode];
}

/** Nome do resolvedor para a tela: "DNS do sistema" ou o IP. */
export function resolverLabel(resolver: string): string {
  return resolver === SYSTEM_RESOLVER ? "DNS do sistema" : resolver;
}
