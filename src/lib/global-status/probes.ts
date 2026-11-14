import { execFile } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { endianness } from "node:os";
import tls from "node:tls";
import { getSystemDnsServers } from "@/lib/network/system-dns";
import { readRouteTable, type RouteEntry } from "@/lib/network/tools/route-table";
import { jitter } from "./stats";
import { AUTO_GATEWAY, AUTO_SYSTEM_DNS, DEFAULT_DNS_NAME, type ProbePhase, type ProbeResult, type ProbeSpec } from "./types";

/**
 * Sondas de medição própria: HTTP(S) com os tempos de cada etapa, handshake TCP, ping ICMP, DNS e
 * certificado TLS. Nenhuma função rejeita: falha vira `{ ok: false, latencyMs: null, error, failedAt }`.
 *
 * Tudo em IPv4 (`family: 4`): os números precisam ser comparáveis de uma medição para a outra, e muita
 * rede local não tem rota IPv6. Os tempos vêm de `performance.now()`, em ms com uma casa decimal.
 *
 * Cada sonda termina uma única vez e, em qualquer caminho (sucesso, erro ou prazo), cancela o próprio
 * temporizador e destrói o socket. Os ouvintes de "error" ficam no socket e no pedido depois disso, de
 * propósito: o Node ainda emite "error" depois de um destroy (o "socket hang up" do pedido cancelado
 * pelo prazo), e um "error" sem ouvinte derrubaria o processo.
 */

/** Tempo máximo de uma medição HTTP/TLS (plano aprovado: 10 s). */
export const PROBE_TIMEOUT_MS = 10_000;
const TCP_TIMEOUT_MS = 5_000;
const DNS_TIMEOUT_MS = 3_000;
/**
 * Folga do corte da consulta DNS. O Node só confere o prazo do c-ares de segundo em segundo, e com mais
 * de um servidor configurado o c-ares dá um prazo inteiro para cada um: sem o corte, uma consulta de
 * 3 s poderia levar 8.
 */
const DNS_GUARD_MS = 500;
const PING_TIMEOUT_MS = 10_000;
const PING_COUNT = 5;
const PING_MAX_COUNT = 100;
const USER_AGENT = "NetInventory-StatusProbe/1.0 (+https://github.com/CFSJCODE/net-inventory-ia)";
/**
 * Tamanho aceito para os cabeçalhos da resposta. O padrão do Node (16 KiB) fica perto do que alguns
 * serviços do catálogo já mandam (9 KiB em 11/2026); passar dele viraria uma falsa queda.
 */
const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
const DAY_MS = 86_400_000;
const GATEWAY_FOUND_TTL_MS = 5 * 60_000;
const GATEWAY_MISSING_TTL_MS = 60_000;

export interface ProbeOptions {
  timeoutMs?: number;
}

export interface PingStats {
  /** Respostas recebidas. */
  received: number;
  /** RTT de cada resposta, em ms, na ordem. */
  rtts: number[];
  lossPct: number;
  avgMs: number | null;
  jitterMs: number | null;
}

// ---------------------------------------------------------------- utilidades

const ignore = (): void => undefined;

/** Milissegundos com uma casa decimal. */
const round1 = (ms: number): number => Math.round(ms * 10) / 10;

/** Três casas, a precisão que o próprio ping informa (tira o ruído de ponto flutuante da média). */
const round3 = (value: number | null): number | null => (value === null ? null : Math.round(value * 1000) / 1000);

/** Prazo utilizável por setTimeout, execFile e c-ares: inteiro positivo; qualquer outra coisa vira o padrão. */
function deadlineMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.ceil(value), 0x7fffffff) : fallback;
}

function failure(error: string, failedAt: ProbePhase | null): ProbeResult {
  return { ok: false, latencyMs: null, error, failedAt };
}

/** Texto curto de um erro sem frase própria: o código do Node quando existe, senão a mensagem. */
function errorText(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  const text = typeof e?.code === "string" && e.code ? e.code : typeof e?.message === "string" && e.message ? e.message : String(err ?? "");
  return (text || "erro desconhecido").slice(0, 120);
}

