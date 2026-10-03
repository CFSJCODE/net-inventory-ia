import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Device, TopologyLink } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { nameWithIp as deviceName } from "@/lib/device-name";
import { mapWithConcurrency } from "./concurrency";

export const LINK_CHECK_INTERVAL_MS = 30_000;
/** Falhas seguidas necessárias para declarar a ligação caída (um ping perdido não derruba o link). */
export const FAILURES_TO_DOWN = 2;

const execFileAsync = promisify(execFile);

/**
 * Ping único que devolve o tempo de resposta informado pelo próprio ping ("tempo=3ms", "time=0.4 ms",
 * "tempo<1ms"), e não o tempo de abrir o processo, que somaria dezenas de ms ao valor real.
 */
async function pingRtt(ip: string, timeoutMs: number): Promise<number | null> {
  const isWindows = process.platform === "win32";
  const args = isWindows ? ["-n", "1", "-w", String(timeoutMs), ip] : ["-c", "1", "-W", String(Math.ceil(timeoutMs / 1000)), ip];
  try {
    const { stdout } = await execFileAsync("ping", args, { timeout: timeoutMs + 1000 });
    if (!/ttl=/i.test(stdout)) return null;
    const rtt = stdout.match(/([=<])\s*([\d.,]+)\s*ms/i);
    return rtt ? (rtt[1] === "<" ? 0 : Math.round(Number(rtt[2].replace(",", ".")))) : 0;
  } catch {
    return null;
  }
}

interface Reachability {
  ok: boolean;
  latencyMs: number | null;
}

function tcpProbe(ip: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = new net.Socket();
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok ? Math.round(performance.now() - started) : null);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    // RST (porta fechada) também prova que o host está vivo e respondendo.
    socket.once("error", (err: NodeJS.ErrnoException) => finish(err.code === "ECONNREFUSED"));
    socket.once("timeout", () => finish(false));
    socket.connect(port, ip);
  });
}

/**
 * Um dispositivo está alcançável se responder ao ping (até 2 tentativas) ou, para quem bloqueia
 * ICMP, aceitar/recusar conexão TCP em uma das portas que o scan já encontrou abertas.
 */
async function checkDevice(device: Pick<Device, "ip" | "openPorts">): Promise<Reachability> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const rtt = await pingRtt(device.ip, 1000);
    if (rtt !== null) return { ok: true, latencyMs: rtt };
  }
  const ports = (device.openPorts ?? "").split(",").filter(Boolean).map(Number).slice(0, 3);
  for (const port of ports) {
    const latency = await tcpProbe(device.ip, port, 1000);
    if (latency !== null) return { ok: true, latencyMs: latency };
  }
  return { ok: false, latencyMs: null };
}

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}min`;
}

type LinkWithDevices = TopologyLink & { fromDevice: Device; toDevice: Device };

async function applyResult(link: LinkWithDevices, from: Reachability, to: Reachability): Promise<void> {
  const now = new Date();
  const ok = from.ok && to.ok;

  if (ok) {
    const cameBack = link.status === "DOWN";
    await prisma.topologyLink.update({
      where: { id: link.id },
      data: {
        status: "UP",
        failures: 0,
        downReason: null,
        latencyMs: to.latencyMs,
        lastCheckAt: now,
        ...(link.status !== "UP" && { lastChangeAt: now }),
      },
    });
    if (cameBack) {
      const downFor = link.lastChangeAt ? ` após ${formatDuration(now.getTime() - link.lastChangeAt.getTime())} fora` : "";
      await prisma.deviceEvent.create({
        data: {
          deviceId: link.toDeviceId,
          type: "LINK_UP",
          message: `— ligação com ${deviceName(link.fromDevice)} voltou${downFor}`,
        },
      });
    }
    return;
  }

  const failed = [!from.ok && link.fromDevice, !to.ok && link.toDevice].filter(Boolean) as Device[];
  const reason = `Sem resposta de ${failed.map(deviceName).join(" e ")}`;
  const failures = link.failures + 1;
  // Ao criar a ligação (UNKNOWN) já mostramos o estado real; para derrubar uma ligação UP, exigimos falhas seguidas.
  const goesDown = link.status !== "DOWN" && (link.status === "UNKNOWN" || failures >= FAILURES_TO_DOWN);

  await prisma.topologyLink.update({
    where: { id: link.id },
    data: {
      failures,
      downReason: reason,
      latencyMs: null,
      lastCheckAt: now,
      ...(goesDown && { status: "DOWN", lastChangeAt: now }),
    },
  });

  if (goesDown && link.status === "UP") {
    await prisma.deviceEvent.create({
      data: {
        deviceId: link.toDeviceId,
        type: "LINK_DOWN",
        message: `— ligação com ${deviceName(link.fromDevice)} caiu (${reason.charAt(0).toLowerCase()}${reason.slice(1)})`,
      },
    });
  }
}

/** Evita duas checagens simultâneas (intervalo + botão "testar agora"), que duplicariam eventos. */
const state = globalThis as typeof globalThis & { __linkCheck?: Promise<void>; __linkMonitorTimer?: NodeJS.Timeout };

export function checkAllLinks(): Promise<void> {
  if (state.__linkCheck) return state.__linkCheck;

  state.__linkCheck = (async () => {
    const links = await prisma.topologyLink.findMany({ include: { fromDevice: true, toDevice: true } });
    if (!links.length) return;

    const devices = new Map<string, Device>();
    for (const l of links) {
      devices.set(l.fromDeviceId, l.fromDevice);
      devices.set(l.toDeviceId, l.toDevice);
    }
    // Cada dispositivo é testado uma vez por rodada, mesmo participando de várias ligações.
    const results = new Map<string, Reachability>();
    await mapWithConcurrency(Array.from(devices.values()), 8, async (d) => {
      results.set(d.id, await checkDevice(d));
    });

    for (const link of links) {
      await applyResult(link, results.get(link.fromDeviceId)!, results.get(link.toDeviceId)!);
    }
  })()
    .catch((err) => console.error("[link-monitor] falha na checagem:", err))
    .finally(() => {
      state.__linkCheck = undefined;
    });

  return state.__linkCheck;
}

/** Inicia a checagem periódica das ligações (chamado uma vez no boot do servidor, via instrumentation). */
export function startLinkMonitor(): void {
  if (state.__linkMonitorTimer) return;
  state.__linkMonitorTimer = setInterval(() => void checkAllLinks(), LINK_CHECK_INTERVAL_MS);
  void checkAllLinks();
  console.log(`[link-monitor] monitorando ligações a cada ${LINK_CHECK_INTERVAL_MS / 1000}s`);
}
