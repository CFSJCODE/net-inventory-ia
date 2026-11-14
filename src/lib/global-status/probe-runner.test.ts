import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry, CatalogTarget } from "./catalog";

// Prisma de verdade num banco temporário exclusivo; as sondas são dublês, para nenhum teste medir a rede de verdade.
const fixture = await vi.hoisted(async () => {
  const { createTempDb } = await import("./__fixtures__/temp-db");
  return { ...createTempDb("netinventory-status-runner-"), catalog: [] as CatalogEntry[], runProbe: vi.fn(), defaultGateway: vi.fn(async () => null) };
});

vi.mock("@/lib/prisma", () => ({ prisma: fixture.prisma }));
vi.mock("./catalog", async (importOriginal) => ({ ...(await importOriginal<typeof import("./catalog")>()), STATUS_CATALOG: fixture.catalog }));
vi.mock("./probes", () => ({ runProbe: fixture.runProbe, defaultGateway: fixture.defaultGateway }));

import { dropTempDb, migrateTempDb } from "./__fixtures__/temp-db";
import { ensureCatalogSeeded } from "./collector";
import { getLocalConnectivity, runProbeTick, runProbesNow, startProbeRunner } from "./probe-runner";
import { serialized } from "./write-queue";

const db = fixture.prisma;
const T0 = new Date("2026-11-14T12:00:00Z");
const state = globalThis as { __globalStatusProbes?: { started: boolean; timer?: NodeJS.Timeout }; __globalStatusSeed?: unknown };