const TIMEOUT_ERROR: Record<ProbePhase, string> = {
  dns: "tempo esgotado na resolução do nome",
  connect: "tempo esgotado ao conectar",
  tls: "tempo esgotado no handshake TLS",
  http: "tempo esgotado aguardando a resposta",
};
const CLOSED_BY_SERVER = "conexão encerrada pelo servidor";
const TLS_HANDSHAKE_FAILED = "falha no handshake TLS";

/** Frase e etapa de um erro de socket; `phase` é a etapa em andamento quando o erro chegou. */
function networkFailure(err: unknown, phase: ProbePhase): ProbeResult {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof e?.code === "string" ? e.code : "";
  switch (code) {
    case "ENOTFOUND":
      return failure("nome não encontrado no DNS", "dns");
    case "EAI_AGAIN":
      return failure("o DNS não respondeu", "dns");
    case "ECONNREFUSED":
      return failure("conexão recusada", "connect");
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EADDRNOTAVAIL":
      return failure("sem rota até o destino", "connect");
    case "ETIMEDOUT":
      return failure(TIMEOUT_ERROR.connect, "connect");
    case "ECONNRESET":
    case "EPIPE":
      return failure(CLOSED_BY_SERVER, phase);
    case "EPROTO":
      return failure(TLS_HANDSHAKE_FAILED, "tls");
  }
  if (code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_")) return failure(TLS_HANDSHAKE_FAILED, "tls");
  if (typeof e?.message === "string" && e.message.includes("socket hang up")) return failure(CLOSED_BY_SERVER, phase);
  return failure(errorText(err), phase);
}

// ---------------------------------------------------------------- etapas de uma conexão

/** Instante de cada etapa de uma conexão, lido dos eventos do socket. */
interface ConnectionTrace {
  t0: number;
  /** Etapa em andamento: decide a frase e o `failedAt` de um erro ou do prazo. */
  phase: ProbePhase;
  lookupAt: number | null;
  connectAt: number | null;
  secureAt: number | null;
  certDays: number | null;
  certLifetimeDays: number | null;
}

/** Um IP literal não passa pela resolução de nome: a medição já começa na etapa de conexão. */
function startTrace(hostIsIp: boolean): ConnectionTrace {
  return { t0: performance.now(), phase: hostIsIp ? "connect" : "dns", lookupAt: null, connectAt: null, secureAt: null, certDays: null, certLifetimeDays: null };
}

/**
 * Dias até o certificado vencer (negativo = vencido) e a validade total dele.
 *
 * Um certificado em que o Node não confia NÃO reprova a medição (as sondas usam
 * `rejectUnauthorized: false`). A sonda mede se o serviço é alcançável a partir desta rede; atrás de um
 * proxy que inspeciona TLS, com uma CA que os navegadores da rede aceitam e o Node não, reprovar pintaria
 * todos os serviços de vermelho para sempre. O vencimento continua sendo pego por `certDays`.
 */
function readCertificate(socket: tls.TLSSocket): Pick<ConnectionTrace, "certDays" | "certLifetimeDays"> {
  try {
    // Vem {} quando o servidor não manda certificado e null com o socket já destruído.
    const cert = socket.getPeerCertificate() as Partial<tls.PeerCertificate> | null;
    const validTo = Date.parse(cert?.valid_to ?? "");
    if (Number.isNaN(validTo)) return { certDays: null, certLifetimeDays: null };
    const validFrom = Date.parse(cert?.valid_from ?? "");
    return {
      certDays: Math.floor((validTo - Date.now()) / DAY_MS),
      certLifetimeDays: Number.isNaN(validFrom) ? null : Math.round((validTo - validFrom) / DAY_MS),
    };
  } catch {
    return { certDays: null, certLifetimeDays: null };
  }
}

/**
 * Marca as etapas a partir dos eventos do socket. `live()` fica falso quando a medição já terminou: o
 * Node entrega "lookup" até de um socket destruído (o getaddrinfo não pode ser cancelado), e um evento
 * atrasado não pode mexer num resultado já entregue. `ready` é chamado quando a conexão está pronta
 * para uso (TCP conectado ou, com `secure`, TLS concluído).
 */
function traceSocket(socket: net.Socket, trace: ConnectionTrace, secure: boolean, live: () => boolean, ready?: () => void): void {
  socket.once("lookup", (err: Error | null) => {
    // Com erro o nome não resolveu: o "error" chega em seguida e a etapa continua sendo "dns".
    if (!live() || err) return;
    trace.lookupAt = performance.now();
    trace.phase = "connect";
  });
  socket.once("connect", () => {
    if (!live()) return;
    trace.connectAt = performance.now();
    trace.phase = secure ? "tls" : "http";
    if (!secure) ready?.();
  });
  if (!secure) return;
  socket.once("secureConnect", () => {
    if (!live()) return;
    trace.secureAt = performance.now();
    trace.phase = "http";
    Object.assign(trace, readCertificate(socket as tls.TLSSocket));
    ready?.();
  });
}

/** Parcelas já medidas; null = a etapa não aconteceu (IP literal não resolve nome, http não tem TLS). */
function timings(trace: ConnectionTrace): { dnsMs: number | null; connectMs: number | null; tlsMs: number | null } {
  const { t0, lookupAt, connectAt, secureAt } = trace;
  return {
    dnsMs: lookupAt === null ? null : round1(lookupAt - t0),
    connectMs: connectAt === null ? null : round1(connectAt - (lookupAt ?? t0)),
    tlsMs: secureAt === null || connectAt === null ? null : round1(secureAt - connectAt),
  };
}

// ---------------------------------------------------------------- HTTP

/** GET sem seguir redirecionamento; mede DNS, TCP, TLS e espera do servidor. "No ar" = qualquer resposta HTTP abaixo de 500. */
export function probeHttp(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = deadlineMs(options.timeoutMs, PROBE_TIMEOUT_MS);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve(failure("URL inválida", null));
  }
  const secure = target.protocol === "https:";
  if ((!secure && target.protocol !== "http:") || !target.hostname) return Promise.resolve(failure("URL inválida", null));

  return new Promise((resolve) => {
    // O WHATWG URL devolve IPv6 entre colchetes, que o net.isIP não aceita.
    const trace = startTrace(net.isIP(target.hostname.replace(/^\[|\]$/g, "")) !== 0);
    let req: http.ClientRequest | null = null;
    let socket: net.Socket | null = null;
    let settled = false;

    // Única saída: a primeira chamada vence; as seguintes (o "socket hang up" depois do prazo, o "close" depois do erro) não fazem nada.
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      socket?.destroy();
      resolve(result);
    };
    // Um prazo só, do início ao primeiro byte; a etapa em que ele estoura diz onde a medição parou.
    const timer = setTimeout(() => finish(failure(TIMEOUT_ERROR[trace.phase], trace.phase)), timeoutMs);

    // agent: false abre uma conexão nova a cada medição, para medir DNS, TCP e TLS todas as vezes.
    const requestOptions: http.RequestOptions = {
      method: "GET",
      agent: false,
      family: 4,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
    };
    let created: http.ClientRequest;
    try {
      // rejectUnauthorized: false, pelo motivo explicado em readCertificate.
      created = secure ? https.request(target, { ...requestOptions, rejectUnauthorized: false }) : http.request(target, requestOptions);
    } catch {
      // URL que o WHATWG aceita e o cliente HTTP do Node recusa: nenhum socket chegou a ser aberto.
      finish(failure("URL inválida", null));
      return;
    }
    req = created;

    created.on("socket", (opened) => {
      socket = opened;
      // O cliente HTTP repassa os erros do socket ao pedido; este ouvinte só garante que um erro tardio nunca fique sem dono.
      opened.on("error", ignore);
      if (settled) {
        opened.destroy();
        return;
      }
      traceSocket(opened, trace, secure, () => !settled);
    });
    created.on("response", (res) => {
      const responseAt = performance.now();
      // O corpo nunca é lido: basta o status. Destruir a resposta fecha a conexão na hora.
      res.on("error", ignore);
      res.destroy();
      if (settled) return;
      const status = res.statusCode ?? 0;
      const totalMs = round1(responseAt - trace.t0);
      const measured = {
        httpStatus: status,
        ...timings(trace),
        ttfbMs: round1(responseAt - (trace.secureAt ?? trace.connectAt ?? trace.t0)),
        totalMs,
        certDays: trace.certDays,
        certLifetimeDays: trace.certLifetimeDays,
      };
      // Redirecionamento, 401, 403 e 404 também são resposta: o serviço está no ar. Só 5xx conta como falha.
      finish(status < 500 ? { ok: true, latencyMs: totalMs, ...measured } : { ok: false, latencyMs: null, ...measured, error: `HTTP ${status}`, failedAt: "http" });
    });
    created.on("error", (err) => finish(networkFailure(err, trace.phase)));
    // Rede de segurança: o Node sempre emite "error" antes, mas um pedido fechado sem resposta não pode ficar esperando o prazo.
    created.on("close", () => finish(failure(CLOSED_BY_SERVER, trace.phase)));
    created.end();
  });
}

