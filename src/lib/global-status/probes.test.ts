import { execFileSync, type ChildProcess, type ExecFileException } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { Resolver } from "node:dns/promises";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_GATEWAY, AUTO_SYSTEM_DNS, DEFAULT_DNS_NAME, type ProbeResult, type ProbeSpec } from "./types";

// Só loopback: nada aqui depende de Internet, de binário de ping ou do sistema operacional. O ping, a
// tabela de rotas e o DNS do Windows (PowerShell) são simulados; HTTP, TCP, TLS e DNS falam com
// servidores de verdade em 127.0.0.1.
const mocks = vi.hoisted(() => ({ execFile: vi.fn(), readRouteTable: vi.fn(), getSystemDnsServers: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: mocks.execFile,
}));
vi.mock("@/lib/network/tools/route-table", () => ({ readRouteTable: mocks.readRouteTable }));
vi.mock("@/lib/network/system-dns", () => ({ getSystemDnsServers: mocks.getSystemDnsServers }));

import { defaultGateway, isPingUnavailable, parsePingOutput, parseProcNetRoute, pingArgs, PROBE_TIMEOUT_MS, probeDns, probeHttp, probeIcmp, probeTcp, probeTls, runProbe } from "./probes";

const realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");

const USER_AGENT = "NetInventory-StatusProbe/1.0 (+https://github.com/CFSJCODE/net-inventory-ia)";
const ignore = (): void => undefined;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Espera a condição valer (os fechamentos de socket chegam um instante depois da medição terminar). */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const limit = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > limit) return false;
    await sleep(10);
  }
  return true;
}

/** Tempos da sonda: nunca negativos e com uma casa decimal. */
function expectDuration(value: number | null | undefined): void {
  expect(typeof value).toBe("number");
  expect(value).toBeGreaterThanOrEqual(0);
  expect(Math.round((value as number) * 10) / 10).toBe(value);
}

// ---------------------------------------------------------------- servidores de teste

interface Served {
  port: number;
  /** Conexões abertas agora, vistas pelo servidor: esvazia quando a sonda fecha o socket dela. */
  sockets: Set<net.Socket>;
}

const running: { server: net.Server; sockets: Set<net.Socket> }[] = [];

function serve(server: net.Server): Promise<Served> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", ignore);
    socket.on("close", () => sockets.delete(socket));
  });
  running.push({ server, sockets });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, sockets })));
}

/** Reserva uma porta livre e a fecha em seguida, para que conexões nela sejam recusadas. */
async function reserveClosedPort(): Promise<number> {
  const temp = net.createServer();
  await new Promise<void>((resolve) => temp.listen(0, "127.0.0.1", resolve));
  const port = (temp.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => temp.close(() => resolve()));
  return port;
}

interface SeenRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
}
const seen: SeenRequest[] = [];

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  seen.push({ method: req.method, url: req.url, headers: req.headers });
  res.on("error", ignore);
  switch ((req.url ?? "/").split("?")[0]) {
    case "/ok":
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      break;
    case "/nao-existe":
      res.writeHead(404).end();
      break;
    case "/fora":
      res.writeHead(503, { "retry-after": "30" }).end("em manutenção");
      break;
    case "/redireciona":
      res.writeHead(302, { location: "/destino" }).end();
      break;
    case "/destino":
      res.writeHead(200).end("destino");
      break;
    case "/corpo-sem-fim":
      // Manda os cabeçalhos e um pedaço grande do corpo, e nunca termina: só fecha se o cliente desistir.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(Buffer.alloc(256 * 1024, "x"));
      break;
    case "/lento":
      setTimeout(() => {
        if (!res.socket || res.socket.destroyed) return;
        res.writeHead(200).end("tarde demais");
      }, 400);
      break;
    case "/mudo":
      break; // nunca responde
    default:
      res.writeHead(400).end();
  }
}

/** Certificado autoassinado de 30 dias, criado na hora num diretório temporário e apagado em seguida; null sem openssl. */
function selfSignedCertificate(): { key: string; cert: string } | null {
  let directory: string | null = null;
  try {
    directory = mkdtempSync(join(tmpdir(), "netinventory-probes-"));
    const config = join(directory, "openssl.cnf");
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    // Arquivo de configuração em vez de -subj: o openssl do Git no Windows reescreve argumento que começa com "/".
    writeFileSync(config, "[req]\nprompt = no\ndistinguished_name = dn\n\n[dn]\nCN = localhost\n");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-config", config, "-keyout", key, "-out", cert], { stdio: "ignore", timeout: 30_000 });
    return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  } catch {
    return null;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
const certificate = selfSignedCertificate();

let web: Served;
let webUrl: string;
/** Aceita a conexão TCP e nunca manda nada: o handshake TLS fica esperando. */
let mute: Served;
/** Fecha a conexão assim que ela chega. */
let hangup: Served;
/** Derruba a conexão com RST. */
let reset: Served;
/** Responde algo que não é HTTP. */
let junk: Served;
let secure: Served | null = null;
/** SNI de cada handshake recebido pelo servidor HTTPS (false = o cliente não mandou). */
const serverNames: (string | false | null | undefined)[] = [];

beforeAll(async () => {
  web = await serve(http.createServer(handle));
  webUrl = `http://127.0.0.1:${web.port}`;
  // Lê e descarta o que chega, sem nunca responder: só lendo o servidor percebe quando a sonda fecha a conexão.
  mute = await serve(net.createServer((socket) => socket.resume()));
  hangup = await serve(net.createServer((socket) => socket.destroy()));
  reset = await serve(net.createServer((socket) => socket.resetAndDestroy()));
  junk = await serve(net.createServer((socket) => socket.once("data", () => socket.end("isto não é HTTP\r\n\r\n"))));
  if (certificate) {
    const server = https.createServer(certificate, handle);
    server.on("secureConnection", (socket: tls.TLSSocket) => serverNames.push(socket.servername));
    server.on("tlsClientError", ignore);
    secure = await serve(server);
  }
});

afterAll(async () => {
  for (const { server, sockets } of running) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------- simulações

type PingCallback = (err: ExecFileException | null, stdout: string, stderr: string) => void;

/** Próxima execução do ping: `code` texto = o processo nem iniciou; número = código de saída; `killed` = morto no prazo. */
function nextPing(run: { code?: string | number; stdout?: string; stderr?: string; killed?: boolean }): void {
  mocks.execFile.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: PingCallback) => {
    const failed = run.code !== undefined || run.killed === true;
    const err = failed ? (Object.assign(new Error("Command failed: ping"), { code: run.code ?? null, killed: run.killed === true }) as ExecFileException) : null;
    setImmediate(() => callback(err, run.stdout ?? "", run.stderr ?? ""));
    return {} as ChildProcess;
  });
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void;

/** Troca o dns.lookup (getaddrinfo) que o net usa: falha de resolução determinística, sem depender do DNS da máquina. */
function stubLookup(answer: (hostname: string, callback: LookupCallback) => void) {
  return vi.spyOn(dns, "lookup").mockImplementation(((hostname: string, _options: unknown, callback: LookupCallback) => answer(hostname, callback)) as never);
}

const lookupFails = (code: string) => (hostname: string, callback: LookupCallback) => {
  setImmediate(() => callback(Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), { code, syscall: "getaddrinfo", hostname })));
};

type DnsMode = "a" | "vazio" | "servfail" | "nxdomain" | "refused" | "mudo";

interface FakeDns {
  /** "127.0.0.1:porta", no formato que o resolvedor aceita. */
  address: string;
  /** Nomes perguntados, na ordem. */
  queries: string[];
}

const dnsSockets: dgram.Socket[] = [];

/** Servidor DNS mínimo em UDP: responde um registro A (93.184.216.34), um código de erro ou nada. */
function startDns(mode: DnsMode): Promise<FakeDns> {
  const rcode = { a: 0, vazio: 0, servfail: 2, nxdomain: 3, refused: 5, mudo: 0 }[mode];
  const socket = dgram.createSocket("udp4");
  const queries: string[] = [];
  dnsSockets.push(socket);
  socket.on("error", ignore);
  socket.on("message", (query, client) => {
    // Pergunta: 12 bytes de cabeçalho, os rótulos do nome até o byte zero, depois tipo e classe (2 bytes cada).
    const labels: string[] = [];
    let end = 12;
    while (end < query.length && query[end] !== 0) {
      labels.push(query.subarray(end + 1, end + 1 + query[end]).toString("ascii"));
      end += query[end] + 1;
    }
    end += 5;
    queries.push(labels.join("."));
    if (mode === "mudo") return;
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2); // mesmo id da pergunta
    header.writeUInt16BE(0x8180 | rcode, 2); // é resposta, com recursão, e o código de retorno
    header.writeUInt16BE(1, 4); // uma pergunta
    header.writeUInt16BE(mode === "a" ? 1 : 0, 6); // respostas
    // Resposta: ponteiro para o nome da pergunta, tipo A, classe IN, TTL de 60 s e os 4 bytes do endereço.
    const answer = mode === "a" ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34]) : Buffer.alloc(0);
    socket.send(Buffer.concat([header, query.subarray(12, end), answer]), client.port, client.address);
  });
  return new Promise((resolve) => socket.bind(0, "127.0.0.1", () => resolve({ address: `127.0.0.1:${socket.address().port}`, queries })));
}

