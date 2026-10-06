import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAliveViaTcp, LIVENESS_PORTS, tcpSweep } from "./tcp-probe";

let server: net.Server;
let openPort: number;
let closedPort: number;

/** Reserva uma porta livre e a fecha em seguida, para que conexões nela sejam recusadas. */
async function reserveClosedPort(): Promise<number> {
  const temp = net.createServer();
  await new Promise<void>((resolve) => temp.listen(0, "127.0.0.1", resolve));
  const port = (temp.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => temp.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openPort = (server.address() as net.AddressInfo).port;
  closedPort = await reserveClosedPort();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("LIVENESS_PORTS", () => {
  it("inclui as portas que Windows com firewall costuma deixar abertas", () => {
    expect(LIVENESS_PORTS).toEqual(expect.arrayContaining([135, 139, 445, 3389]));
  });
});

describe("isAliveViaTcp", () => {
  it("considera ligado o host que aceita a conexão", async () => {
    expect(await isAliveViaTcp("127.0.0.1", [openPort], 1000)).toBe(true);
  });

  it("considera ligado o host que recusa a conexão (RST)", async () => {
    expect(await isAliveViaTcp("127.0.0.1", [closedPort], 1000)).toBe(true);
  });

  it("considera desligado o host que não responde em nenhuma porta", async () => {
    // 192.0.2.0/24 (TEST-NET-1) é reservado para documentação e não é roteado.
    expect(await isAliveViaTcp("192.0.2.1", [3389, 445], 300)).toBe(false);
  });

  it("retorna falso sem portas para testar", async () => {
    expect(await isAliveViaTcp("127.0.0.1", [], 300)).toBe(false);
  });
});

describe("tcpSweep", () => {
  it("retorna só os IPs que responderam", async () => {
    const alive = await tcpSweep(["127.0.0.1", "192.0.2.1"], { ports: [openPort], timeoutMs: 300 });
    expect(alive).toEqual(["127.0.0.1"]);
  });
});