// ---------------------------------------------------------------- TCP e TLS

/** Handshake TCP e, com `secure`, o handshake TLS em seguida; fecha a conexão assim que ela fica pronta. */
function probeSocket(host: string, port: number, timeoutMs: number, secure: boolean): Promise<ProbeResult> {
  // Sem esta checagem o net trocaria um host vazio por "localhost" e mediria a máquina errada.
  if (typeof host !== "string" || !host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.resolve(failure("host ou porta inválidos", null));
  }

  return new Promise((resolve) => {
    const hostIsIp = net.isIP(host) !== 0;
    const trace = startTrace(hostIsIp);
    let socket: net.Socket | null = null;
    let settled = false;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(failure(TIMEOUT_ERROR[trace.phase], trace.phase)), timeoutMs);

    let opened: net.Socket;
    try {
      // rejectUnauthorized: false, pelo motivo explicado em readCertificate. O SNI não aceita IP (RFC 6066).
      const tlsOptions: tls.ConnectionOptions & net.TcpSocketConnectOpts = { host, port, family: 4, rejectUnauthorized: false, ...(hostIsIp ? {} : { servername: host }) };
      opened = secure ? tls.connect(tlsOptions) : net.connect({ host, port, family: 4 });
    } catch (err) {
      finish(failure(errorText(err), null));
      return;
    }
    socket = opened;

    opened.on("error", (err) => finish(networkFailure(err, trace.phase)));
    // Rede de segurança para um socket fechado sem "error": não fica esperando o prazo.
    opened.once("close", () => finish(failure(CLOSED_BY_SERVER, trace.phase)));
    traceSocket(opened, trace, secure, () => !settled, () => {
      const { dnsMs, connectMs, tlsMs } = timings(trace);
      finish(secure ? { ok: true, latencyMs: tlsMs, dnsMs, connectMs, tlsMs, certDays: trace.certDays, certLifetimeDays: trace.certLifetimeDays } : { ok: true, latencyMs: connectMs, dnsMs, connectMs });
    });
  });
}