/** Roda a medição e confere que o temporizador do prazo dela (identificado pelo valor do prazo) foi cancelado. */
async function expectTimerReleased(deadline: number, run: () => Promise<ProbeResult>): Promise<ProbeResult> {
  const armed = vi.spyOn(globalThis, "setTimeout");
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  try {
    const result = await run();
    const index = armed.mock.calls.findIndex(([, ms]) => ms === deadline);
    expect(index, `nenhum temporizador de ${deadline} ms foi armado`).toBeGreaterThanOrEqual(0);
    expect(cleared).toHaveBeenCalledWith(armed.mock.results[index].value);
    return result;
  } finally {
    armed.mockRestore();
    cleared.mockRestore();
  }
}

beforeEach(() => {
  seen.length = 0;
  // Sem instrução do teste, o ping "não existe" (como neste ambiente): nenhum teste roda um ping de verdade por acaso.
  mocks.execFile.mockReset();
  mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: PingCallback) => {
    setImmediate(() => callback(Object.assign(new Error("spawn ping ENOENT"), { code: "ENOENT" }) as ExecFileException, "", ""));
    return {} as ChildProcess;
  });
  mocks.readRouteTable.mockReset();
  mocks.readRouteTable.mockResolvedValue([]);
  mocks.getSystemDnsServers.mockReset();
  mocks.getSystemDnsServers.mockResolvedValue([]);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(dnsSockets.splice(0).map((socket) => new Promise<void>((resolve) => socket.close(() => resolve()))));
});

// ---------------------------------------------------------------- ping: funções puras

const IPUTILS_ALL = `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=11.8 ms
64 bytes from 1.1.1.1: icmp_seq=3 ttl=57 time=13.1 ms
64 bytes from 1.1.1.1: icmp_seq=4 ttl=57 time=12.0 ms
64 bytes from 1.1.1.1: icmp_seq=5 ttl=57 time=12.6 ms

--- 1.1.1.1 ping statistics ---
5 packets transmitted, 5 received, 0% packet loss, time 806ms
rtt min/avg/max/mdev = 11.800/12.360/13.100/0.457 ms
`;

const IPUTILS_PARTIAL = `PING 192.168.0.1 (192.168.0.1) 56(84) bytes of data.
64 bytes from 192.168.0.1: icmp_seq=1 ttl=64 time=0.412 ms
64 bytes from 192.168.0.1: icmp_seq=3 ttl=64 time=0.398 ms
64 bytes from 192.168.0.1: icmp_seq=5 ttl=64 time=0.450 ms

--- 192.168.0.1 ping statistics ---
5 packets transmitted, 3 received, 40% packet loss, time 823ms
rtt min/avg/max/mdev = 0.398/0.420/0.450/0.021 ms
`;

const IPUTILS_NONE = `PING 10.255.255.1 (10.255.255.1) 56(84) bytes of data.

--- 10.255.255.1 ping statistics ---
5 packets transmitted, 0 received, 100% packet loss, time 1813ms

`;

const IPUTILS_UNREACHABLE = `PING 192.168.0.50 (192.168.0.50) 56(84) bytes of data.
From 192.168.0.10 icmp_seq=1 Destination Host Unreachable
From 192.168.0.10 icmp_seq=2 Destination Host Unreachable
From 192.168.0.10 icmp_seq=3 Destination Host Unreachable

--- 192.168.0.50 ping statistics ---
5 packets transmitted, 0 received, +3 errors, 100% packet loss, time 4085ms
pipe 4
`;

const IPUTILS_DUP = `PING 192.168.0.255 (192.168.0.255) 56(84) bytes of data.
64 bytes from 192.168.0.1: icmp_seq=1 ttl=64 time=0.5 ms
64 bytes from 192.168.0.7: icmp_seq=1 ttl=64 time=0.9 ms (DUP!)
64 bytes from 192.168.0.1: icmp_seq=2 ttl=64 time=0.6 ms
64 bytes from 192.168.0.1: icmp_seq=3 ttl=64 time=0.5 ms
64 bytes from 192.168.0.1: icmp_seq=4 ttl=64 time=0.7 ms
64 bytes from 192.168.0.1: icmp_seq=5 ttl=64 time=0.5 ms

--- 192.168.0.255 ping statistics ---
5 packets transmitted, 5 received, +1 duplicates, 0% packet loss, time 808ms
rtt min/avg/max/mdev = 0.500/0.616/0.900/0.146 ms
`;

// O ping do Windows separa as linhas com CRLF.
const WINDOWS_PT = [
  "",
  "Disparando 192.168.0.1 com 32 bytes de dados:",
  "Resposta de 192.168.0.1: bytes=32 tempo<1ms TTL=64",
  "Resposta de 192.168.0.1: bytes=32 tempo=1ms TTL=64",
  "Resposta de 192.168.0.1: bytes=32 tempo<1ms TTL=64",
  "Resposta de 192.168.0.1: bytes=32 tempo=3ms TTL=64",
  "Resposta de 192.168.0.1: bytes=32 tempo=1ms TTL=64",
  "",
  "Estatísticas do Ping para 192.168.0.1:",
  "    Pacotes: Enviados = 5, Recebidos = 5, Perdidos = 0 (0% de",
  "             perda),",
  "Aproximar um número redondo de vezes em milissegundos:",
  "    Mínimo = 0ms, Máximo = 3ms, Média = 1ms",
  "",
].join("\r\n");

const WINDOWS_EN = [
  "",
  "Pinging 1.1.1.1 with 32 bytes of data:",
  "Reply from 1.1.1.1: bytes=32 time=14ms TTL=57",
  "Request timed out.",
  "Reply from 1.1.1.1: bytes=32 time=15ms TTL=57",
  "Reply from 1.1.1.1: bytes=32 time=13ms TTL=57",
  "Reply from 1.1.1.1: bytes=32 time=14ms TTL=57",
  "",
  "Ping statistics for 1.1.1.1:",
  "    Packets: Sent = 5, Received = 4, Lost = 1 (20% loss),",
  "Approximate round trip times in milli-seconds:",
  "    Minimum = 13ms, Maximum = 15ms, Average = 14ms",
  "",
].join("\r\n");

// O Windows conta "inacessível" como recebido nas estatísticas; por isso o resumo dele não é lido.
const WINDOWS_UNREACHABLE = [
  "",
  "Disparando 192.168.0.50 com 32 bytes de dados:",
  "Resposta de 192.168.0.10: Host de destino inacessível.",
  "Resposta de 192.168.0.10: Host de destino inacessível.",
  "Resposta de 192.168.0.10: Host de destino inacessível.",
  "Resposta de 10.0.0.1: TTL expirado em trânsito.",
  "Esgotado o tempo limite do pedido.",
  "",
  "Estatísticas do Ping para 192.168.0.50:",
  "    Pacotes: Enviados = 5, Recebidos = 4, Perdidos = 1 (20% de",
  "             perda),",
  "",
].join("\r\n");

