import { execFile } from "node:child_process";
import net from "node:net";

/**
 * Traceroute sob demanda do painel "Status global" (fase 3): o caminho do servidor até o destino de um
 * serviço, salto a salto. Sem nomes reversos (-n): fica rápido e não depende do DNS; ASN, cidade e cabo
 * provável vêm da fase 5 (`route-runner.ts`), que grava a rota.
 *
 * Ferramentas, na ordem: `traceroute` (pacote traceroute), `tracepath` (iputils, presente no Ubuntu Server)
 * e `tracert` no Windows. A saída é lida por parsers puros, testados com saídas reais.
 */

export interface TraceHop {
  /** Número do salto (TTL). */
  ttl: number;
  /** IP do roteador que respondeu; null = sem resposta nesse salto ("*"). */
  ip: string | null;
  /** Menor tempo de ida e volta medido no salto, em ms; null sem resposta. */
  rttMs: number | null;
  /**
   * Outros IPs que responderam no mesmo salto (balanceamento ECMP da operadora: cada sonda pode seguir um
   * caminho). Vazio quando só um respondeu.
   */
  altIps: string[];
}

/**
 * Como as sondas saem (fase 7):
 * - `udp`: o traceroute clássico, porta de destino que sobe a cada sonda (cada uma pode cair num caminho ECMP).
 * - `paris`: UDP com porta fixa (`-U`), o mesmo fluxo em todas as sondas: uma rota coerente sob ECMP.
 * - `tcp`: SYN para a porta 443 (`-T`). Passa onde o UDP e o ICMP são filtrados (depois da borda dos CDNs) e
 *   costuma chegar ao destino; exige CAP_NET_RAW no binário (`sudo netinventoryctl rota-tcp`).
 * - `union`: a união das três ("Rastrear rota" no detalhe).
 */
export type TraceMode = "udp" | "paris" | "tcp" | "union";

export interface TraceResult {
  ok: boolean;
  host: string;
  /** IP em que o host resolveu (o destino rastreado); null quando nem resolveu. */
  address: string | null;
  /** Ferramenta usada (traceroute, tracepath ou tracert); null quando nenhuma rodou. */
  tool: string | null;
  hops: TraceHop[];
  /** true = o último salto é o próprio destino. */
  reached: boolean;
  error: string | null;
  /** Modo das sondas que deu este resultado. */
  mode: TraceMode;
  /** O modo TCP: "ok" rodou, "denied" sem permissão (falta CAP_NET_RAW), "unavailable" não há traceroute; null não tentado. */
  tcp?: "ok" | "denied" | "unavailable" | null;
}

export const TRACE_MAX_HOPS = 20;
const TRACE_TIMEOUT_MS = 90_000;
/** Mesma regra do ping: nome sem espaço e sem começar por "-", para nunca ser lido como opção. */
const HOSTNAME = /^(?!-)[A-Za-z0-9.-]{1,253}$/;

export function isTraceableHost(host: unknown): host is string {
  return typeof host === "string" && (net.isIP(host) !== 0 || HOSTNAME.test(host));
}

/** Destino do traceroute de um serviço: o host do alvo TCP, ou o do HTTP; nunca o gateway nem o DNS do sistema. */
export function traceHost(targets: readonly { kind: string; host: string; url: string | null }[]): string | null {
  for (const kind of ["TCP", "HTTP", "ICMP"]) {
    const t = targets.find((x) => x.kind === kind);
    if (!t) continue;
    let host = t.host;
    if (kind === "HTTP" && t.url) {
      try {
        host = new URL(t.url).hostname;
      } catch {
        continue;
      }
    }
    if (isTraceableHost(host)) return host;
  }
  return null;
}

const IP_TOKEN = /^\(?([0-9a-fA-F:.]+)\)?$/;
function ipOf(token: string | undefined): string | null {
  if (!token) return null;
  const match = IP_TOKEN.exec(token.replace(/^\[|\]$/g, ""));
  return match && net.isIP(match[1]) !== 0 ? match[1] : null;
}

function minRtt(values: number[]): number | null {
  return values.length ? Math.round(Math.min(...values) * 10) / 10 : null;
}