const web = (url: string): CatalogTarget[] => [
  { key: "http", kind: "HTTP", host: new URL(url).hostname, url },
  { key: "tcp", kind: "TCP", host: new URL(url).hostname, port: 443 },
];
const GITHUB: CatalogEntry = { slug: "github", name: "GitHub", category: "DEV", sourceType: "STATUSPAGE", sourceUrl: "https://www.githubstatus.com", pageUrl: null, targets: web("https://github.com/robots.txt") };
const DISCORD: CatalogEntry = { slug: "discord", name: "Discord", category: "SOCIAL", sourceType: "STATUSPAGE", sourceUrl: "https://discordstatus.com", pageUrl: null, targets: web("https://discord.com/api/v10/gateway") };
const WHATSAPP: CatalogEntry = { slug: "whatsapp", name: "WhatsApp", category: "SOCIAL", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://web.whatsapp.com/robots.txt") };

const serviceOf = (slug: string) => db.statusService.findUniqueOrThrow({ where: { slug }, include: { targets: { orderBy: { key: "asc" } } } });

/** O que as medições deixaram gravado antes de serem desligadas. */
async function leaveMeasuredState(): Promise<void> {
  // Provedor diz normal, medição dizia fora do ar: o card ficou vermelho.
  await db.statusService.update({ where: { slug: "github" }, data: { officialState: "OK", status: "DOWN", measuredStatus: "DOWN", measuredReason: "HTTP: 3 falhas seguidas", latencyMs: 480 } });
  // Sem fonte oficial: o card valia só pelo medido.
  await db.statusService.update({ where: { slug: "whatsapp" }, data: { status: "DEGRADED", measuredStatus: "DEGRADED", measuredReason: "TCP 443: latência 5× a habitual", latencyMs: 900 } });
  // O Discord nunca foi medido: só tem o que a fonte oficial declarou.
  await db.statusService.update({ where: { slug: "discord" }, data: { officialState: "DEGRADED", status: "DEGRADED", lastChangeAt: T0 } });
  const github = await serviceOf("github");
  await db.probeTarget.update({ where: { id: github.targets[0].id }, data: { status: "DOWN", statusReason: "3 falhas seguidas", lastCheckAt: T0, lastLatencyMs: null, lastError: "prazo esgotado" } });
  await db.probeTarget.update({ where: { id: github.targets[1].id }, data: { status: "OK", lastCheckAt: T0, lastLatencyMs: 480 } });
  await db.probeCheck.create({ data: { targetId: github.targets[1].id, vantage: "server", at: T0, ok: true, latencyMs: 480 } });
  await db.probeRollup.create({ data: { targetId: github.targets[1].id, vantage: "server", bucket: T0, samples: 10, failures: 0, p50Ms: 470, p95Ms: 490 } });
}

/** Espera a limpeza que o agendador dispara ao subir desligado: ela entra na fila de escrita depois de conferir o catálogo. */
async function cleared(transaction: { mock: { calls: unknown[] } }, times = 1): Promise<void> {
  await vi.waitFor(() => expect(transaction.mock.calls.length).toBeGreaterThanOrEqual(times), { timeout: 5_000, interval: 20 });
  await serialized(async () => undefined);
}

beforeAll(async () => {
  await migrateTempDb(fixture);
});

beforeEach(async () => {
  await db.statusService.deleteMany();
  state.__globalStatusSeed = undefined;
  state.__globalStatusProbes = undefined;
  fixture.runProbe.mockReset();
  fixture.catalog.splice(0, fixture.catalog.length, GITHUB, DISCORD, WHATSAPP);
  await ensureCatalogSeeded();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  clearTimeout(state.__globalStatusProbes?.timer);
  state.__globalStatusProbes = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await dropTempDb(fixture);
});

describe("medições desligadas (GLOBAL_STATUS_PROBES=off)", () => {
  beforeEach(() => {
    vi.stubEnv("GLOBAL_STATUS_PROBES", "off");
  });

  it("ao subir, apaga o que as medições deixaram nos serviços e nos alvos; o card volta a valer só pelo status oficial", async () => {
    await leaveMeasuredState();
    const transaction = vi.spyOn(db, "$transaction");

    startProbeRunner();
    await cleared(transaction);

    const github = await serviceOf("github");
    expect(github).toMatchObject({ officialState: "OK", status: "OK", measuredStatus: null, measuredReason: null, latencyMs: null });
    expect(github.lastChangeAt).not.toBeNull();
    expect(github.targets.map((target) => [target.key, target.status, target.statusReason, target.lastLatencyMs, target.lastError])).toEqual([
      ["http", "UNKNOWN", null, null, null],
      ["tcp", "UNKNOWN", null, null, null],
    ]);
    // Sem fonte oficial não sobra nada a mostrar.
    expect(await serviceOf("whatsapp")).toMatchObject({ status: "UNKNOWN", measuredStatus: null, measuredReason: null, latencyMs: null });
    // O que nunca teve estado medido não é regravado.
    expect(await serviceOf("discord")).toMatchObject({ officialState: "DEGRADED", status: "DEGRADED", lastChangeAt: T0 });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("medições próprias desligadas"));
  });

  it("o histórico (medições e janelas) fica onde está", async () => {
    await leaveMeasuredState();
    const transaction = vi.spyOn(db, "$transaction");
    startProbeRunner();
    await cleared(transaction);
    expect(await db.probeCheck.count()).toBe(1);
    expect(await db.probeRollup.count()).toBe(1);
  });

  it("não arma o agendador, não mede nada e a conexão do servidor fica como \"ok\"", async () => {
    const transaction = vi.spyOn(db, "$transaction");
    startProbeRunner();
    await cleared(transaction);
    expect(state.__globalStatusProbes).toMatchObject({ started: true });
    expect(state.__globalStatusProbes!.timer).toBeUndefined();

    await runProbeTick();
    await runProbeTick({ force: true });
    await runProbesNow();
    expect(fixture.runProbe).not.toHaveBeenCalled();
    expect(await db.probeCheck.count()).toBe(0);
    expect(getLocalConnectivity()).toEqual({ state: "ok", since: null, reason: null });
  });

  it("subir duas vezes no mesmo processo limpa uma vez só", async () => {
    const transaction = vi.spyOn(db, "$transaction");
    startProbeRunner();
    startProbeRunner();
    await cleared(transaction);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await serialized(async () => undefined);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("banco ocupado na primeira tentativa: tenta de novo e limpa", async () => {
    await leaveMeasuredState();
    const transaction = vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("database is locked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    startProbeRunner();
    await cleared(transaction, 2);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(await serviceOf("github")).toMatchObject({ status: "OK", measuredStatus: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it("se as duas tentativas falham, registra o aviso e segue; a fila de escrita continua funcionando", async () => {
    await leaveMeasuredState();
    const transaction = vi.spyOn(db, "$transaction").mockRejectedValue(new Error("database is locked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    startProbeRunner();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5_000, interval: 20 });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("o estado medido antes de desligar as medições não foi apagado: database is locked"));
    // Nada foi apagado, e uma gravação seguinte passa normalmente pela fila.
    expect(await serviceOf("github")).toMatchObject({ status: "DOWN", measuredStatus: "DOWN" });
    transaction.mockRestore();
    await expect(serialized(() => db.statusService.update({ where: { slug: "github" }, data: { lastError: null } }))).resolves.toMatchObject({ slug: "github" });
  });
});

describe("medições ligadas", () => {
  it("ao subir, arma o primeiro passo e não apaga nada do que está gravado", async () => {
    await leaveMeasuredState();
    const transaction = vi.spyOn(db, "$transaction");
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });

    startProbeRunner();
    startProbeRunner();
    expect(vi.getTimerCount()).toBe(1);
    // O passo não chega a rodar: o teste só confere que foi agendado.
    vi.clearAllTimers();
    vi.useRealTimers();

    await serialized(async () => undefined);
    expect(transaction).not.toHaveBeenCalled();
    expect(await serviceOf("github")).toMatchObject({ status: "DOWN", measuredStatus: "DOWN", measuredReason: "HTTP: 3 falhas seguidas", latencyMs: 480 });
    expect(fixture.runProbe).not.toHaveBeenCalled();
  });
});