/** Tempo do handshake TCP (um round-trip): a melhor estimativa da latência de rede onde ICMP é bloqueado. */
export function probeTcp(host: string, port: number, options: ProbeOptions = {}): Promise<ProbeResult> {
  return probeSocket(host, port, deadlineMs(options.timeoutMs, TCP_TIMEOUT_MS), false);
}

/** Handshake TLS e validade do certificado (dias restantes). Certificado não confiável não é falha: ver readCertificate. */
export function probeTls(host: string, port = 443, options: ProbeOptions = {}): Promise<ProbeResult> {
  return probeSocket(host, port, deadlineMs(options.timeoutMs, PROBE_TIMEOUT_MS), true);
}

// ---------------------------------------------------------------- DNS

const DNS_NO_ANSWER = "o servidor DNS não respondeu";
const DNS_NAME_NOT_FOUND = "nome não encontrado";
const DNS_ERROR = new Map<string, string>([
  ["ETIMEOUT", DNS_NO_ANSWER],
  ["ECONNREFUSED", "o servidor DNS recusou a consulta"],
  ["ESERVFAIL", "o servidor DNS devolveu falha (SERVFAIL)"],
  ["EREFUSED", "consulta recusada pelo servidor DNS"],
  ["ENOTFOUND", DNS_NAME_NOT_FOUND],
  ["ENODATA", DNS_NAME_NOT_FOUND],
]);