/** Saída do `traceroute -n` (Linux): "  3  10.0.0.1  8.123 ms  7.9 ms *". Um salto pode listar mais de um IP. */
export function parseTracerouteOutput(stdout: string): TraceHop[] {
  const hops: TraceHop[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const ttl = Number(match[1]);
    const tokens = match[2].trim().split(/\s+/);
    let ip: string | null = null;
    const altIps: string[] = [];
    const rtts: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const candidate = ipOf(tokens[i]);
      if (candidate && tokens[i + 1] !== "ms") {
        if (ip === null) ip = candidate;
        else if (candidate !== ip && !altIps.includes(candidate)) altIps.push(candidate);
        continue;
      }
      if (tokens[i + 1] === "ms") {
        const value = Number(tokens[i]);
        if (Number.isFinite(value)) rtts.push(value);
        i++;
      }
    }
    hops.push({ ttl, ip, rttMs: ip ? minRtt(rtts) : null, altIps });
  }
  return hops;
}

/**
 * Saída do `tracepath -n` (iputils): " 1:  192.168.0.1   0.512ms" e linhas extras do mesmo salto
 * (" 1?: [LOCALHOST] pmtu 1500", "     asymm 5"). Fica a primeira resposta de cada salto.
 */
export function parseTracepathOutput(stdout: string): TraceHop[] {
  const byTtl = new Map<number, TraceHop>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\??:\s+(\S+)(?:\s+([\d.]+)ms)?/.exec(line);
    if (!match) continue;
    const ttl = Number(match[1]);
    const ip = ipOf(match[2]);
    const rtt = match[3] ? Number(match[3]) : null;
    const current = byTtl.get(ttl);
    if (ip && (!current || current.ip === null)) byTtl.set(ttl, { ttl, ip, rttMs: rtt !== null && Number.isFinite(rtt) ? Math.round(rtt * 10) / 10 : null, altIps: [] });
    else if (ip && current && current.ip !== ip && !current.altIps.includes(ip)) current.altIps.push(ip);
    else if (!current) byTtl.set(ttl, { ttl, ip: null, rttMs: null, altIps: [] });
  }
  return [...byTtl.values()].sort((a, b) => a.ttl - b.ttl);
}

/** Saída do `tracert -d` (Windows): "  3    12 ms    11 ms    <1 ms  10.0.0.1" e "  4     *        *        *     Esgotado...". */
export function parseTracertOutput(stdout: string): TraceHop[] {
  const hops: TraceHop[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+((?:(?:<?\d+\s*ms|\*)\s+){1,3})(.*)$/.exec(line);
    if (!match) continue;
    const rtts = [...match[2].matchAll(/<?(\d+)\s*ms/g)].map((m) => Number(m[1]));
    const ip = ipOf(match[3].trim().split(/\s+/).pop());
    hops.push({ ttl: Number(match[1]), ip, rttMs: ip ? minRtt(rtts) : null, altIps: [] });
  }
  return hops;
}

/** Corta os "*" do fim (salto que nunca respondeu depois do último que respondeu) e diz se o destino foi alcançado. */
export function finishHops(hops: TraceHop[], destination: string | null): { hops: TraceHop[]; reached: boolean } {
  let end = hops.length;
  while (end > 0 && hops[end - 1].ip === null) end--;
  const trimmed = hops.slice(0, end);
  const last = trimmed[trimmed.length - 1];
  return { hops: trimmed, reached: !!last && destination !== null && last.ip === destination };
}

interface Tool {
  name: string;
  /** Nome gravado em RouteTrace.tool. */
  label: string;
  args: (host: string) => string[];
  parse: (stdout: string) => TraceHop[];
}