describe("parsePingOutput", () => {
  it("lê o iputils com todas as respostas: média, jitter e perda zero", () => {
    const stats = parsePingOutput(IPUTILS_ALL, 5);
    expect(stats.received).toBe(5);
    expect(stats.rtts).toEqual([12.3, 11.8, 13.1, 12.0, 12.6]);
    expect(stats.lossPct).toBe(0);
    expect(stats.avgMs).toBeCloseTo(12.36, 6);
    // média de |11,8−12,3|, |13,1−11,8|, |12,0−13,1| e |12,6−12,0|
    expect(stats.jitterMs).toBeCloseTo(0.875, 6);
  });

  it("calcula a perda parcial sobre os pacotes enviados", () => {
    const stats = parsePingOutput(IPUTILS_PARTIAL, 5);
    expect(stats.received).toBe(3);
    expect(stats.rtts).toEqual([0.412, 0.398, 0.45]);
    expect(stats.lossPct).toBe(40);
    expect(stats.avgMs).toBeCloseTo(0.42, 6);
    expect(stats.jitterMs).toBeCloseTo(0.033, 6);
  });

  it("perda total: nenhuma resposta, sem média e sem jitter", () => {
    for (const output of [IPUTILS_NONE, IPUTILS_UNREACHABLE, ""]) {
      expect(parsePingOutput(output, 5)).toEqual({ received: 0, rtts: [], lossPct: 100, avgMs: null, jitterMs: null });
    }
  });

  it("uma resposta duplicada (DUP!) não faz o recebido passar do enviado", () => {
    const stats = parsePingOutput(IPUTILS_DUP, 5);
    expect(stats.received).toBe(5);
    expect(stats.rtts).toHaveLength(5);
    expect(stats.lossPct).toBe(0);
  });

  it("lê o Windows em português, contando tempo<1ms como 0,5 ms", () => {
    const stats = parsePingOutput(WINDOWS_PT, 5);
    expect(stats.received).toBe(5);
    expect(stats.rtts).toEqual([0.5, 1, 0.5, 3, 1]);
    expect(stats.lossPct).toBe(0);
    expect(stats.avgMs).toBeCloseTo(1.2, 6);
    expect(stats.jitterMs).toBeCloseTo(1.375, 6);
  });

  it("lê o Windows em inglês com um pedido sem resposta", () => {
    const stats = parsePingOutput(WINDOWS_EN, 5);
    expect(stats.received).toBe(4);
    expect(stats.rtts).toEqual([14, 15, 13, 14]);
    expect(stats.lossPct).toBe(20);
    expect(stats.avgMs).toBe(14);
    expect(stats.jitterMs).toBeCloseTo(4 / 3, 6);
  });

  it("\"Host de destino inacessível\" e \"TTL expirado\" não são resposta", () => {
    expect(parsePingOutput(WINDOWS_UNREACHABLE, 5)).toEqual({ received: 0, rtts: [], lossPct: 100, avgMs: null, jitterMs: null });
  });

  it("aceita vírgula como separador decimal (ping traduzido)", () => {
    const stats = parsePingOutput("64 bytes de 1.1.1.1: icmp_seq=1 ttl=57 tempo=12,3 ms\n64 bytes de 1.1.1.1: icmp_seq=2 ttl=57 tempo=0,45 ms\n", 2);
    expect(stats.rtts).toEqual([12.3, 0.45]);
  });

  it("uma resposta sem tempo conta como recebida, mas não entra na média", () => {
    const stats = parsePingOutput("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57\n64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=8.0 ms\n", 2);
    expect(stats).toEqual({ received: 2, rtts: [8], lossPct: 0, avgMs: 8, jitterMs: null });
  });

  it("sem pacotes enviados não divide por zero", () => {
    expect(parsePingOutput(IPUTILS_ALL, 0)).toEqual({ received: 0, rtts: [], lossPct: 100, avgMs: null, jitterMs: null });
    expect(parsePingOutput(IPUTILS_ALL, Number.NaN).lossPct).toBe(100);
  });
});

describe("pingArgs", () => {
  it("Windows: contagem em -n e espera em milissegundos", () => {
    expect(pingArgs("1.1.1.1", 5, "win32")).toEqual(["-n", "5", "-w", "1000", "-4", "1.1.1.1"]);
  });

  it("Linux: 5 pacotes a cada 0,2 s, 1 s de espera, sem resolver nomes", () => {
    expect(pingArgs("1.1.1.1", 5, "linux")).toEqual(["-n", "-c", "5", "-i", "0.2", "-W", "1", "-4", "1.1.1.1"]);
    expect(pingArgs("gateway.lan", 3, "linux")).toEqual(["-n", "-c", "3", "-i", "0.2", "-W", "1", "-4", "gateway.lan"]);
  });

  it("Linux: IPv6 literal usa -6", () => {
    expect(pingArgs("2606:4700:4700::1111", 5, "linux")).toEqual(["-n", "-c", "5", "-i", "0.2", "-W", "1", "-6", "2606:4700:4700::1111"]);
  });

  it("macOS e BSD: -W em milissegundos e sem intervalo abaixo de 1 s", () => {
    for (const platform of ["darwin", "freebsd", "openbsd"] as const) {
      expect(pingArgs("1.1.1.1", 5, platform)).toEqual(["-n", "-c", "5", "-W", "1000", "1.1.1.1"]);
    }
  });
});

describe("isPingUnavailable", () => {
  it("sem binário ou sem permissão para executá-lo", () => {
    expect(isPingUnavailable("ENOENT", "")).toBe(true);
    expect(isPingUnavailable("EACCES", "")).toBe(true);
    expect(isPingUnavailable("EPERM", "")).toBe(true);
  });

  it("sem permissão para abrir o socket ICMP, pelo que o ping escreve no stderr", () => {
    expect(isPingUnavailable(2, "ping: socket: Operation not permitted\n")).toBe(true);
    expect(isPingUnavailable(2, "ping: socktype: SOCK_RAW\nping: socket: Permission denied\n")).toBe(true);
    expect(isPingUnavailable(1, "ping: permission denied (are you root?)\n")).toBe(true);
  });

  it("perda total, host desconhecido e processo morto no prazo não são \"indisponível\"", () => {
    expect(isPingUnavailable(1, "")).toBe(false);
    expect(isPingUnavailable(2, "ping: exemplo.invalid: Name or service not known\n")).toBe(false);
    expect(isPingUnavailable(null, "")).toBe(false);
    expect(isPingUnavailable(undefined, "")).toBe(false);
  });
});

// ---------------------------------------------------------------- ping: probeIcmp