function dnsFailure(err: unknown): ProbeResult {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return failure((typeof code === "string" ? DNS_ERROR.get(code) : undefined) ?? errorText(err), "dns");
}

/** Tempo de resolução de `name` (registro A) em `server` ("auto:system" = resolvedores do sistema). */
export async function probeDns(server: string, name: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = deadlineMs(options.timeoutMs, DNS_TIMEOUT_MS);
  let resolver: Resolver;
  try {
    // Um resolvedor novo a cada medição: sem cache, toda medição é uma consulta de verdade.
    resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    if (server === AUTO_SYSTEM_DNS) {
      // No Windows o c-ares pode ler um DNS que o sistema não usa; fora dele a lista vem vazia e valem os padrões do resolvedor (resolv.conf).
      const system = await getSystemDnsServers().catch(() => [] as string[]);
      if (system.length) resolver.setServers(system);
    } else {
      resolver.setServers([server]);
    }
  } catch (err) {
    return dnsFailure(err);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(result);
    };
    // Entrega o resultado antes de cancelar: o ECANCELLED que o cancelamento provoca chega com a medição já encerrada.
    const guard = setTimeout(() => {
      finish(failure(DNS_NO_ANSWER, "dns"));
      resolver.cancel();
    }, timeoutMs + DNS_GUARD_MS);

    const t0 = performance.now();
    try {
      resolver.resolve4(name).then(
        (addresses) => {
          const dnsMs = round1(performance.now() - t0);
          finish(addresses.length ? { ok: true, latencyMs: dnsMs, dnsMs } : failure(DNS_NAME_NOT_FOUND, "dns"));
        },
        (err) => finish(dnsFailure(err)),
      );
    } catch (err) {
      // resolve4 lança na hora com um nome que não é texto.
      finish(dnsFailure(err));
    }
  });
}

// ---------------------------------------------------------------- ICMP

/** Nome de host aceito pelo ping: sem espaço e sem começar por "-", para nunca ser lido como opção. */
const PING_HOSTNAME = /^(?!-)[A-Za-z0-9.-]{1,253}$/;

/**
 * Argumentos do ping de cada sistema. Linux (iputils): 5 pacotes a cada 0,2 s e 1 s de espera pela
 * resposta. Windows: `-w` em milissegundos. macOS e BSD: `-W` em milissegundos, e um intervalo abaixo
 * de 1 s exige root, então fica o padrão.
 */
export function pingArgs(host: string, count: number, platform: NodeJS.Platform): string[] {
  const family = net.isIP(host) === 6 ? "-6" : "-4";
  if (platform === "win32") return ["-n", String(count), "-w", "1000", "-4", host];
  if (platform === "linux") return ["-n", "-c", String(count), "-i", "0.2", "-W", "1", family, host];
  return ["-n", "-c", String(count), "-W", "1000", host];
}

/** Interpreta a saída do ping do Linux ou do Windows, em qualquer idioma; `sent` = pacotes enviados. */
export function parsePingOutput(stdout: string, sent: number): PingStats {
  const expected = Number.isFinite(sent) && sent > 0 ? Math.floor(sent) : 0;
  const rtts: number[] = [];
  let received = 0;
  for (const line of String(stdout).split(/\r?\n/)) {
    // Duplicatas ("DUP!") não podem passar do que foi enviado.
    if (received >= expected) break;
    // Só "ttl=" identifica uma resposta em qualquer idioma; o "Host de destino inacessível" do Windows vem sem TTL.
    if (!/ttl=/i.test(line)) continue;
    received++;
    const match = /([=<])\s*([\d.,]+)\s*ms/i.exec(line);
    if (!match) continue;
    const value = Number(match[2].replace(",", "."));
    // "tempo<1ms" do Windows: abaixo da resolução do relógio, conta como a metade.
    if (Number.isFinite(value)) rtts.push(match[1] === "<" ? value / 2 : value);
  }
  return {
    received,
    rtts,
    lossPct: expected > 0 ? ((expected - received) / expected) * 100 : 100,
    avgMs: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
    jitterMs: jitter(rtts),
  };
}

