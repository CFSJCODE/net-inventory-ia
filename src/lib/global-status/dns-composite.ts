import { Resolver } from "node:dns/promises";
import { getSystemDnsServers } from "@/lib/network/system-dns";
import { rcodeText } from "./dns-composite-labels";
import { MULTI_DNS_RESOLVERS, SYSTEM_RESOLVER, type DnsAnswer, type DnsRcode, type ProbeResult } from "./types";

export { rcodeText, resolverLabel } from "./dns-composite-labels";

/**
 * DNS composto (fase 6): o mesmo nome consultado ao mesmo tempo no DNS do sistema e nos resolvedores
 * públicos (8.8.8.8 e 1.1.1.1), com a latência, o TTL e o código de resposta de cada um.
 *
 * Para que serve: separar "o DNS da minha rede está lento ou quebrado" (só o do sistema falha ou demora)
 * de "o nome do serviço sumiu" (NXDOMAIN em todos) e de "um resolvedor público está com problema" (só um
 * deles falha). O TTL mostra se a resposta veio do cache (TTL baixo, contando para baixo) ou foi buscada
 * agora (TTL perto do configurado pelo dono do domínio).
 *
 * Nunca rejeita. O resultado da medição é o do DNS do sistema, que é o que os programas do usuário usam;
 * as respostas de todos ficam em `dnsAnswers`.
 */

const DNS_TIMEOUT_MS = 3_000;
/** Folga do corte (o c-ares só confere o prazo de segundo em segundo). */
const GUARD_MS = 500;
/** Servidores do sistema consultados, no máximo. */
const SYSTEM_DNS_MAX = 4;
/** Endereços guardados por resposta. */
const MAX_ADDRESSES = 4;

const RCODE_BY_ERRNO: Record<string, DnsRcode> = {
  ENOTFOUND: "NXDOMAIN",
  ENODATA: "NODATA",
  ESERVFAIL: "SERVFAIL",
  EREFUSED: "REFUSED",
  ECONNREFUSED: "REFUSED",
  ETIMEOUT: "TIMEOUT",
  ECANCELLED: "TIMEOUT",
};

/** Código DNS de um erro do resolvedor do Node. */
export function rcodeOf(err: unknown): DnsRcode {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return (typeof code === "string" && RCODE_BY_ERRNO[code]) || "ERROR";
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Uma consulta A com TTL em um conjunto de servidores; null = os padrões do Node (resolv.conf).
 * Com mais de um servidor, cada um num resolvedor próprio e todos ao mesmo tempo: vale a primeira
 * resposta com endereço e, entre as falhas, a que traz uma resposta de verdade (NXDOMAIN, SERVFAIL)
 * em vez do silêncio.
 */
async function queryOne(label: string, servers: (string[] | null)[], name: string, timeoutMs: number): Promise<DnsAnswer> {
  const resolvers: Resolver[] = [];
  try {
    for (const set of servers) {
      const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
      if (set) resolver.setServers(set);
      resolvers.push(resolver);
    }
  } catch (err) {
    return { resolver: label, ok: false, ms: null, rcode: rcodeOf(err), ttlSec: null, addresses: [] };
  }

  return new Promise((resolve) => {
    let settled = false;
    let pending = resolvers.length;
    const failures: DnsRcode[] = [];
    const t0 = performance.now();
    const failedAnswer = (): DnsAnswer => ({
      resolver: label,
      ok: false,
      ms: null,
      rcode: failures.find((r) => r !== "TIMEOUT") ?? "TIMEOUT",
      ttlSec: null,
      addresses: [],
    });
    const finish = (answer: DnsAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(answer);
      for (const r of resolvers) r.cancel();
    };
    const failed = (rcode: DnsRcode) => {
      failures.push(rcode);
      if (--pending <= 0) finish(failedAnswer());
    };
    const guard = setTimeout(() => finish(failedAnswer()), timeoutMs + GUARD_MS);

    for (const resolver of resolvers) {
      try {
        resolver.resolve4(name, { ttl: true }).then(
          (records) => {
            if (!records.length) return failed("NODATA");
            const ms = round1(performance.now() - t0);
            finish({
              resolver: label,
              ok: true,
              ms,
              rcode: "NOERROR",
              ttlSec: Math.min(...records.map((r) => r.ttl)),
              addresses: records.slice(0, MAX_ADDRESSES).map((r) => r.address),
            });
          },
          (err) => failed(rcodeOf(err)),
        );
      } catch (err) {
        failed(rcodeOf(err));
      }
    }
  });
}

export interface CompositeDnsOptions {
  timeoutMs?: number;
  /** Resolvedores públicos (padrão: 8.8.8.8 e 1.1.1.1); aceitam "ip:porta" (testes). */
  publicResolvers?: readonly string[];
  /** Servidores do sistema; undefined = descobrir; [] ou null = padrões do Node. */
  systemServers?: readonly string[] | null;
}

async function systemSets(given: CompositeDnsOptions["systemServers"]): Promise<(string[] | null)[]> {
  const list = given === undefined ? await getSystemDnsServers().catch(() => [] as string[]) : (given ?? []);
  return list.length ? list.slice(0, SYSTEM_DNS_MAX).map((s) => [s]) : [null];
}

/** Junta as respostas numa medição: o resultado é o do DNS do sistema (a primeira resposta). */
export function compositeResult(answers: readonly DnsAnswer[]): ProbeResult {
  const system = answers[0];
  if (!system) return { ok: false, latencyMs: null, error: "nenhum resolvedor consultado", failedAt: "dns" };
  const others = answers.slice(1);
  const base = { rcode: system.rcode, ttlSec: system.ttlSec, dnsAnswers: [...answers] };
  if (system.ok) return { ok: true, latencyMs: system.ms, dnsMs: system.ms, ...base };
  const publicOk = others.filter((a) => a.ok).map((a) => a.resolver);
  const detail = publicOk.length
    ? `${publicOk.join(" e ")} ${publicOk.length > 1 ? "resolvem" : "resolve"} normalmente`
    : others.length && others.every((a) => a.rcode === system.rcode)
      ? "os resolvedores públicos dão o mesmo resultado"
      : others.map((a) => `${a.resolver}: ${rcodeText(a.rcode)}`).join("; ");
  return {
    ok: false,
    latencyMs: null,
    ...base,
    error: `DNS do sistema: ${rcodeText(system.rcode)}${detail ? ` (${detail})` : ""}`,
    failedAt: "dns",
  };
}

/** Mede o nome `name` no DNS do sistema e nos resolvedores públicos ao mesmo tempo. */
export async function probeDnsComposite(name: string, options: CompositeDnsOptions = {}): Promise<ProbeResult> {
  if (typeof name !== "string" || !name.trim()) return { ok: false, latencyMs: null, error: "nome DNS vazio", failedAt: "dns" };
  const timeoutMs = Math.max(100, options.timeoutMs ?? DNS_TIMEOUT_MS);
  const publics = options.publicResolvers ?? MULTI_DNS_RESOLVERS;
  try {
    const system = await systemSets(options.systemServers);
    const answers = await Promise.all([
      queryOne(SYSTEM_RESOLVER, system, name, timeoutMs),
      ...publics.map((server) => queryOne(server.replace(/:\d+$/, ""), [[server]], name, timeoutMs)),
    ]);
    return compositeResult(answers);
  } catch (err) {
    return { ok: false, latencyMs: null, error: `falha inesperada no DNS composto: ${String(err)}`, failedAt: "dns" };
  }
}
