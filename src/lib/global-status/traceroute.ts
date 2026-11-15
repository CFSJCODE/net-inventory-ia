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
}

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
    const rtts: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const candidate = ipOf(tokens[i]);
      if (candidate && tokens[i + 1] !== "ms") {
        ip ??= candidate;
        continue;
      }
      if (tokens[i + 1] === "ms") {
        const value = Number(tokens[i]);
        if (Number.isFinite(value)) rtts.push(value);
        i++;
      }
    }
    hops.push({ ttl, ip, rttMs: ip ? minRtt(rtts) : null });
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
    if (ip && (!current || current.ip === null)) byTtl.set(ttl, { ttl, ip, rttMs: rtt !== null && Number.isFinite(rtt) ? Math.round(rtt * 10) / 10 : null });
    else if (!current) byTtl.set(ttl, { ttl, ip: null, rttMs: null });
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
    hops.push({ ttl: Number(match[1]), ip, rttMs: ip ? minRtt(rtts) : null });
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
  args: (host: string) => string[];
  parse: (stdout: string) => TraceHop[];
}

const LINUX_TOOLS: Tool[] = [
  { name: "traceroute", args: (h) => ["-n", "-q", "2", "-w", "2", "-m", String(TRACE_MAX_HOPS), h], parse: parseTracerouteOutput },
  { name: "tracepath", args: (h) => ["-n", "-m", String(TRACE_MAX_HOPS), h], parse: parseTracepathOutput },
];
const WINDOWS_TOOLS: Tool[] = [{ name: "tracert", args: (h) => ["-d", "-h", String(TRACE_MAX_HOPS), "-w", "2000", h], parse: parseTracertOutput }];

function run(tool: Tool, host: string): Promise<{ stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(
      tool.name,
      tool.args(host),
      { env: { ...process.env, LC_ALL: "C", LANG: "C" }, timeout: TRACE_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 256 * 1024 },
      (err, stdout) => resolve({ stdout: String(stdout ?? ""), missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT" }),
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

export async function traceRoute(host: string): Promise<TraceResult> {
  if (!isTraceableHost(host)) return { ok: false, host: String(host), address: null, tool: null, hops: [], reached: false, error: "endereço inválido para traceroute" };
  const destination = await resolveHost(host);
  if (!destination) return { ok: false, host, address: null, tool: null, hops: [], reached: false, error: "nome não encontrado" };
  for (const tool of process.platform === "win32" ? WINDOWS_TOOLS : LINUX_TOOLS) {
    const { stdout, missing } = await run(tool, destination);
    if (missing) continue;
    const { hops, reached } = finishHops(tool.parse(stdout), destination);
    if (!hops.length) return { ok: false, host, address: destination, tool: tool.name, hops: [], reached: false, error: "nenhum salto respondeu" };
    return { ok: true, host, address: destination, tool: tool.name, hops, reached, error: null };
  }
  return {
    ok: false,
    host,
    address: destination,
    tool: null,
    hops: [],
    reached: false,
    error: process.platform === "win32" ? "tracert indisponível" : "traceroute indisponível no servidor (sudo apt install traceroute)",
  };
}