/**
 * true quando o ping não pode rodar neste servidor: sem o binário (ENOENT), sem permissão para
 * executá-lo ou para abrir o socket ICMP. Isso não diz nada sobre o alvo, então não conta como falha.
 */
export function isPingUnavailable(code: unknown, stderr: string): boolean {
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return true;
  return /operation not permitted|permission denied/i.test(String(stderr ?? ""));
}

function pingUnavailable(): ProbeResult {
  return { ok: false, latencyMs: null, unsupported: true, error: "ping indisponível neste servidor" };
}

/** Ping do sistema (5 pacotes por padrão): RTT médio, perda e jitter. Sem binário de ping devolve `unsupported`. */
export function probeIcmp(host: string, options: ProbeOptions & { count?: number } = {}): Promise<ProbeResult> {
  // O host vai para o execFile, sem shell: o único risco é um argumento ser lido como opção do ping ("-c 9999").
  if (typeof host !== "string" || !(net.isIP(host) !== 0 || PING_HOSTNAME.test(host))) {
    return Promise.resolve({ ok: false, latencyMs: null, error: "endereço inválido para ping" });
  }
  const requested = options.count;
  const count = typeof requested === "number" && Number.isFinite(requested) && requested >= 1 ? Math.min(Math.floor(requested), PING_MAX_COUNT) : PING_COUNT;
  const timeoutMs = deadlineMs(options.timeoutMs, PING_TIMEOUT_MS);

  return new Promise((resolve) => {
    try {
      execFile(
        "ping",
        pingArgs(host, count, process.platform),
        // LC_ALL=C: o iputils lê "-i 0.2" com o separador decimal do idioma e falha em pt_BR. No prazo o processo é morto com SIGKILL, que não pode ser ignorado.
        { env: { ...process.env, LC_ALL: "C", LANG: "C" }, timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true },
        (err, stdout, stderr) => {
          // A saída é lida mesmo com código de saída diferente de zero: o ping sai com 1 na perda total.
          const stats = parsePingOutput(String(stdout ?? ""), count);
          if (stats.received > 0) {
            resolve({ ok: true, latencyMs: round3(stats.avgMs), lossPct: stats.lossPct, jitterMs: round3(stats.jitterMs) });
          } else if (isPingUnavailable(err?.code, String(stderr ?? ""))) {
            resolve(pingUnavailable());
          } else {
            resolve({ ok: false, latencyMs: null, lossPct: stats.lossPct, jitterMs: null, error: "sem resposta ao ping", failedAt: "connect" });
          }
        },
      );
    } catch {
      // O execFile lança na hora quando nem consegue montar o processo.
      resolve(pingUnavailable());
    }
  });
}

// ---------------------------------------------------------------- gateway padrão

/**
 * Gateway padrão em `/proc/net/route`: destino e máscara 00000000, flag RTF_GATEWAY (0x2), menor
 * métrica primeiro. O kernel imprime o endereço como um inteiro na ordem de bytes da máquina, então em
 * x86 e ARM ("LE") os octetos vêm invertidos.
 */
