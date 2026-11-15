import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { compositeResult, probeDnsComposite, rcodeOf } from "./dns-composite";
import type { DnsAnswer } from "./types";

/** Servidor DNS mínimo em UDP local: responde A com TTL, NXDOMAIN, SERVFAIL ou fica calado. */
type Behavior = { kind: "answer"; ttl: number; ips: string[]; delayMs?: number } | { kind: "rcode"; rcode: number } | { kind: "silent" };

const servers: dgram.Socket[] = [];

function questionEnd(msg: Buffer): number {
  let i = 12;
  while (i < msg.length && msg[i] !== 0) i += msg[i] + 1;
  return i + 1 + 4;
}

function reply(query: Buffer, behavior: Behavior): Buffer | null {
  if (behavior.kind === "silent") return null;
  const qEnd = questionEnd(query);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  const rcode = behavior.kind === "rcode" ? behavior.rcode : 0;
  header.writeUInt16BE(0x8180 | rcode, 2);
  header.writeUInt16BE(1, 4);
  const answers = behavior.kind === "answer" ? behavior.ips : [];
  header.writeUInt16BE(answers.length, 6);
  const records = answers.map((ip) => {
    const rr = Buffer.alloc(16);
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(1, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(behavior.kind === "answer" ? behavior.ttl : 0, 6);
    rr.writeUInt16BE(4, 10);
    ip.split(".").forEach((octet, k) => rr.writeUInt8(Number(octet), 12 + k));
    return rr;
  });
  return Buffer.concat([header, query.subarray(12, qEnd), ...records]);
}

async function fakeDns(behavior: Behavior): Promise<string> {
  const socket = dgram.createSocket("udp4");
  servers.push(socket);
  socket.on("message", (msg, rinfo) => {
    const out = reply(msg, behavior);
    if (!out) return;
    const send = () => socket.send(out, rinfo.port, rinfo.address);
    if (behavior.kind === "answer" && behavior.delayMs) setTimeout(send, behavior.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return `127.0.0.1:${socket.address().port}`;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe("probeDnsComposite com servidores DNS locais", () => {
  it("consulta o sistema e os públicos ao mesmo tempo e guarda latência, TTL e endereços de cada um", async () => {
    const system = await fakeDns({ kind: "answer", ttl: 37, ips: ["10.0.0.1", "10.0.0.2"] });
    const a = await fakeDns({ kind: "answer", ttl: 300, ips: ["10.0.0.1"] });
    const b = await fakeDns({ kind: "answer", ttl: 299, ips: ["10.0.0.3"], delayMs: 50 });
    const result = await probeDnsComposite("servico.test", { systemServers: [system], publicResolvers: [a, b], timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    expect(result.rcode).toBe("NOERROR");
    expect(result.ttlSec).toBe(37);
    expect(result.latencyMs).toBe(result.dnsMs);
    expect(result.dnsAnswers).toHaveLength(3);
    expect(result.dnsAnswers![0]).toMatchObject({ resolver: "system", ok: true, ttlSec: 37, addresses: ["10.0.0.1", "10.0.0.2"] });
    expect(result.dnsAnswers![1]).toMatchObject({ resolver: "127.0.0.1", ok: true, ttlSec: 300 });
    expect(result.dnsAnswers![2].ms!).toBeGreaterThanOrEqual(40);
  });

  it("NXDOMAIN só no DNS do sistema: falha, com os públicos resolvendo normalmente", async () => {
    const system = await fakeDns({ kind: "rcode", rcode: 3 });
    const a = await fakeDns({ kind: "answer", ttl: 60, ips: ["10.0.0.1"] });
    const result = await probeDnsComposite("servico.test", { systemServers: [system], publicResolvers: [a], timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.rcode).toBe("NXDOMAIN");
    expect(result.failedAt).toBe("dns");
    expect(result.error).toContain("NXDOMAIN");
    expect(result.error).toContain("resolve normalmente");
    expect(result.dnsAnswers![1]).toMatchObject({ ok: true, rcode: "NOERROR" });
  });

  it("SERVFAIL e timeout são separados por resolvedor", async () => {
    const system = await fakeDns({ kind: "rcode", rcode: 2 });
    const silent = await fakeDns({ kind: "silent" });
    const started = performance.now();
    const result = await probeDnsComposite("servico.test", { systemServers: [system], publicResolvers: [silent], timeoutMs: 300 });
    expect(performance.now() - started).toBeLessThan(2500);
    expect(result.ok).toBe(false);
    expect(result.dnsAnswers!.map((x) => x.rcode)).toEqual(["SERVFAIL", "TIMEOUT"]);
  });

  it("com vários servidores do sistema, vale a primeira resposta boa (um DNS morto na lista não derruba)", async () => {
    const dead = await fakeDns({ kind: "silent" });
    const good = await fakeDns({ kind: "answer", ttl: 10, ips: ["10.0.0.9"] });
    const result = await probeDnsComposite("servico.test", { systemServers: [dead, good], publicResolvers: [], timeoutMs: 1500 });
    expect(result.ok).toBe(true);
    expect(result.dnsAnswers![0].addresses).toEqual(["10.0.0.9"]);
  });

  it("nome vazio não consulta nada", async () => {
    const result = await probeDnsComposite("  ");
    expect(result).toMatchObject({ ok: false, failedAt: "dns" });
  });
});

describe("compositeResult e rcodeOf", () => {
  const answer = (resolver: string, rcode: DnsAnswer["rcode"], ms: number | null = null): DnsAnswer => ({ resolver, ok: rcode === "NOERROR", ms, rcode, ttlSec: rcode === "NOERROR" ? 60 : null, addresses: [] });

  it("o resultado é o do DNS do sistema", () => {
    expect(compositeResult([answer("system", "NOERROR", 4.2), answer("8.8.8.8", "TIMEOUT")])).toMatchObject({ ok: true, latencyMs: 4.2, rcode: "NOERROR", ttlSec: 60 });
  });

  it("todos com o mesmo erro: o nome sumiu de verdade", () => {
    const r = compositeResult([answer("system", "NXDOMAIN"), answer("8.8.8.8", "NXDOMAIN"), answer("1.1.1.1", "NXDOMAIN")]);
    expect(r.error).toBe("DNS do sistema: nome não encontrado (NXDOMAIN) (os resolvedores públicos dão o mesmo resultado)");
  });

  it("erros diferentes aparecem por resolvedor", () => {
    const r = compositeResult([answer("system", "TIMEOUT"), answer("8.8.8.8", "SERVFAIL")]);
    expect(r.error).toContain("8.8.8.8: falha do servidor (SERVFAIL)");
  });

  it("sem respostas é falha", () => {
    expect(compositeResult([])).toMatchObject({ ok: false });
  });

  it("traduz os códigos do Node", () => {
    expect(rcodeOf({ code: "ENOTFOUND" })).toBe("NXDOMAIN");
    expect(rcodeOf({ code: "ESERVFAIL" })).toBe("SERVFAIL");
    expect(rcodeOf({ code: "ETIMEOUT" })).toBe("TIMEOUT");
    expect(rcodeOf({ code: "ENODATA" })).toBe("NODATA");
    expect(rcodeOf(new Error("x"))).toBe("ERROR");
    expect(rcodeOf(null)).toBe("ERROR");
  });
});