const BASE = ["-n", "-q", "2", "-w", "2", "-m", String(TRACE_MAX_HOPS)];
const TRACEROUTE_UDP: Tool = { name: "traceroute", label: "traceroute", args: (h) => [...BASE, h], parse: parseTracerouteOutput };
/** Porta fixa 33434: o mesmo fluxo (endereços e portas) em todas as sondas, como o paris-traceroute. */
const TRACEROUTE_PARIS: Tool = { name: "traceroute", label: "traceroute (Paris)", args: (h) => ["-U", "-p", "33434", ...BASE, h], parse: parseTracerouteOutput };
const TRACEROUTE_TCP: Tool = { name: "traceroute", label: "traceroute (TCP 443)", args: (h) => ["-T", "-p", "443", ...BASE, h], parse: parseTracerouteOutput };
const TRACEPATH: Tool = { name: "tracepath", label: "tracepath", args: (h) => ["-n", "-m", String(TRACE_MAX_HOPS), h], parse: parseTracepathOutput };
const TRACERT: Tool = { name: "tracert", label: "tracert", args: (h) => ["-d", "-h", String(TRACE_MAX_HOPS), "-w", "2000", h], parse: parseTracertOutput };

/** As ferramentas de um modo, na ordem de tentativa (a segunda só quando a primeira não existe). */
function toolsFor(mode: Exclude<TraceMode, "union">, platform: NodeJS.Platform = process.platform): Tool[] {
  if (platform === "win32") return [TRACERT];
  if (mode === "tcp") return [TRACEROUTE_TCP];
  return [mode === "paris" ? TRACEROUTE_PARIS : TRACEROUTE_UDP, TRACEPATH];
}

/** O traceroute sem permissão para o modo pedido (TCP precisa de socket bruto). */
export function isPermissionError(stderr: string): boolean {
  return /privileges|not permitted|permission denied|requires? root|you do not have/i.test(stderr);
}

function run(tool: Tool, host: string): Promise<{ stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(
      tool.name,
      tool.args(host),
      { env: { ...process.env, LC_ALL: "C", LANG: "C" }, timeout: TRACE_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT" }),
    );
  });
}

/** Resolve o nome uma vez, para o resultado poder dizer se o último salto é o destino. */
async function resolveHost(host: string): Promise<string | null> {
  if (net.isIP(host)) return host;
  const { lookup } = await import("node:dns/promises");
  try {
    return (await lookup(host, { family: 4 })).address;
  } catch {
    return null;
  }
}

const fail = (host: string, address: string | null, mode: TraceMode, error: string, tool: string | null = null): TraceResult => ({ ok: false, host, address, tool, hops: [], reached: false, error, mode });

/** Um rastreio num modo só. */
export async function traceRoute(host: string, mode: Exclude<TraceMode, "union"> = "udp"): Promise<TraceResult> {
  if (!isTraceableHost(host)) return fail(String(host), null, mode, "endereço inválido para traceroute");
  const destination = await resolveHost(host);
  if (!destination) return fail(host, null, mode, "nome não encontrado");
  for (const tool of toolsFor(mode)) {
    const { stdout, stderr, missing } = await run(tool, destination);
    if (missing) continue;
    if (mode === "tcp" && isPermissionError(stderr)) return { ...fail(host, destination, mode, "sem permissão para o traceroute TCP (sudo netinventoryctl rota-tcp)", tool.label), tcp: "denied" };
    const { hops, reached } = finishHops(tool.parse(stdout), destination);
    const tcp = mode === "tcp" ? "ok" : null;
    if (!hops.length) return { ...fail(host, destination, mode, "nenhum salto respondeu", tool.label), tcp };
    return { ok: true, host, address: destination, tool: tool.label, hops, reached, error: null, mode, tcp };
  }
  const missingError = process.platform === "win32" ? "tracert indisponível" : "traceroute indisponível no servidor (sudo apt install traceroute)";
  return { ...fail(host, destination, mode, missingError), tcp: mode === "tcp" ? "unavailable" : null };
}

/** Quantos saltos responderam. */
const answered = (t: TraceResult) => t.hops.filter((h) => h.ip !== null).length;

/** O melhor de dois rastreios: o que chegou ao destino; senão o que foi mais longe; empate fica o primeiro. */
export function betterTrace(a: TraceResult, b: TraceResult): TraceResult {
  if (!b.ok) return a;
  if (!a.ok) return b;
  if (a.reached !== b.reached) return a.reached ? a : b;
  const lastA = a.hops[a.hops.length - 1]?.ttl ?? 0;
  const lastB = b.hops[b.hops.length - 1]?.ttl ?? 0;
  if (lastA !== lastB) return lastA > lastB ? a : b;
  return answered(b) > answered(a) ? b : a;
}

