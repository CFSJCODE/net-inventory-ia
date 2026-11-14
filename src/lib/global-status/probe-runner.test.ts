import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry, CatalogTarget } from "./catalog";
import type { ProbeResult } from "./types";

// Prisma de verdade num banco temporário exclusivo; as sondas são dublês, para nenhum teste medir a rede de verdade.
const fixture = await vi.hoisted(async () => {
  const { createTempDb } = await import("./__fixtures__/temp-db");
  return { ...createTempDb("netinventory-status-runner-"), catalog: [] as CatalogEntry[], runProbe: vi.fn(), defaultGateway: vi.fn(async () => null) };
});

vi.mock("@/lib/prisma", () => ({ prisma: fixture.prisma }));
vi.mock("./catalog", async (importOriginal) => ({ ...(await importOriginal<typeof import("./catalog")>()), STATUS_CATALOG: fixture.catalog }));
vi.mock("./probes", () => ({ runProbe: fixture.runProbe, defaultGateway: fixture.defaultGateway }));

import { rememberSeen, transitionNotices, type SeenStatus } from "@/components/global-status/transitions";
import { dropTempDb, migrateTempDb } from "./__fixtures__/temp-db";
import { ensureCatalogSeeded } from "./collector";
import { servedMeasure } from "./probe-logic";
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

/**
 * Espera a limpeza que o agendador dispara ao subir desligado: ela entra na fila de escrita depois de conferir o catálogo.
 * O prazo da espera é menor que o do teste: se a limpeza não vier, a falha diz quantas gravações faltaram.
 */
async function cleared(transaction: { mock: { calls: unknown[] } }, times = 1): Promise<void> {
  await vi.waitFor(() => expect(transaction.mock.calls.length).toBeGreaterThanOrEqual(times), { timeout: 4_000, interval: 20 });
  await serialized(async () => undefined);
}

/** A conexão do próprio servidor nos dublês das sondas: de pé, ou fora (nada responde). */
let link: "ok" | "fora" = "ok";

/** Tudo responde enquanto a conexão do servidor está de pé. */
function answering(): ProbeResult {
  return link === "fora" ? { ok: false, latencyMs: null, error: "sem rota até o destino", failedAt: "connect" } : { ok: true, latencyMs: 20 };
}

/** O HTTP do GitHub responde 503 o tempo todo: antes, durante e depois de uma queda da conexão do servidor. */
function githubHttpDown(spec: { kind: string; host: string }): ProbeResult {
  if (link === "ok" && spec.kind === "HTTP" && spec.host === "github.com") return { ok: false, latencyMs: null, httpStatus: 503, error: "HTTP 503", failedAt: "http" };
  return answering();
}

/** O que a página recebe a cada consulta (o mesmo mapeamento de getGlobalStatus). */
async function poll() {
  const services = await db.statusService.findMany({ orderBy: { position: "asc" } });
  return {
    services: services.map((s) => ({ slug: s.slug, name: s.name, category: s.category, officialStatus: s.officialStatus, ...servedMeasure(s, true) })),
    connectivity: getLocalConnectivity(),
  };
}

/** Uma página aberta o tempo todo: consulta depois de cada passo e guarda os avisos que mostraria. */
function openPage() {
  let seen: SeenStatus | null = null;
  const notices: string[] = [];
  return {
    notices,
    async see() {
      const data = await poll();
      if (seen) notices.push(...transitionNotices(seen, data).map((notice) => notice.title));
      seen = rememberSeen(seen, data);
      return data;
    },
    /** O card do GitHub como a página o mostra agora. */
    async github() {
      const card = (await this.see()).services.find((s) => s.slug === "github")!;
      return `${card.status} ${card.measuredReason}`;
    },
  };
}

/** Reinício do servidor: o estado em memória do agendador some, o banco fica. */
function restart(): void {
  state.__globalStatusProbes = undefined;
}

