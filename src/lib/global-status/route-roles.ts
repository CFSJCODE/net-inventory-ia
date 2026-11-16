import net from "node:net";

/**
 * Papel do roteador pelo nome reverso (fase 7). As operadoras escrevem a função no nome:
 * "peer-B54-agg03.rjo.embratel.net.br" (peering), "ebt-B101-intl02.mianap.embratel.net.br" (borda
 * internacional), "nrjoac01-…" (acesso). Vale o papel mais específico que aparecer: peering e IX antes de
 * borda internacional, que vem antes de núcleo, agregação e acesso.
 */
export type RouterRole = "PEERING" | "IX" | "INTL_EDGE" | "CORE" | "AGGREGATION" | "ACCESS";

export const ROLE_LABEL: Record<RouterRole, string> = {
  PEERING: "peering",
  IX: "ponto de troca (IX)",
  INTL_EDGE: "borda internacional",
  CORE: "núcleo",
  AGGREGATION: "agregação",
  ACCESS: "acesso",
};

const RULES: [RouterRole, RegExp][] = [
  ["PEERING", /^(peer|peering|pni|pnis?)$/],
  ["IX", /^(ix|ixp|ixbr|ptt|ixsp|ixrj)$/],
  ["INTL_EDGE", /^(intl|international|inter|nap|[a-z]{3}nap)$/],
  ["CORE", /^(core|cr|bb|bbr|backbone|ebr)$/],
  ["AGGREGATION", /^(agg|ag|agr|aggr|dist|ds)$/],
  ["ACCESS", /^(ac|acc|access|bras|bng|olt|cpe|cmts|[a-z]?[a-z]{3}ac)$/],
];

/** O papel que o nome reverso indica, ou null. */
export function routerRole(rdns: string | null | undefined): RouterRole | null {
  if (!rdns) return null;
  const labels = rdns.toLowerCase().replace(/\.$/, "").split(".");
  // As duas últimas partes são o domínio da operadora.
  const tokens = labels
    .slice(0, Math.max(1, labels.length - 2))
    .flatMap((l) => l.split(/[-_]/))
    .map((t) => /^([a-z]+)/.exec(t)?.[1] ?? "")
    .filter(Boolean);
  for (const [role, pattern] of RULES) if (tokens.some((t) => pattern.test(t))) return role;
  return null;
}

/** Bloco IPv4/IPv6 em notação CIDR ("187.16.216.0/21"). */
export interface Prefix {
  base: bigint;
  bits: number;
  v6: boolean;
}

function ipToBigInt(ip: string): { value: bigint; v6: boolean } | null {
  if (net.isIPv4(ip)) return { value: ip.split(".").reduce((acc, o) => (acc << BigInt(8)) + BigInt(Number(o)), BigInt(0)), v6: false };
  if (!net.isIPv6(ip)) return null;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...new Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => g.includes("."))) return null;
  return { value: groups.reduce((acc, g) => (acc << BigInt(16)) + BigInt(parseInt(g || "0", 16)), BigInt(0)), v6: true };
}

export function parsePrefix(cidr: string): Prefix | null {
  const [ip, bitsText] = cidr.trim().split("/");
  const parsed = ipToBigInt(ip ?? "");
  const bits = Number(bitsText);
  if (!parsed || !Number.isInteger(bits) || bits < 0 || bits > (parsed.v6 ? 128 : 32)) return null;
  const width = parsed.v6 ? 128 : 32;
  const mask = bits === 0 ? BigInt(0) : ((BigInt(1) << BigInt(bits)) - BigInt(1)) << BigInt(width - bits);
  return { base: parsed.value & mask, bits, v6: parsed.v6 };
}

export function inPrefix(ip: string, prefix: Prefix): boolean {
  const parsed = ipToBigInt(ip);
  if (!parsed || parsed.v6 !== prefix.v6) return false;
  const width = prefix.v6 ? 128 : 32;
  const mask = prefix.bits === 0 ? BigInt(0) : ((BigInt(1) << BigInt(prefix.bits)) - BigInt(1)) << BigInt(width - prefix.bits);
  return (parsed.value & mask) === prefix.base;
}