describe("probeIcmp", () => {
  it.each(["-c 9999", "-c", "-f", "1.1.1.1 -f", "exemplo.com; reboot", "a b", "$(reboot)", "", "x".repeat(254)])("recusa %j sem iniciar processo", async (host) => {
    expect(await probeIcmp(host)).toEqual({ ok: false, latencyMs: null, error: "endereço inválido para ping" });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("recusa host que não é texto", async () => {
    expect(await probeIcmp(undefined as never)).toEqual({ ok: false, latencyMs: null, error: "endereço inválido para ping" });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("chama o ping do sistema com os argumentos da plataforma, em locale C e com prazo", async () => {
    nextPing({ stdout: IPUTILS_ALL });
    await probeIcmp("1.1.1.1");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = mocks.execFile.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv; timeout: number; killSignal: string }];
    expect(file).toBe("ping");
    expect(args).toEqual(pingArgs("1.1.1.1", 5, process.platform));
    expect(options.env).toMatchObject({ LC_ALL: "C", LANG: "C" });
    // O restante do ambiente é mantido: sem PATH o binário não seria encontrado.
    expect(Object.keys(options.env).length).toBeGreaterThan(2);
    expect(options.timeout).toBe(10_000);
    expect(options.killSignal).toBe("SIGKILL");
  });

  it("respeita a contagem e o prazo pedidos; contagem sem sentido volta para 5", async () => {
    nextPing({ stdout: IPUTILS_ALL });
    await probeIcmp("1.1.1.1", { count: 3, timeoutMs: 2500 });
    expect(mocks.execFile.mock.calls[0][1]).toEqual(pingArgs("1.1.1.1", 3, process.platform));
    expect((mocks.execFile.mock.calls[0][2] as { timeout: number }).timeout).toBe(2500);

    for (const count of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      nextPing({ stdout: IPUTILS_ALL });
      await probeIcmp("1.1.1.1", { count });
      expect(mocks.execFile.mock.calls.at(-1)![1]).toEqual(pingArgs("1.1.1.1", 5, process.platform));
    }
  });

  it("todas as respostas: latência é o RTT médio, com perda e jitter", async () => {
    nextPing({ stdout: IPUTILS_ALL });
    expect(await probeIcmp("1.1.1.1")).toEqual({ ok: true, latencyMs: 12.36, lossPct: 0, jitterMs: 0.875 });
  });

  it("perda parcial continua no ar, mesmo com código de saída diferente de zero", async () => {
    nextPing({ code: 1, stdout: IPUTILS_PARTIAL });
    expect(await probeIcmp("192.168.0.1")).toEqual({ ok: true, latencyMs: 0.42, lossPct: 40, jitterMs: 0.033 });
  });

  it("perda total: falha na etapa connect (o ping sai com código 1)", async () => {
    nextPing({ code: 1, stdout: IPUTILS_NONE });
    expect(await probeIcmp("10.255.255.1")).toEqual({ ok: false, latencyMs: null, lossPct: 100, jitterMs: null, error: "sem resposta ao ping", failedAt: "connect" });
  });

  it("Windows responde \"inacessível\" com código 0: continua sendo falha", async () => {
    nextPing({ stdout: WINDOWS_UNREACHABLE });
    expect(await probeIcmp("192.168.0.50")).toMatchObject({ ok: false, error: "sem resposta ao ping", failedAt: "connect", lossPct: 100 });
  });

  it("morto no prazo: aproveita as respostas que já tinham chegado", async () => {
    nextPing({ killed: true, stdout: IPUTILS_ALL.split("\n").slice(0, 3).join("\n") });
    expect(await probeIcmp("1.1.1.1")).toMatchObject({ ok: true, lossPct: 60, latencyMs: 12.05 });

    nextPing({ killed: true, stdout: "" });
    expect(await probeIcmp("1.1.1.1")).toMatchObject({ ok: false, error: "sem resposta ao ping", failedAt: "connect" });
  });

  it("sem binário de ping: não suportado, e não falha", async () => {
    nextPing({ code: "ENOENT" });
    expect(await probeIcmp("1.1.1.1")).toEqual({ ok: false, latencyMs: null, unsupported: true, error: "ping indisponível neste servidor" });
  });

  it("sem permissão para abrir o socket ICMP: não suportado", async () => {
    nextPing({ code: 2, stderr: "ping: socket: Operation not permitted\n" });
    expect(await probeIcmp("1.1.1.1")).toEqual({ ok: false, latencyMs: null, unsupported: true, error: "ping indisponível neste servidor" });
  });

  it("se o execFile lançar na hora, vira não suportado em vez de exceção", async () => {
    mocks.execFile.mockImplementationOnce(() => {
      throw new TypeError("argumentos inválidos");
    });
    expect(await probeIcmp("1.1.1.1")).toEqual({ ok: false, latencyMs: null, unsupported: true, error: "ping indisponível neste servidor" });
  });

  it("com o ping de verdade da máquina (quando existe) devolve um resultado coerente", async () => {
    mocks.execFile.mockImplementationOnce(realChildProcess.execFile as never);
    const result = await probeIcmp("127.0.0.1", { count: 1, timeoutMs: 4000 });
    if (result.unsupported) {
      expect(result).toEqual({ ok: false, latencyMs: null, unsupported: true, error: "ping indisponível neste servidor" });
    } else if (result.ok) {
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.lossPct).toBe(0);
    } else {
      expect(result).toMatchObject({ latencyMs: null, error: "sem resposta ao ping", failedAt: "connect" });
    }
  }, 15_000);
});

// ---------------------------------------------------------------- gateway padrão

describe("parseProcNetRoute", () => {
  const header = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT";

  it("lê o gateway da rota padrão, em hexadecimal little-endian", () => {
    const text = [header, "eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0", "eth0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0", ""].join("\n");
    expect(parseProcNetRoute(text)).toBe("192.168.0.1");
  });

  it("escolhe a rota padrão de menor métrica", () => {
    const text = [header, "wlan0\t00000000\tFE00A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0", "eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0"].join("\n");
    expect(parseProcNetRoute(text)).toBe("192.168.0.1");
  });

  it("ignora rota sem gateway (flag 0x2), gateway zerado e destino que não é o padrão", () => {
    const text = [
      header,
      "tun0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0", // padrão direto na interface, sem próximo salto
      "tun1\t00000000\t00000000\t0003\t0\t0\t0\t00000000\t0\t0\t0", // flag de gateway, mas endereço zerado
      "tun2\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000080\t0\t0\t0", // 0.0.0.0/1 (VPN), não é a rota padrão
      "eth0\t0000000A\t0100A8C0\t0003\t0\t0\t0\t000000FF\t0\t0\t0", // 10.0.0.0/8 via gateway
    ].join("\n");
    expect(parseProcNetRoute(text)).toBeNull();
  });

  it("devolve null sem rota padrão, com texto vazio ou com lixo", () => {
    expect(parseProcNetRoute(header)).toBeNull();
    expect(parseProcNetRoute("")).toBeNull();
    expect(parseProcNetRoute("qualquer coisa\n\n\t\t\n00000000")).toBeNull();
  });

  it("em máquina big-endian os octetos já vêm na ordem", () => {
    expect(parseProcNetRoute(`${header}\neth0\t00000000\tC0A80001\t0003\t0\t0\t0\t00000000\t0\t0\t0\n`, "BE")).toBe("192.168.0.1");
  });
});

describe("defaultGateway", () => {
  const route = (destination: string, nextHop: string, metric: number | null) => ({ destination, nextHop, interface: "eth0", metric, protocol: "dhcp" });
  // Cada teste começa um dia depois do anterior: o cache do módulo (5 min) nunca vaza de um teste para outro.
  let clock = Date.UTC(2031, 0, 1);

  beforeEach(() => {
    clock += 24 * 60 * 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
  });

  it("usa a rota padrão de menor métrica com um próximo salto de verdade", async () => {
    mocks.readRouteTable.mockResolvedValue([
      route("0.0.0.0/0", "192.168.0.254", 600),
      route("0.0.0.0/0", "192.168.0.1", 100),
      route("0.0.0.0/0", "0.0.0.0", 5), // rota "on-link" do Windows
      route("0.0.0.0/0", "fe80::1", 1),
      route("10.0.0.0/8", "192.168.0.77", 1),
      route("192.168.0.0/24", "0.0.0.0", 100),
    ]);
    expect(await defaultGateway()).toBe("192.168.0.1");
  });

  it("métrica ausente conta como zero", async () => {
    mocks.readRouteTable.mockResolvedValue([route("0.0.0.0/0", "192.168.0.254", 50), route("0.0.0.0/0", "192.168.0.1", null)]);
    expect(await defaultGateway()).toBe("192.168.0.1");
  });

  it("guarda o gateway encontrado por 5 min", async () => {
    mocks.readRouteTable.mockResolvedValue([route("0.0.0.0/0", "192.168.0.1", 100)]);
    expect(await defaultGateway()).toBe("192.168.0.1");
    mocks.readRouteTable.mockResolvedValue([route("0.0.0.0/0", "10.0.0.1", 100)]);

    vi.setSystemTime(clock + 5 * 60_000 - 1);
    expect(await defaultGateway()).toBe("192.168.0.1");
    expect(mocks.readRouteTable).toHaveBeenCalledTimes(1);

    vi.setSystemTime(clock + 5 * 60_000);
    expect(await defaultGateway()).toBe("10.0.0.1");
    expect(mocks.readRouteTable).toHaveBeenCalledTimes(2);
  });

  it("guarda o \"não encontrado\" só por 1 min", async () => {
    expect(await defaultGateway()).toBeNull();
    mocks.readRouteTable.mockResolvedValue([route("0.0.0.0/0", "192.168.0.1", 100)]);

    vi.setSystemTime(clock + 60_000 - 1);
    expect(await defaultGateway()).toBeNull();
    expect(mocks.readRouteTable).toHaveBeenCalledTimes(1);

    vi.setSystemTime(clock + 60_000);
    expect(await defaultGateway()).toBe("192.168.0.1");
  });

  it("chamadas simultâneas dividem uma única leitura da tabela de rotas", async () => {
    mocks.readRouteTable.mockImplementation(async () => {
      await sleep(20);
      return [route("0.0.0.0/0", "192.168.0.1", 100)];
    });
    expect(await Promise.all([defaultGateway(), defaultGateway(), defaultGateway()])).toEqual(["192.168.0.1", "192.168.0.1", "192.168.0.1"]);
    expect(mocks.readRouteTable).toHaveBeenCalledTimes(1);
  });

  it("refaz a busca se o relógio do sistema voltar para antes do cache", async () => {
    mocks.readRouteTable.mockResolvedValue([route("0.0.0.0/0", "192.168.0.1", 100)]);
    expect(await defaultGateway()).toBe("192.168.0.1");
    mocks.readRouteTable.mockResolvedValue([route("0.0.0.0/0", "10.0.0.1", 100)]);
    vi.setSystemTime(clock - 60 * 60_000);
    expect(await defaultGateway()).toBe("10.0.0.1");
    // O cache ficou datado de uma hora atrás; o próximo teste começa um dia depois e não o enxerga.
  });

  it("sem o binário ip, lê /proc/net/route no Linux; nos outros sistemas devolve null", async () => {
    mocks.readRouteTable.mockRejectedValue(Object.assign(new Error("spawn ip ENOENT"), { code: "ENOENT" }));
    let expected: string | null = null;
    if (process.platform === "linux") {
      try {
        expected = parseProcNetRoute(readFileSync("/proc/net/route", "utf8"), endianness());
      } catch {
        expected = null;
      }
    }
    expect(await defaultGateway()).toBe(expected);
  });

  it("nunca rejeita, nem com uma tabela de rotas sem sentido", async () => {
    mocks.readRouteTable.mockResolvedValue("isto não é uma lista" as never);
    await expect(defaultGateway()).resolves.toSatisfy((value) => value === null || typeof value === "string");
  });
});

// ---------------------------------------------------------------- HTTP

describe("probeHttp", () => {
  it("o prazo padrão é de 10 s", () => {
    expect(PROBE_TIMEOUT_MS).toBe(10_000);
  });

  it("200: no ar, com as parcelas de tempo e sem resolução de nome para IP literal", async () => {
    const result = await probeHttp(`${webUrl}/ok`);
    expect(result).toMatchObject({ ok: true, httpStatus: 200, dnsMs: null, tlsMs: null, certDays: null });
    expect(result.error).toBeUndefined();
    expect(result.failedAt).toBeUndefined();
    expectDuration(result.connectMs);
    expectDuration(result.ttfbMs);
    expectDuration(result.totalMs);
    expect(result.latencyMs).toBe(result.totalMs);
    // Sem DNS e sem TLS, o total é conexão + espera do servidor (a diferença é só o arredondamento).
    expect(Math.abs(result.connectMs! + result.ttfbMs! - result.totalMs!)).toBeLessThan(0.21);
  });

  it("manda um GET com o user-agent da sonda, numa conexão nova que não é reaproveitada", async () => {
    await probeHttp(`${webUrl}/ok?origem=teste`);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("/ok?origem=teste");
    expect(seen[0].headers["user-agent"]).toBe(USER_AGENT);
    expect(seen[0].headers.accept).toBe("*/*");
    expect(seen[0].headers.connection).toBe("close");
    expect(seen[0].headers.host).toBe(`127.0.0.1:${web.port}`);
  });

  it("mede a resolução do nome quando o host não é um IP", async () => {
    const result = await probeHttp(`http://localhost:${web.port}/ok`);
    expect(result.ok).toBe(true);
    expectDuration(result.dnsMs);
    expectDuration(result.connectMs);
  });

  it("404 é uma resposta: no ar", async () => {
    expect(await probeHttp(`${webUrl}/nao-existe`)).toMatchObject({ ok: true, httpStatus: 404 });
  });

  it("503: fora, na etapa http, mantendo o status e as parcelas", async () => {
    const result = await probeHttp(`${webUrl}/fora`);
    expect(result).toMatchObject({ ok: false, latencyMs: null, httpStatus: 503, error: "HTTP 503", failedAt: "http", dnsMs: null, tlsMs: null });
    expectDuration(result.connectMs);
    expectDuration(result.ttfbMs);
    expectDuration(result.totalMs);
  });

  it("302 não é seguido", async () => {
    expect(await probeHttp(`${webUrl}/redireciona`)).toMatchObject({ ok: true, httpStatus: 302 });
    expect(seen.map((request) => request.url)).toEqual(["/redireciona"]);
  });

  it("não lê o corpo: termina nos cabeçalhos e fecha a conexão", async () => {
    const started = performance.now();
    expect(await probeHttp(`${webUrl}/corpo-sem-fim`)).toMatchObject({ ok: true, httpStatus: 200 });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(await waitFor(() => web.sockets.size === 0)).toBe(true);
  });

  it("servidor que nunca responde: prazo na etapa http, e o socket é fechado", async () => {
    const started = performance.now();
    const result = await expectTimerReleased(300, () => probeHttp(`${webUrl}/mudo`, { timeoutMs: 300 }));
    const elapsed = performance.now() - started;
    expect(result).toEqual({ ok: false, latencyMs: null, error: "tempo esgotado aguardando a resposta", failedAt: "http" });
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(3000);
    expect(await waitFor(() => web.sockets.size === 0)).toBe(true);
  });

  it("uma resposta que chega depois do prazo não muda o resultado nem gera erro solto", async () => {
    const result = await probeHttp(`${webUrl}/lento`, { timeoutMs: 120 });
    expect(result).toEqual({ ok: false, latencyMs: null, error: "tempo esgotado aguardando a resposta", failedAt: "http" });
    // Passa do momento em que o servidor responderia: um "error" sem ouvinte derrubaria o teste aqui.
    await sleep(450);
    expect(web.sockets.size).toBe(0);
  });

  it("porta fechada: conexão recusada na etapa connect", async () => {
    const port = await reserveClosedPort();
    const result = await expectTimerReleased(5000, () => probeHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 5000 }));
    expect(result).toEqual({ ok: false, latencyMs: null, error: "conexão recusada", failedAt: "connect" });
  }, 15_000);

  it("nome sob .invalid: falha na etapa dns, por erro ou por prazo", async () => {
    const result = await probeHttp("http://nao-existe.netinventory.invalid/", { timeoutMs: 1500 });
    expect(result).toMatchObject({ ok: false, latencyMs: null, failedAt: "dns" });
    expect(["nome não encontrado no DNS", "o DNS não respondeu", "tempo esgotado na resolução do nome"]).toContain(result.error);
  }, 15_000);

  it("nome que o DNS não conhece (ENOTFOUND): etapa dns", async () => {
    stubLookup(lookupFails("ENOTFOUND"));
    expect(await probeHttp("https://servico.exemplo/")).toEqual({ ok: false, latencyMs: null, error: "nome não encontrado no DNS", failedAt: "dns" });
  });

  it("DNS do servidor fora (EAI_AGAIN): etapa dns", async () => {
    stubLookup(lookupFails("EAI_AGAIN"));
    expect(await probeHttp("http://servico.exemplo/")).toEqual({ ok: false, latencyMs: null, error: "o DNS não respondeu", failedAt: "dns" });
  });

  it("resolução que não volta: prazo na etapa dns; a resposta atrasada do DNS é ignorada", async () => {
    let answerLate: (() => void) | null = null;
    stubLookup((_hostname, callback) => {
      answerLate = () => callback(null, "127.0.0.1", 4);
    });
    const result = await expectTimerReleased(150, () => probeHttp(`http://servico.exemplo:${web.port}/ok`, { timeoutMs: 150 }));
    expect(result).toEqual({ ok: false, latencyMs: null, error: "tempo esgotado na resolução do nome", failedAt: "dns" });
    // O getaddrinfo não pode ser cancelado: ele responde com o socket já destruído, e nada pode acontecer.
    expect(answerLate).not.toBeNull();
    answerLate!();
    await sleep(100);
    expect(seen).toHaveLength(0);
  });

  it.each(["", "nada", "//sem-esquema/", "http://", "ftp://exemplo.com/arquivo", "mailto:alguem@exemplo.com", "http://exemplo.com:99999/", "https://exemplo com/"])("URL inválida (%j): falha sem abrir socket", async (url) => {
    const plain = vi.spyOn(http, "request");
    const encrypted = vi.spyOn(https, "request");
    expect(await probeHttp(url)).toEqual({ ok: false, latencyMs: null, error: "URL inválida", failedAt: null });
    expect(plain).not.toHaveBeenCalled();
    expect(encrypted).not.toHaveBeenCalled();
  });

  it("URL que não é texto também é inválida", async () => {
    expect(await probeHttp(undefined as never)).toEqual({ ok: false, latencyMs: null, error: "URL inválida", failedAt: null });
  });

  it("servidor que fecha a conexão sem responder: encerrada na etapa http", async () => {
    expect(await probeHttp(`http://127.0.0.1:${hangup.port}/`)).toEqual({ ok: false, latencyMs: null, error: "conexão encerrada pelo servidor", failedAt: "http" });
  });

  it("servidor que derruba a conexão com RST: encerrada, na etapa em que o RST chegou", async () => {
    const result = await probeHttp(`http://127.0.0.1:${reset.port}/`);
    expect(result).toMatchObject({ ok: false, latencyMs: null, error: "conexão encerrada pelo servidor" });
    // Em loopback o RST pode chegar antes de o cliente processar o fim do handshake TCP.
    expect(["connect", "http"]).toContain(result.failedAt);
  });

  it("resposta que não é HTTP: falha na etapa http com o código do erro", async () => {
    const result = await probeHttp(`http://127.0.0.1:${junk.port}/`);
    expect(result).toMatchObject({ ok: false, latencyMs: null, failedAt: "http" });
    expect(result.error).toMatch(/^HPE_/);
  });

  it("https contra um servidor que não fala TLS: falha na etapa tls", async () => {
    const result = await probeHttp(`https://127.0.0.1:${web.port}/ok`);
    expect(result).toMatchObject({ ok: false, latencyMs: null, failedAt: "tls" });
    expect(["falha no handshake TLS", "conexão encerrada pelo servidor"]).toContain(result.error);
  });

  it("handshake TLS que não termina: prazo na etapa tls, e o socket é fechado", async () => {
    const result = await expectTimerReleased(300, () => probeHttp(`https://127.0.0.1:${mute.port}/`, { timeoutMs: 300 }));
    expect(result).toEqual({ ok: false, latencyMs: null, error: "tempo esgotado no handshake TLS", failedAt: "tls" });
    expect(await waitFor(() => mute.sockets.size === 0)).toBe(true);
  });

  it("prazo sem sentido volta para o padrão em vez de estourar na hora", async () => {
    for (const timeoutMs of [0, -1, Number.NaN]) {
      expect(await probeHttp(`${webUrl}/ok`, { timeoutMs })).toMatchObject({ ok: true, httpStatus: 200 });
    }
  });

  it("cancela o temporizador do prazo ao terminar bem", async () => {
    expect(await expectTimerReleased(PROBE_TIMEOUT_MS, () => probeHttp(`${webUrl}/ok`))).toMatchObject({ ok: true });
    expect(await expectTimerReleased(4321, () => probeHttp(`${webUrl}/fora`, { timeoutMs: 4321 }))).toMatchObject({ ok: false, httpStatus: 503 });
  });

  it("não deixa temporizador nem socket abertos depois de várias medições", async () => {
    if (typeof process.getActiveResourcesInfo !== "function") return;
    const count = (kind: string) => process.getActiveResourcesInfo().filter((name) => name === kind).length;
    await probeHttp(`${webUrl}/ok`);
    await waitFor(() => web.sockets.size === 0);
    const before = { timers: count("Timeout"), sockets: count("TCPSocketWrap") };

    const closed = await reserveClosedPort();
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => probeHttp(`${webUrl}/ok`)),
      ...Array.from({ length: 3 }, () => probeHttp(`${webUrl}/fora`)),
      ...Array.from({ length: 3 }, () => probeHttp(`${webUrl}/mudo`, { timeoutMs: 200 })),
      ...Array.from({ length: 3 }, () => probeTcp("127.0.0.1", web.port)),
      ...Array.from({ length: 2 }, () => probeTls("127.0.0.1", mute.port, { timeoutMs: 200 })),
      probeHttp(`http://127.0.0.1:${closed}/`, { timeoutMs: 5000 }),
    ]);
    expect(results).toHaveLength(18);

    // Com temporizador esquecido sobrariam os 18 prazos (de até 10 s) aqui; com socket esquecido, as conexões.
    expect(await waitFor(() => count("Timeout") <= before.timers && count("TCPSocketWrap") <= before.sockets, 3000)).toBe(true);
    expect(web.sockets.size).toBe(0);
    expect(mute.sockets.size).toBe(0);
  }, 15_000);
});