export function parseProcNetRoute(text: string, byteOrder: "LE" | "BE" = "LE"): string | null {
  let best: { ip: string; metric: number } | null = null;
  for (const line of String(text).split(/\r?\n/)) {
    const [, destination, gateway, flags, , , metric, mask] = line.trim().split(/\s+/);
    if (destination !== "00000000" || !/^[0-9a-f]{8}$/i.test(gateway ?? "")) continue;
    if (mask !== undefined && mask !== "00000000") continue;
    if ((Number.parseInt(flags ?? "", 16) & 0x2) === 0) continue;
    const octets = gateway.match(/../g)!.map((pair) => Number.parseInt(pair, 16));
    const ip = (byteOrder === "LE" ? octets.reverse() : octets).join(".");
    if (ip === "0.0.0.0") continue;
    const weight = Number.parseInt(metric ?? "", 10) || 0;
    if (!best || weight < best.metric) best = { ip, metric: weight };
  }
  return best?.ip ?? null;
}

/** Rota padrão com um próximo salto de verdade (o Windows lista rotas "on-link" com 0.0.0.0), menor métrica primeiro. */
function pickDefaultGateway(routes: RouteEntry[]): string | null {
  let best: RouteEntry | null = null;
  for (const route of routes) {
    if (route.destination !== "0.0.0.0/0" || !net.isIPv4(route.nextHop) || route.nextHop === "0.0.0.0") continue;
    if (!best || (route.metric ?? 0) < (best.metric ?? 0)) best = route;
  }
  return best?.nextHop ?? null;
}

async function discoverGateway(): Promise<string | null> {
  try {
    return pickDefaultGateway(await readRouteTable());
  } catch {
    // Linux sem o binário `ip` (contêiner mínimo): o kernel publica a mesma tabela em /proc.
    if (process.platform !== "linux") return null;
    try {
      return parseProcNetRoute(await readFile("/proc/net/route", "utf8"), endianness());
    } catch {
      return null;
    }
  }
}

let gatewayCache: { ip: string | null; at: number } | null = null;
let gatewayDiscovery: Promise<string | null> | null = null;

/** IP do gateway padrão (cache de 5 min); null quando não dá para descobrir. */
export function defaultGateway(): Promise<string | null> {
  const cached = gatewayCache;
  if (cached) {
    // "Não encontrado" vale só 1 min: o cabo pode voltar. Idade negativa (relógio atrasado) também refaz a busca.
    const age = Date.now() - cached.at;
    if (age >= 0 && age < (cached.ip ? GATEWAY_FOUND_TTL_MS : GATEWAY_MISSING_TTL_MS)) return Promise.resolve(cached.ip);
  }
  // Chamadas simultâneas dividem a mesma busca (no Windows ela abre um PowerShell).
  gatewayDiscovery ??= discoverGateway()
    .catch(() => null)
    .then((ip) => {
      gatewayCache = { ip, at: Date.now() };
      gatewayDiscovery = null;
      return ip;
    });
  return gatewayDiscovery;
}

// ---------------------------------------------------------------- despacho

/** Executa a sonda do tipo do alvo, resolvendo "auto:gateway"/"auto:system". Nunca rejeita. */
export async function runProbe(spec: ProbeSpec): Promise<ProbeResult> {
  try {
    if (!spec || typeof spec !== "object") return failure("alvo de medição inválido", null);
    // Host que não é texto vira vazio, e cada sonda recusa o vazio com a própria frase.
    let host = typeof spec.host === "string" ? spec.host : "";
    if (host === AUTO_GATEWAY) {
      const gateway = await defaultGateway();
      if (!gateway) return { ok: false, latencyMs: null, unsupported: true, error: "gateway padrão não encontrado" };
      host = gateway;
    }
    switch (spec.kind) {
      case "HTTP":
        return await probeHttp(spec.url ?? `https://${host}/`);
      case "TCP":
        return await probeTcp(host, spec.port ?? 443);
      case "TLS":
        return await probeTls(host, spec.port ?? 443);
      case "DNS":
        return await probeDns(host, spec.url ?? DEFAULT_DNS_NAME);
      case "ICMP":
        return await probeIcmp(host);
      default:
        return failure("tipo de medição desconhecido", null);
    }
  } catch (err) {
    // As sondas não rejeitam; isto cobre um erro inesperado para que o agendador nunca receba uma exceção.
    return failure(`falha inesperada na medição: ${errorText(err)}`, null);
  }
}