/**
 * União de rastreios do mesmo destino (pura): por salto, o primeiro IP visto fica como principal e os outros
 * vão para `altIps`; o RTT é o menor. Alcançado se qualquer um alcançou.
 */
export function mergeTraces(results: readonly TraceResult[]): TraceResult {
  const ok = results.filter((r) => r.ok);
  const tcp = results.find((r) => r.tcp)?.tcp ?? null;
  if (!ok.length) return { ...(results[0] ?? fail("", null, "union", "nenhum rastreio")), mode: "union", tcp };
  const byTtl = new Map<number, TraceHop>();
  // O que chegou mais longe primeiro: o IP principal de cada salto vem do rastreio mais completo.
  const top = ok.reduce((a, b) => betterTrace(a, b));
  const ordered = [top, ...ok.filter((r) => r !== top)];
  for (const r of ordered)
    for (const hop of r.hops) {
      const cur = byTtl.get(hop.ttl);
      if (!cur) {
        byTtl.set(hop.ttl, { ...hop, altIps: [...hop.altIps] });
        continue;
      }
      for (const ip of [hop.ip, ...hop.altIps]) {
        if (!ip) continue;
        if (cur.ip === null) cur.ip = ip;
        else if (ip !== cur.ip && !cur.altIps.includes(ip)) cur.altIps.push(ip);
      }
      if (hop.rttMs !== null && (cur.rttMs === null || hop.rttMs < cur.rttMs)) cur.rttMs = hop.rttMs;
    }
  const best = ordered[0];
  let hops = [...byTtl.values()].sort((x, y) => x.ttl - y.ttl);
  // Um modo chegou ao destino num TTL menor que o último roteador de outro modo: a rota acaba no destino,
  // com o tempo medido até ele (os roteadores além são de outro caminho e inflariam o RTT do destino).
  const dest = best.address;
  const destAt = dest ? hops.findIndex((h) => h.ip === dest || h.altIps.includes(dest)) : -1;
  if (dest && destAt >= 0) {
    const ttl = hops[destAt].ttl;
    const rtts = ordered.flatMap((r) => r.hops.filter((h) => h.ttl === ttl && h.ip === dest && h.rttMs !== null).map((h) => h.rttMs!));
    hops = [...hops.slice(0, destAt), { ...hops[destAt], ip: dest, altIps: [], rttMs: rtts.length ? Math.min(...rtts) : hops[destAt].rttMs }];
  }
  const { hops: trimmed, reached } = finishHops(hops, dest);
  const tools = [...new Set(ordered.map((r) => r.tool).filter(Boolean))].join(" + ");
  return { ...best, hops: trimmed, reached: reached || ok.some((r) => r.reached), tool: tools || best.tool, mode: "union", tcp };
}

/**
 * O rastreio do agendador: UDP com fluxo fixo (Paris); se ele não chega ao destino, tenta TCP 443 e fica o
 * que foi mais longe. É o caso dos CDNs, cujos roteadores descartam UDP e ICMP depois da borda.
 */
export async function traceBest(host: string): Promise<TraceResult> {
  const paris = await traceRoute(host, "paris");
  if (paris.reached || process.platform === "win32" || (!paris.ok && paris.tool === null && paris.address === null)) return paris;
  const tcp = await traceRoute(host, "tcp");
  const best = betterTrace(paris, tcp);
  return { ...best, tcp: tcp.tcp ?? null };
}

/** Os três modos seguidos e a união ("Rastrear rota" no detalhe): o retrato completo, mais lento. */
export async function traceAllModes(host: string): Promise<TraceResult> {
  const results: TraceResult[] = [];
  for (const mode of ["paris", "udp", "tcp"] as const) {
    const r = await traceRoute(host, mode);
    results.push(r);
    // Sem traceroute no servidor ou nome inválido: as outras rodadas dariam o mesmo.
    if (process.platform === "win32" || (!r.ok && (r.address === null || /indisponível/.test(r.error ?? "")))) break;
  }
  return mergeTraces(results);
}