// ---------------------------------------------------------------- TCP

describe("probeTcp", () => {
  it("porta aberta: a latência é o handshake, e a conexão é fechada em seguida", async () => {
    const result = await probeTcp("127.0.0.1", web.port);
    expect(Object.keys(result).sort()).toEqual(["connectMs", "dnsMs", "latencyMs", "ok"]);
    expect(result.ok).toBe(true);
    expect(result.dnsMs).toBeNull();
    expectDuration(result.connectMs);
    expect(result.latencyMs).toBe(result.connectMs);
    expect(await waitFor(() => web.sockets.size === 0)).toBe(true);
    // Só o handshake: nenhum pedido HTTP chegou ao servidor.
    expect(seen).toHaveLength(0);
  });

  it("mede a resolução do nome quando o host não é um IP", async () => {
    const result = await probeTcp("localhost", web.port);
    expect(result.ok).toBe(true);
    expectDuration(result.dnsMs);
    expectDuration(result.connectMs);
    expect(result.latencyMs).toBe(result.connectMs);
  });

  it("conecta em IPv4 (family: 4)", async () => {
    const connect = vi.spyOn(net, "connect");
    await probeTcp("127.0.0.1", web.port);
    expect(connect).toHaveBeenCalledWith({ host: "127.0.0.1", port: web.port, family: 4 });
  });

  it("porta fechada: conexão recusada na etapa connect", async () => {
    const port = await reserveClosedPort();
    const result = await expectTimerReleased(5000, () => probeTcp("127.0.0.1", port, { timeoutMs: 5000 }));
    expect(result).toEqual({ ok: false, latencyMs: null, error: "conexão recusada", failedAt: "connect" });
  }, 15_000);

  it("destino que não responde: falha na etapa connect", async () => {
    // 192.0.2.0/24 (TEST-NET-1) é reservado para documentação: conforme a rede, o SYN some (prazo) ou não há rota.
    const started = performance.now();
    const result = await probeTcp("192.0.2.55", 9, { timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, latencyMs: null, failedAt: "connect" });
    if (result.error === "tempo esgotado ao conectar") expect(performance.now() - started).toBeGreaterThanOrEqual(280);
    else expect(["sem rota até o destino", "conexão recusada"]).toContain(result.error);
  });

  it("falha de DNS: etapa dns, com a frase de cada erro", async () => {
    stubLookup(lookupFails("ENOTFOUND"));
    expect(await probeTcp("servico.exemplo", 443)).toEqual({ ok: false, latencyMs: null, error: "nome não encontrado no DNS", failedAt: "dns" });
    stubLookup(lookupFails("EAI_AGAIN"));
    expect(await probeTcp("servico.exemplo", 443)).toEqual({ ok: false, latencyMs: null, error: "o DNS não respondeu", failedAt: "dns" });
  });

  it("resolução que não volta: prazo na etapa dns", async () => {
    stubLookup(() => undefined);
    const result = await expectTimerReleased(150, () => probeTcp("servico.exemplo", 443, { timeoutMs: 150 }));
    expect(result).toEqual({ ok: false, latencyMs: null, error: "tempo esgotado na resolução do nome", failedAt: "dns" });
  });

  it("o prazo padrão é de 5 s e é cancelado ao conectar", async () => {
    expect(await expectTimerReleased(5000, () => probeTcp("127.0.0.1", web.port))).toMatchObject({ ok: true });
  });

  it.each([
    ["", 443],
    ["127.0.0.1", 0],
    ["127.0.0.1", -1],
    ["127.0.0.1", 70_000],
    ["127.0.0.1", 443.5],
    ["127.0.0.1", Number.NaN],
    [undefined, 443],
    ["127.0.0.1", "443"],
  ])("host ou porta inválidos (%j, %j): falha sem abrir socket", async (host, port) => {
    const connect = vi.spyOn(net, "connect");
    expect(await probeTcp(host as never, port as never)).toEqual({ ok: false, latencyMs: null, error: "host ou porta inválidos", failedAt: null });
    expect(connect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- TLS sem certificado (não precisa de openssl)

describe("probeTls: falhas", () => {
  it("handshake que não termina: prazo na etapa tls, e o socket é fechado", async () => {
    const result = await expectTimerReleased(300, () => probeTls("127.0.0.1", mute.port, { timeoutMs: 300 }));
    expect(result).toEqual({ ok: false, latencyMs: null, error: "tempo esgotado no handshake TLS", failedAt: "tls" });
    expect(await waitFor(() => mute.sockets.size === 0)).toBe(true);
  });

  it("servidor que não fala TLS: falha na etapa tls", async () => {
    const result = await probeTls("127.0.0.1", web.port);
    expect(result).toMatchObject({ ok: false, latencyMs: null, failedAt: "tls" });
    expect(["falha no handshake TLS", "conexão encerrada pelo servidor"]).toContain(result.error);
  });

  it("servidor que fecha no meio do handshake: encerrada na etapa tls", async () => {
    expect(await probeTls("127.0.0.1", hangup.port)).toEqual({ ok: false, latencyMs: null, error: "conexão encerrada pelo servidor", failedAt: "tls" });
  });

  it("servidor que derruba a conexão com RST: encerrada, na etapa em que o RST chegou", async () => {
    const result = await probeTls("127.0.0.1", reset.port);
    expect(result).toMatchObject({ ok: false, latencyMs: null, error: "conexão encerrada pelo servidor" });
    // Em loopback o RST pode chegar antes de o cliente processar o fim do handshake TCP.
    expect(["connect", "tls"]).toContain(result.failedAt);
  });

  it("porta fechada: conexão recusada na etapa connect", async () => {
    const port = await reserveClosedPort();
    expect(await probeTls("127.0.0.1", port, { timeoutMs: 5000 })).toEqual({ ok: false, latencyMs: null, error: "conexão recusada", failedAt: "connect" });
  }, 15_000);

  it("falha de DNS: etapa dns", async () => {
    stubLookup(lookupFails("ENOTFOUND"));
    expect(await probeTls("servico.exemplo")).toEqual({ ok: false, latencyMs: null, error: "nome não encontrado no DNS", failedAt: "dns" });
  });

  it("manda o SNI só quando o host é um nome, em IPv4 e sem exigir cadeia confiável", async () => {
    stubLookup(lookupFails("ENOTFOUND"));
    const connect = vi.spyOn(tls, "connect");
    await probeTls("servico.exemplo");
    expect(connect).toHaveBeenLastCalledWith({ host: "servico.exemplo", port: 443, family: 4, rejectUnauthorized: false, servername: "servico.exemplo" });
    await probeTls("127.0.0.1", mute.port, { timeoutMs: 50 });
    expect(connect).toHaveBeenLastCalledWith({ host: "127.0.0.1", port: mute.port, family: 4, rejectUnauthorized: false });
  });

  it("host ou porta inválidos: falha sem abrir socket", async () => {
    const connect = vi.spyOn(tls, "connect");
    expect(await probeTls("", 443)).toEqual({ ok: false, latencyMs: null, error: "host ou porta inválidos", failedAt: null });
    expect(await probeTls("127.0.0.1", 70_000)).toEqual({ ok: false, latencyMs: null, error: "host ou porta inválidos", failedAt: null });
    expect(connect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- HTTPS e TLS com certificado autoassinado

describe.skipIf(!certificate)("HTTPS e TLS com certificado autoassinado (precisa de openssl)", () => {
  const port = () => secure!.port;

  it("probeHttp: no ar apesar do certificado não confiável, com tempo de TLS e validade do certificado", async () => {
    const result = await probeHttp(`https://localhost:${port()}/ok`);
    expect(result).toMatchObject({ ok: true, httpStatus: 200 });
    expect([29, 30]).toContain(result.certDays);
    expectDuration(result.dnsMs);
    expectDuration(result.connectMs);
    expectDuration(result.tlsMs);
    expectDuration(result.ttfbMs);
    expectDuration(result.totalMs);
    expect(result.latencyMs).toBe(result.totalMs);
    // DNS + TCP + TLS + espera do servidor fecham o total (a diferença é só o arredondamento de cada parcela).
    expect(Math.abs(result.dnsMs! + result.connectMs! + result.tlsMs! + result.ttfbMs! - result.totalMs!)).toBeLessThan(0.41);
    expect(seen[0].headers["user-agent"]).toBe(USER_AGENT);
  });

  it("probeHttp por IP literal: sem resolução de nome", async () => {
    const result = await probeHttp(`https://127.0.0.1:${port()}/ok`);
    expect(result).toMatchObject({ ok: true, httpStatus: 200, dnsMs: null });
    expectDuration(result.tlsMs);
  });

  it("probeHttp 503 por HTTPS mantém as parcelas e o certificado", async () => {
    const result = await probeHttp(`https://localhost:${port()}/fora`);
    expect(result).toMatchObject({ ok: false, latencyMs: null, httpStatus: 503, error: "HTTP 503", failedAt: "http" });
    expect([29, 30]).toContain(result.certDays);
    expectDuration(result.tlsMs);
  });

  it("probeHttp: resposta que não chega depois do handshake é prazo na etapa http", async () => {
    expect(await probeHttp(`https://localhost:${port()}/mudo`, { timeoutMs: 400 })).toEqual({ ok: false, latencyMs: null, error: "tempo esgotado aguardando a resposta", failedAt: "http" });
    expect(await waitFor(() => secure!.sockets.size === 0)).toBe(true);
  });

  it("probeTls: a latência é o handshake TLS, com a validade do certificado", async () => {
    const result = await probeTls("localhost", port());
    expect(Object.keys(result).sort()).toEqual(["certDays", "connectMs", "dnsMs", "latencyMs", "ok", "tlsMs"]);
    expect(result.ok).toBe(true);
    expect([29, 30]).toContain(result.certDays);
    expectDuration(result.dnsMs);
    expectDuration(result.connectMs);
    expectDuration(result.tlsMs);
    expect(result.latencyMs).toBe(result.tlsMs);
    expect(await waitFor(() => secure!.sockets.size === 0)).toBe(true);
  });

  it("probeTls manda o SNI com o nome e não manda com IP", async () => {
    serverNames.length = 0;
    expect(await probeTls("localhost", port())).toMatchObject({ ok: true });
    expect(await probeTls("127.0.0.1", port())).toMatchObject({ ok: true, dnsMs: null });
    expect(await waitFor(() => serverNames.length === 2)).toBe(true);
    expect(serverNames).toEqual(["localhost", false]);
  });

  it("certificado vencido não reprova a medição: aparece como certDays negativo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 40 * 24 * 60 * 60_000);
    for (const result of [await probeTls("localhost", port()), await probeHttp(`https://localhost:${port()}/ok`)]) {
      expect(result.ok).toBe(true);
      expect([-11, -10]).toContain(result.certDays);
    }
  });

  it("probeTls: o prazo padrão é de 10 s e é cancelado ao terminar", async () => {
    expect(await expectTimerReleased(PROBE_TIMEOUT_MS, () => probeTls("127.0.0.1", port()))).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------- DNS

describe("probeDns", () => {
  it("servidor que responde um registro A: a latência é o tempo da consulta", async () => {
    const server = await startDns("a");
    const result = await probeDns(server.address, "example.com");
    expect(Object.keys(result).sort()).toEqual(["dnsMs", "latencyMs", "ok"]);
    expect(result.ok).toBe(true);
    expectDuration(result.dnsMs);
    expect(result.latencyMs).toBe(result.dnsMs);
    expect(server.queries).toEqual(["example.com"]);
  });

  it("servidor que nunca responde: falha na etapa dns dentro do prazo", async () => {
    const server = await startDns("mudo");
    const started = performance.now();
    const result = await expectTimerReleased(800, () => probeDns(server.address, "example.com", { timeoutMs: 300 }));
    expect(result).toEqual({ ok: false, latencyMs: null, error: "o servidor DNS não respondeu", failedAt: "dns" });
    expect(performance.now() - started).toBeLessThan(2500);
    // Uma tentativa só (tries: 1).
    expect(server.queries).toEqual(["example.com"]);
  });

  it("com mais de um servidor, o corte encerra a consulta em vez de esperar um prazo por servidor", async () => {
    // Quatro servidores mudos: sem o corte seriam 4 prazos de 300 ms (1,2 s), bem depois do corte (0,8 s).
    const servers = await Promise.all(Array.from({ length: 4 }, () => startDns("mudo")));
    mocks.getSystemDnsServers.mockResolvedValue(servers.map((server) => server.address));
    const cancel = vi.spyOn(Resolver.prototype, "cancel");
    const started = performance.now();
    const result = await probeDns(AUTO_SYSTEM_DNS, "example.com", { timeoutMs: 300 });
    expect(result).toEqual({ ok: false, latencyMs: null, error: "o servidor DNS não respondeu", failedAt: "dns" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(performance.now() - started).toBeLessThan(2500);
    // Dá tempo de o ECANCELLED do cancelamento chegar: ele não pode virar rejeição solta.
    await sleep(50);
  });

  it.each([
    ["servfail", "o servidor DNS devolveu falha (SERVFAIL)"],
    ["refused", "consulta recusada pelo servidor DNS"],
    ["nxdomain", "nome não encontrado"],
    ["vazio", "nome não encontrado"],
  ] as const)("resposta %s: %s", async (mode, error) => {
    const server = await startDns(mode);
    expect(await probeDns(server.address, "example.com")).toEqual({ ok: false, latencyMs: null, error, failedAt: "dns" });
  });

  it("porta UDP fechada: recusa ou silêncio, sempre na etapa dns", async () => {
    const server = await startDns("mudo");
    const address = server.address;
    await new Promise<void>((resolve) => dnsSockets.pop()!.close(() => resolve()));
    const result = await probeDns(address, "example.com", { timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, latencyMs: null, failedAt: "dns" });
    expect(["o servidor DNS recusou a consulta", "o servidor DNS não respondeu"]).toContain(result.error);
  });

  it("auto:system usa os servidores DNS que o sistema informa (Windows)", async () => {
    const server = await startDns("a");
    mocks.getSystemDnsServers.mockResolvedValue([server.address]);
    expect(await probeDns(AUTO_SYSTEM_DNS, "exemplo.teste")).toMatchObject({ ok: true });
    expect(server.queries).toEqual(["exemplo.teste"]);
  });

  it("auto:system sem lista do sistema mantém os padrões do resolvedor", async () => {
    const setServers = vi.spyOn(Resolver.prototype, "setServers");
    // Os resolvedores reais desta máquina podem responder ou não: só importa que a medição termine bem formada.
    const result = await probeDns(AUTO_SYSTEM_DNS, "example.com", { timeoutMs: 300 });
    expect(mocks.getSystemDnsServers).toHaveBeenCalledTimes(1);
    expect(setServers).not.toHaveBeenCalled();
    if (result.ok) expect(result.latencyMs).toBe(result.dnsMs);
    else expect(result).toMatchObject({ latencyMs: null, failedAt: "dns" });
  });

  it("auto:system continua nos padrões se a consulta ao sistema falhar", async () => {
    mocks.getSystemDnsServers.mockRejectedValue(new Error("PowerShell indisponível"));
    const result = await probeDns(AUTO_SYSTEM_DNS, "example.com", { timeoutMs: 300 });
    expect(typeof result.ok).toBe("boolean");
    if (!result.ok) expect(result.failedAt).toBe("dns");
  });

  it.each(["não é ip", "exemplo.com", "", AUTO_GATEWAY])("servidor inválido (%j): falha na etapa dns sem rejeitar", async (server) => {
    expect(await probeDns(server, "example.com")).toEqual({ ok: false, latencyMs: null, error: "ERR_INVALID_IP_ADDRESS", failedAt: "dns" });
  });

  it("nome que não é texto: falha sem rejeitar e sem deixar o corte armado", async () => {
    const server = await startDns("a");
    const result = await expectTimerReleased(3500, () => probeDns(server.address, 42 as never));
    expect(result).toMatchObject({ ok: false, latencyMs: null, failedAt: "dns" });
    expect(server.queries).toHaveLength(0);
  });

  it("o prazo padrão é de 3 s, com o corte meio segundo depois", async () => {
    const server = await startDns("a");
    expect(await expectTimerReleased(3500, () => probeDns(server.address, "example.com"))).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------- runProbe

describe("runProbe", () => {
  // O gateway fica em cache no módulo: cada teste roda num "dia" diferente para não herdar o do anterior.
  let clock = Date.UTC(2041, 0, 1);

  beforeEach(() => {
    clock += 24 * 60 * 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
  });

  it.each([
    null,
    undefined,
    "texto",
    42,
    {},
    { kind: "HTTP" },
    { kind: "HTTP", host: "" },
    { kind: "HTTP", host: "exemplo.com", url: "isto não é uma URL" },
    { kind: "HTTP", host: "exemplo.com", url: 42 },
    { kind: "TCP", host: "", port: 80 },
    { kind: "TCP", host: "127.0.0.1", port: -1 },
    { kind: "TCP", host: 42, port: "x" },
    { kind: "TLS", host: "", port: 70_000 },
    { kind: "DNS", host: "não é ip" },
    { kind: "DNS", host: "127.0.0.1", url: 42 },
    { kind: "ICMP", host: "-c 9999" },
    { kind: "ICMP" },
    { kind: "QUALQUER", host: "exemplo.com" },
    { kind: null, host: null },
  ])("nunca rejeita com um alvo sem sentido: %j", async (spec) => {
    const result = await runProbe(spec as never);
    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeNull();
    expect(typeof result.error).toBe("string");
    expect(result.error).not.toBe("");
    // Nenhum deles chega a iniciar um ping.
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("um erro inesperado dentro da sonda vira falha, nunca exceção", async () => {
    mocks.readRouteTable.mockResolvedValue([{ destination: "0.0.0.0/0", nextHop: "192.168.0.1", interface: "eth0", metric: 0, protocol: "dhcp" }]);
    const spec = {
      kind: "ICMP",
      get host(): string {
        throw new Error("campo quebrado");
      },
    };
    const result = await runProbe(spec as ProbeSpec);
    expect(result).toEqual({ ok: false, latencyMs: null, error: "falha inesperada na medição: campo quebrado", failedAt: null });
  });

  it("tipo desconhecido: falha com frase própria", async () => {
    expect(await runProbe({ kind: "SMTP", host: "exemplo.com" } as never)).toEqual({ ok: false, latencyMs: null, error: "tipo de medição desconhecido", failedAt: null });
  });

  it("HTTP usa a URL do alvo", async () => {
    expect(await runProbe({ kind: "HTTP", host: "127.0.0.1", url: `${webUrl}/nao-existe` })).toMatchObject({ ok: true, httpStatus: 404 });
    expect(seen.map((request) => request.url)).toEqual(["/nao-existe"]);
  });

  it("HTTP sem URL mede https://<host>/", async () => {
    stubLookup(lookupFails("ENOTFOUND"));
    const request = vi.spyOn(https, "request");
    expect(await runProbe({ kind: "HTTP", host: "servico.exemplo" })).toMatchObject({ ok: false, failedAt: "dns" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0][0])).toBe("https://servico.exemplo/");
  });

  it("TCP mede a porta do alvo e, sem porta, a 443", async () => {
    expect(await runProbe({ kind: "TCP", host: "127.0.0.1", port: web.port })).toMatchObject({ ok: true, dnsMs: null });

    stubLookup(lookupFails("ENOTFOUND"));
    const connect = vi.spyOn(net, "connect");
    expect(await runProbe({ kind: "TCP", host: "servico.exemplo", port: null })).toMatchObject({ ok: false, failedAt: "dns" });
    expect(connect).toHaveBeenLastCalledWith({ host: "servico.exemplo", port: 443, family: 4 });
  });

  it("TLS mede a porta do alvo e, sem porta, a 443", async () => {
    stubLookup(lookupFails("ENOTFOUND"));
    const connect = vi.spyOn(tls, "connect");
    expect(await runProbe({ kind: "TLS", host: "servico.exemplo" })).toMatchObject({ ok: false, failedAt: "dns" });
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ host: "servico.exemplo", port: 443 }));
    expect(await runProbe({ kind: "TLS", host: "servico.exemplo", port: 8443 })).toMatchObject({ ok: false, failedAt: "dns" });
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ host: "servico.exemplo", port: 8443 }));
  });

  it("DNS consulta o nome do alvo no servidor do alvo e, sem nome, o nome padrão", async () => {
    const server = await startDns("a");
    expect(await runProbe({ kind: "DNS", host: server.address })).toMatchObject({ ok: true });
    expect(await runProbe({ kind: "DNS", host: server.address, url: "exemplo.teste" })).toMatchObject({ ok: true });
    expect(server.queries).toEqual([DEFAULT_DNS_NAME, "exemplo.teste"]);
  });

  it("DNS com auto:system consulta os resolvedores do sistema", async () => {
    const server = await startDns("a");
    mocks.getSystemDnsServers.mockResolvedValue([server.address]);
    expect(await runProbe({ kind: "DNS", host: AUTO_SYSTEM_DNS, url: DEFAULT_DNS_NAME })).toMatchObject({ ok: true });
    expect(server.queries).toEqual([DEFAULT_DNS_NAME]);
  });

  it("ICMP roda o ping no host do alvo", async () => {
    nextPing({ stdout: IPUTILS_ALL });
    expect(await runProbe({ kind: "ICMP", host: "1.1.1.1" })).toEqual({ ok: true, latencyMs: 12.36, lossPct: 0, jitterMs: 0.875 });
    expect(mocks.execFile.mock.calls[0][1]).toEqual(pingArgs("1.1.1.1", 5, process.platform));
  });

  it("auto:gateway sem gateway padrão: não suportado, e nada é medido", async () => {
    expect(await runProbe({ kind: "ICMP", host: AUTO_GATEWAY })).toEqual({ ok: false, latencyMs: null, unsupported: true, error: "gateway padrão não encontrado" });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("auto:gateway mede o IP do gateway padrão", async () => {
    mocks.readRouteTable.mockResolvedValue([{ destination: "0.0.0.0/0", nextHop: "192.168.0.1", interface: "eth0", metric: 100, protocol: "dhcp" }]);
    nextPing({ stdout: IPUTILS_PARTIAL });
    expect(await runProbe({ kind: "ICMP", host: AUTO_GATEWAY })).toMatchObject({ ok: true, lossPct: 40 });
    expect(mocks.execFile.mock.calls[0][1]).toEqual(pingArgs("192.168.0.1", 5, process.platform));
  });

  it("auto:gateway vale para os outros tipos de medição também", async () => {
    mocks.readRouteTable.mockResolvedValue([{ destination: "0.0.0.0/0", nextHop: "127.0.0.1", interface: "lo", metric: 0, protocol: "static" }]);
    expect(await runProbe({ kind: "TCP", host: AUTO_GATEWAY, port: web.port })).toMatchObject({ ok: true, dnsMs: null });
  });
});