/** Envelhece as medições gravadas: o servidor ficou parado esse tempo. */
async function ageChecks(minutes: number): Promise<void> {
  const checks = await db.probeCheck.findMany({ select: { id: true, at: true } });
  await db.$transaction(checks.map((c) => db.probeCheck.update({ where: { id: c.id }, data: { at: new Date(c.at.getTime() - minutes * 60_000) } })));
}

/** `count` passos seguidos medindo todos os alvos. */
async function rounds(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await runProbeTick({ force: true });
}

/** O catálogo de verdade tem a faixa "Sua Internet" (gateway, DNS do sistema e três resolvedores públicos); os serviços com fonte oficial estão normais nela. */
async function withInternetStrip(): Promise<void> {
  const real = (await vi.importActual<typeof import("./catalog")>("./catalog")).STATUS_CATALOG;
  fixture.catalog.push(...real.filter((entry) => entry.category === "INTERNET"));
  state.__globalStatusSeed = undefined;
  await ensureCatalogSeeded();
  await db.statusService.updateMany({ where: { sourceType: { not: "NONE" } }, data: { officialState: "OK", officialStatus: "All Systems Operational" } });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

/** A conexão do servidor cai e a pausa é gravada; o servidor fica 30 min parado e, quando sobe, a conexão já voltou. */
async function outageWithRestart(page: ReturnType<typeof openPage>): Promise<void> {
  link = "fora";
  await rounds(1);
  await page.see();
  restart();
  await ageChecks(30);
  link = "ok";
}

/** As três rodadas seguintes à volta da conexão: o que o card do GitHub mostra depois de cada uma. */
async function githubAfterReturn(page: ReturnType<typeof openPage>): Promise<string[]> {
  const cards: string[] = [];
  for (let i = 0; i < 3; i++) {
    await rounds(1);
    cards.push(await page.github());
  }
  return cards;
}

beforeAll(async () => {
  await migrateTempDb(fixture);
});

beforeEach(async () => {
  await db.statusService.deleteMany();
  state.__globalStatusSeed = undefined;
  state.__globalStatusProbes = undefined;
  link = "ok";
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

  it("o servidor parou no meio de uma falta de Internet: a pausa também é apagada, do serviço e dos alvos \"Sem dados\"", async () => {
    const pause = "Medições pausadas: sem Internet neste servidor.";
    await db.statusService.update({ where: { slug: "github" }, data: { officialState: "OK", status: "OK", measuredStatus: "UNKNOWN", measuredReason: pause } });
    const [http, tcp] = (await serviceOf("github")).targets;
    await db.probeTarget.update({ where: { id: http.id }, data: { status: "UNKNOWN", statusReason: pause } });
    // Um alvo que só falhou uma vez segue "Sem dados", com o erro dessa medição.
    await db.probeTarget.update({ where: { id: tcp.id }, data: { status: "UNKNOWN", lastError: "prazo esgotado" } });
    const transaction = vi.spyOn(db, "$transaction");

    startProbeRunner();
    await cleared(transaction);

    // Sem isso, religar as medições depois encontraria os alvos como "pausados" por uma queda que já passou.
    const github = await serviceOf("github");
    expect(github).toMatchObject({ status: "OK", measuredStatus: null, measuredReason: null });
    expect(github.targets.map((target) => [target.key, target.status, target.statusReason, target.lastError])).toEqual([
      ["http", "UNKNOWN", null, null],
      ["tcp", "UNKNOWN", null, null],
    ]);
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

  it("o catálogo recusado pelo banco ao subir não impede a limpeza, e segue sendo gravado por quem pedir depois", async () => {
    await leaveMeasuredState();
    // O servidor acabou de subir: o catálogo ainda vai ser gravado, e o banco recusa essa gravação.
    state.__globalStatusSeed = undefined;
    const transaction = vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("database is locked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    startProbeRunner();
    // A espera termina quando a limpeza chega ao banco ou quando o agendador desiste dela: aí é o aviso que conta o motivo.
    await vi.waitFor(() => expect(transaction.mock.calls.length >= 2 || warn.mock.calls.length > 0).toBe(true), { timeout: 4_000, interval: 20 });
    await serialized(async () => undefined);

    expect(warn).not.toHaveBeenCalled();
    expect(await serviceOf("github")).toMatchObject({ status: "OK", measuredStatus: null, measuredReason: null, latencyMs: null });
    expect((await serviceOf("github")).targets.map((target) => target.status)).toEqual(["UNKNOWN", "UNKNOWN"]);
    await ensureCatalogSeeded();
    expect(transaction).toHaveBeenCalledTimes(3);
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
  const STILL_DOWN = "DOWN HTTP: sem resposta nas últimas 5 medições";
  const ONLY_THE_CONNECTION = ["Sua Internet está fora", "Sua Internet voltou"];

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

  describe("serviço que já estava fora do ar quando a conexão do servidor caiu", () => {
    beforeEach(async () => {
      await withInternetStrip();
      fixture.runProbe.mockImplementation(async (spec: { kind: string; host: string }) => githubHttpDown(spec));
    });

    /** O processo de antes: cinco rodadas com o HTTP do GitHub em 503, e a página já mostrou o GitHub fora do ar. */
    async function githubAlreadyDown(page: ReturnType<typeof openPage>): Promise<void> {
      await rounds(5);
      expect(await page.github()).toBe(STILL_DOWN);
    }

    it("sem reinício: a página só avisa da conexão, e o GitHub segue fora do ar sem aviso novo", async () => {
      const page = openPage();
      await githubAlreadyDown(page);
      link = "fora";
      await rounds(1);
      await page.see();
      link = "ok";
      await rounds(1);
      await page.see();

      expect(await githubAfterReturn(page)).toEqual([STILL_DOWN, STILL_DOWN, STILL_DOWN]);
      expect(page.notices).toEqual(ONLY_THE_CONNECTION);
    });

    it("reinício depois de 30 min parado, sem queda da conexão: nenhum aviso", async () => {
      const page = openPage();
      await githubAlreadyDown(page);
      restart();
      await ageChecks(30);

      expect(await githubAfterReturn(page)).toEqual([STILL_DOWN, STILL_DOWN, "DOWN HTTP: 3 falhas seguidas"]);
      expect(page.notices).toEqual([]);
    });

    it("falta de energia: o servidor volta 30 min depois com a conexão ainda fora, e ela volta em seguida", async () => {
      const page = openPage();
      await githubAlreadyDown(page);
      restart();
      await ageChecks(30);
      // O processo novo já sobe sem conexão: tudo falha, a queda é local e as medições são pausadas.
      link = "fora";
      await rounds(1);
      expect((await page.see()).services.find((s) => s.slug === "github")).toMatchObject({ measurementPaused: true });
      link = "ok";
      await rounds(1);
      await page.see();

      // O HTTP do GitHub respondeu 503 o tempo todo: ele não passa por "normalizado" e "degradado" até cair de novo.
      expect(await githubAfterReturn(page)).toEqual([STILL_DOWN, STILL_DOWN, "DOWN HTTP: 3 falhas seguidas"]);
      expect(page.notices).toEqual(ONLY_THE_CONNECTION);
    });

    it("o servidor reinicia com a pausa já gravada e a conexão ainda fora", async () => {
      const page = openPage();
      await githubAlreadyDown(page);
      link = "fora";
      await rounds(1);
      await page.see();
      // O banco guarda o GitHub como pausado; as últimas medições dele são as de antes da queda.
      restart();
      await ageChecks(30);
      await rounds(1);
      expect((await page.see()).connectivity.state).toBe("offline");
      link = "ok";
      await rounds(1);
      await page.see();

      expect(await githubAfterReturn(page)).toEqual([STILL_DOWN, STILL_DOWN, "DOWN HTTP: 3 falhas seguidas"]);
      expect(page.notices).toEqual(ONLY_THE_CONNECTION);
    });

    it("a conexão voltou enquanto o servidor estava parado", async () => {
      const page = openPage();
      await githubAlreadyDown(page);
      link = "fora";
      await rounds(1);
      await page.see();
      restart();
      await ageChecks(30);
      link = "ok";

      expect(await githubAfterReturn(page)).toEqual([STILL_DOWN, STILL_DOWN, "DOWN HTTP: 3 falhas seguidas"]);
      expect(page.notices).toEqual(ONLY_THE_CONNECTION);
    });

    it("um serviço que estava normal e cai de verdade depois da volta é anunciado", async () => {
      const page = openPage();
      await githubAlreadyDown(page);
      link = "fora";
      await rounds(1);
      await page.see();
      restart();
      await ageChecks(30);
      link = "ok";
      // O Discord, normal antes da queda, parou de responder enquanto o servidor estava parado.
      fixture.runProbe.mockImplementation(async (spec: { kind: string; host: string }) => (spec.host === "discord.com" ? { ok: false, latencyMs: null, error: "prazo esgotado", failedAt: "connect" } : githubHttpDown(spec)));
      await githubAfterReturn(page);

      expect(page.notices).toEqual([...ONLY_THE_CONNECTION, "Discord: degradado", "Discord: fora do ar"]);
    });
  });

  describe("veredito de antes da pausa refeito ao reiniciar: valem as medições mais novas do alvo, falhas ou não", () => {
    let githubHttp: "ok" | "503";

    beforeEach(async () => {
      await withInternetStrip();
      githubHttp = "ok";
      fixture.runProbe.mockImplementation(async (spec: { kind: string; host: string }) => (githubHttp === "503" ? githubHttpDown(spec) : answering()));
    });

    it("o GitHub respondia antes de cair: as medições boas, mais velhas, não apagam a queda", async () => {
      const page = openPage();
      await rounds(5);
      githubHttp = "503";
      await rounds(5);
      expect(await page.github()).toBe(STILL_DOWN);
      await outageWithRestart(page);

      expect(await githubAfterReturn(page)).toEqual([STILL_DOWN, STILL_DOWN, "DOWN HTTP: 3 falhas seguidas"]);
      expect(page.notices).toEqual(ONLY_THE_CONNECTION);
    });

    it("o GitHub tinha caído e já estava normal de novo: a queda antiga não vira o veredito de antes da pausa", async () => {
      const page = openPage();
      githubHttp = "503";
      await rounds(3);
      githubHttp = "ok";
      await rounds(5);
      expect(await page.github()).toBe("OK null");
      await outageWithRestart(page);
      // A primeira medição depois da volta falha: uma falha só, partindo de normal, não muda o card.
      githubHttp = "503";
      await rounds(1);

      expect(await page.github()).toBe("OK null");
      expect(page.notices).toEqual(ONLY_THE_CONNECTION);
    });
  });

  describe("serviço que estava lento quando a conexão do servidor caiu e para de responder depois da volta", () => {
    const SLOW = "DEGRADED TCP 443: latência 10,0× acima do normal (200 ms)";
    // O card não passa por "normal": segue degradado até a terceira falha, e a página só anuncia a queda de verdade.
    const SLOW_THEN_DOWN = [SLOW, "DEGRADED TCP 443: 2 falhas seguidas", "DOWN TCP 443: 3 falhas seguidas"];
    const ONE_REAL_OUTAGE = [...ONLY_THE_CONNECTION, "GitHub: fora do ar"];
    let githubTcp: "lento" | "mudo";

    beforeEach(async () => {
      await withInternetStrip();
      githubTcp = "lento";
      fixture.runProbe.mockImplementation(async (spec: { kind: string; host: string }) => {
        if (link === "fora" || spec.kind !== "TCP" || spec.host !== "github.com") return answering();
        return githubTcp === "lento" ? { ok: true, latencyMs: 200 } : { ok: false, latencyMs: null, error: "prazo esgotado", failedAt: "connect" };
      });
      // A linha de base do TCP do GitHub: 18 janelas de 5 min em 20 ms, a mais nova de 20 min atrás.
      const tcp = await db.probeTarget.findFirstOrThrow({ where: { key: "tcp", service: { slug: "github" } } });
      const window = 5 * 60_000;
      const newest = Math.floor(Date.now() / window) * window - 4 * window;
      await db.probeRollup.createMany({ data: Array.from({ length: 18 }, (_, i) => ({ targetId: tcp.id, vantage: "server", bucket: new Date(newest - i * window), samples: 10, failures: 0, p50Ms: 20, p95Ms: 22 })) });
    });

    /** O processo de antes: cinco rodadas com o TCP do GitHub em 200 ms, e a página já mostrou o GitHub degradado. */
    async function githubAlreadySlow(page: ReturnType<typeof openPage>): Promise<void> {
      await rounds(5);
      expect(await page.github()).toBe(SLOW);
    }

    it("sem reinício: a página avisa da conexão e, depois, só da queda de verdade", async () => {
      const page = openPage();
      await githubAlreadySlow(page);
      link = "fora";
      await rounds(1);
      await page.see();
      link = "ok";
      await rounds(1);
      await page.see();
      githubTcp = "mudo";

      expect(await githubAfterReturn(page)).toEqual(SLOW_THEN_DOWN);
      expect(page.notices).toEqual(ONE_REAL_OUTAGE);
    });

    it("a conexão voltou enquanto o servidor estava parado: os mesmos avisos, sem \"normalizado\" nem \"degradado\" falsos", async () => {
      const page = openPage();
      await githubAlreadySlow(page);
      await outageWithRestart(page);
      githubTcp = "mudo";

      expect(await githubAfterReturn(page)).toEqual(SLOW_THEN_DOWN);
      expect(page.notices).toEqual(ONE_REAL_OUTAGE);
    });

    it("o servidor reinicia com a pausa já gravada e a conexão ainda fora: os mesmos avisos", async () => {
      const page = openPage();
      await githubAlreadySlow(page);
      link = "fora";
      await rounds(1);
      await page.see();
      restart();
      await ageChecks(30);
      await rounds(1);
      expect((await page.see()).connectivity.state).toBe("offline");
      link = "ok";
      await rounds(1);
      await page.see();
      githubTcp = "mudo";

      expect(await githubAfterReturn(page)).toEqual(SLOW_THEN_DOWN);
      expect(page.notices).toEqual(ONE_REAL_OUTAGE);
    });
  });

  describe("marcação de pausa que o banco recusou", () => {
    const paused = async () => (await db.statusService.findMany({ orderBy: { position: "asc" } })).map((s) => s.measuredReason?.startsWith("Medições pausadas") ?? false);

    beforeEach(() => {
      fixture.runProbe.mockImplementation(async () => answering());
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    /** A conexão cai, e o banco recusa as duas tentativas de gravar o passo que decidiu isso. Devolve o espião das gravações. */
    async function loseConnectionWithRefusedWrite() {
      await rounds(2);
      link = "fora";
      const transaction = vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("database is locked")).mockRejectedValueOnce(new Error("database is locked"));
      await rounds(1);
      expect(getLocalConnectivity().state).toBe("offline");
      expect(await paused()).toEqual([false, false, false]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("medições não gravadas (o estado em memória segue valendo): database is locked"));
      return transaction;
    }

    it("a rodada seguinte, ainda sem conexão, grava a pausa em todos os serviços, uma vez só", async () => {
      const transaction = await loseConnectionWithRefusedWrite();
      await rounds(1);
      expect(await paused()).toEqual([true, true, true]);
      expect(transaction).toHaveBeenCalledTimes(3);
      // Depois de aceita, a pausa não é regravada a cada rodada sem conexão.
      await rounds(2);
      expect(transaction).toHaveBeenCalledTimes(3);
    });

    it("se a conexão volta antes de a pausa ser gravada, nada fica marcado como pausado", async () => {
      await loseConnectionWithRefusedWrite();
      link = "ok";
      await rounds(1);
      expect(getLocalConnectivity().state).toBe("ok");
      await rounds(2);
      expect(await paused()).toEqual([false, false, false]);
      expect((await serviceOf("github")).measuredStatus).toBe("OK");
    });
  });

  describe("relógio do sistema volta 1 h", () => {
    const SEC = 1_000;
    const MIN = 60 * SEC;
    const START = T0.getTime();
    /** 7 min de medições e o relógio volta 1 h: de 12:07 para 11:07. */
    const BACK = START + 7 * MIN - 60 * MIN;
    const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START);
    });

    /** Um passo do agendador a cada 5 s de relógio, de `from` até `to` (sem incluir). */
    async function run(from: number, to: number): Promise<void> {
      for (let t = from; t < to; t += 5 * SEC) {
        vi.setSystemTime(t);
        await runProbeTick();
      }
    }

    it("todos os alvos seguem medidos no ritmo de cada um, e as janelas de 5 min voltam a ser gravadas", async () => {
      const measured: { at: number; target: string }[] = [];
      fixture.runProbe.mockImplementation(async (spec: { kind: string; host: string }) => {
        measured.push({ at: Date.now(), target: `${spec.host} ${spec.kind}` });
        return answering();
      });
      await run(START, START + 7 * MIN);
      await run(BACK, BACK + 15 * MIN);

      // Maior espera de cada alvo depois da volta: até a primeira medição e entre duas seguidas.
      const waits = new Map<string, { last: number; longest: number }>();
      for (const { at, target } of measured.filter((m) => m.at < START)) {
        const wait = waits.get(target) ?? { last: BACK, longest: 0 };
        waits.set(target, { last: at, longest: Math.max(wait.longest, at - wait.last) });
      }
      expect(Array.from(waits, ([target, wait]) => [target, wait.longest / SEC]).sort()).toEqual([
        ["discord.com HTTP", 60], ["discord.com TCP", 30],
        ["github.com HTTP", 60], ["github.com TCP", 30],
        ["web.whatsapp.com HTTP", 60], ["web.whatsapp.com TCP", 30],
      ]);

      const rollups = await db.probeRollup.findMany({ where: { bucket: { lt: new Date(START) } }, select: { bucket: true }, orderBy: { bucket: "asc" } });
      expect([...new Set(rollups.map((r) => hhmm(r.bucket.getTime())))]).toEqual(["11:05", "11:10", "11:15"]);
    }, 60_000);

    it("uma falha que se repete volta a sair no log depois da volta, em vez de ficar calada até o relógio alcançar a hora antiga", async () => {
      // O banco recusa o catálogo a cada passo: a mesma falha, com a mesma mensagem.
      const refused = Promise.reject(new Error("database is locked"));
      refused.catch(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const logsAfterTickAt = async (time: number) => {
        state.__globalStatusSeed = refused;
        vi.setSystemTime(time);
        await runProbeTick();
        return error.mock.calls.length;
      };

      expect(await logsAfterTickAt(START)).toBe(1);
      // No mesmo instante e 5 s depois: a mesma mensagem não se repete dentro de um minuto.
      expect(await logsAfterTickAt(START)).toBe(1);
      expect(await logsAfterTickAt(START + 5 * SEC)).toBe(1);
      expect(await logsAfterTickAt(START + MIN)).toBe(2);
      expect(await logsAfterTickAt(START + MIN - 60 * MIN)).toBe(3);
      expect(await logsAfterTickAt(START + MIN - 60 * MIN + 5 * SEC)).toBe(3);
      expect(error).toHaveBeenLastCalledWith("[global-status] falha nas medições: database is locked", expect.any(Error));
    });
  });
});
