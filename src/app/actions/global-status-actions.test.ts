import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Uma linha de StatusService como o Prisma a devolve (só o que as ações leem). */
interface ServiceRow {
  id: string;
  slug: string;
  name: string;
  category: string;
  enabled: boolean;
  sourceType: string;
  status: string;
  officialStatus: string | null;
  officialState: string | null;
  measuredStatus: string | null;
  measuredReason: string | null;
  latencyMs: number | null;
  pageUrl: string | null;
  lastCheckAt: Date | null;
  lastChangeAt: Date | null;
  lastError: string | null;
}

interface TargetRow {
  id: string;
  serviceId: string;
  key: string;
  kind: string;
  host: string;
  url: string | null;
  port: number | null;
  enabled: boolean;
  status: string;
  statusReason: string | null;
  lastCheckAt: Date | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  intervalSec: number;
}

interface RollupRow {
  targetId: string;
  bucket: Date;
  samples: number;
  failures: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** Uma medição crua (ProbeCheck), com o que a ponta viva do histórico lê. */
interface CheckRow {
  targetId: string;
  at: Date;
  ok: boolean;
  latencyMs: number | null;
  lossPct: number | null;
}

const db = vi.hoisted(() => ({
  services: [] as unknown[],
  targets: [] as unknown[],
  rollups: [] as unknown[],
  checks: [] as unknown[],
  /** Consultas feitas, pelo nome "modelo.operação", com o argumento de cada uma. */
  calls: [] as { op: string; args: unknown }[],
  /** Quando preenchido, a leitura das janelas falha com esta mensagem. */
  rollupError: null as string | null,
}));

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(async () => ({ id: "u1", role: "VIEWER" })),
  requirePermission: vi.fn(async () => ({ id: "u1", role: "ADMIN" })),
  ensureCatalogSeeded: vi.fn(async () => undefined),
  checkGlobalStatus: vi.fn(async () => undefined),
  runProbesNow: vi.fn(async () => undefined),
  getLocalConnectivity: vi.fn(async () => ({ state: "ok", since: null, reason: null })),
  defaultGateway: vi.fn(async () => "192.168.0.1" as string | null),
}));

vi.mock("@/lib/auth/server", () => ({ requireSession: mocks.requireSession, requirePermission: mocks.requirePermission }));
vi.mock("@/lib/global-status/collector", () => ({ ensureCatalogSeeded: mocks.ensureCatalogSeeded, checkGlobalStatus: mocks.checkGlobalStatus }));
vi.mock("@/lib/global-status/probe-runner", () => ({ getLocalConnectivity: mocks.getLocalConnectivity, runProbesNow: mocks.runProbesNow }));
vi.mock("@/lib/global-status/probes", () => ({ defaultGateway: mocks.defaultGateway }));
vi.mock("@/lib/prisma", () => {
  type Where = Record<string, unknown>;
  const record = <T>(op: string, answer: (args: { where?: Where }) => T) => async (args: { where?: Where } = {}) => {
    db.calls.push({ op, args });
    return answer(args);
  };
  const services = () => db.services as ServiceRow[];
  const targets = () => db.targets as TargetRow[];
  return {
    prisma: {
      statusService: {
        findMany: record("statusService.findMany", ({ where }) => {
          const not = (where?.sourceType as { not?: string } | undefined)?.not;
          return services().filter((s) => s.enabled && (not === undefined || s.sourceType !== not));
        }),
        findUnique: record("statusService.findUnique", ({ where }) => {
          const service = services().find((s) => s.slug === where?.slug);
          return service ? { ...service, components: [], incidents: [], targets: targets().filter((t) => t.serviceId === service.id && t.enabled) } : null;
        }),
      },
      statusComponent: { groupBy: record("statusComponent.groupBy", () => []), findMany: record("statusComponent.findMany", () => []) },
      statusIncident: { findMany: record("statusIncident.findMany", () => []) },
      probeTarget: {
        findMany: record("probeTarget.findMany", () =>
          targets()
            .filter((t) => t.enabled)
            .map((t) => ({ id: t.id, serviceId: t.serviceId, key: t.key, kind: t.kind, service: { slug: services().find((s) => s.id === t.serviceId)!.slug } })),
        ),
      },
      probeRollup: {
        findMany: record("probeRollup.findMany", ({ where = {} }) => {
          if (db.rollupError) throw new Error(db.rollupError);
          // A consulta de verdade sempre filtra pelos alvos e pelo começo do período; sem um dos dois o teste quebra aqui.
          const { targetId, bucket } = where as { targetId: { in: string[] }; bucket: { gte: Date } };
          return (db.rollups as RollupRow[]).filter((r) => targetId.in.includes(r.targetId) && r.bucket >= bucket.gte);
        }),
      },
      probeCheck: {
        findMany: record("probeCheck.findMany", ({ where = {} }) => {
          // A consulta da ponta viva sempre filtra pelos alvos e pelo trecho, com começo e fim.
          const { targetId, at } = where as { targetId: { in: string[] }; at: { gte: Date; lte: Date } };
          return (db.checks as CheckRow[]).filter((c) => targetId.in.includes(c.targetId) && c.at >= at.gte && c.at <= at.lte);
        }),
        findFirst: record("probeCheck.findFirst", ({ where }) => (db.checks as { targetId: string }[]).find((c) => c.targetId === where?.targetId) ?? null),
      },
    },
  };
});

import { getGlobalStatus, getGlobalStatusDetail, refreshGlobalStatusNow } from "./global-status-actions";

const T = Date.parse("2026-11-14T10:07:30Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

const service = (slug: string, extra: Partial<ServiceRow> = {}): ServiceRow => ({
  id: `id-${slug}`,
  slug,
  name: slug,
  category: "DEV",
  enabled: true,
  sourceType: "STATUSPAGE",
  status: "OK",
  officialStatus: "All Systems Operational",
  officialState: "OK",
  measuredStatus: "OK",
  measuredReason: null,
  latencyMs: 12.5,
  pageUrl: null,
  lastCheckAt: new Date(T - MIN),
  lastChangeAt: null,
  lastError: null,
  ...extra,
});

const target = (slug: string, key: string, kind: string, extra: Partial<TargetRow> = {}): TargetRow => ({
  id: `${slug}-${key}`,
  serviceId: `id-${slug}`,
  key,
  kind,
  host: "github.com",
  url: kind === "HTTP" ? "https://github.com/.well-known/security.txt" : null,
  port: kind === "TCP" ? 443 : null,
  enabled: true,
  status: "OK",
  statusReason: null,
  lastCheckAt: new Date(T - 30_000),
  lastLatencyMs: 12.5,
  lastError: null,
  intervalSec: 30,
  ...extra,
});

/** Janelas de 5 min da última hora para um alvo: 10 medições cada, sem falhas. */
const hourOfRollups = (targetId: string): RollupRow[] =>
  Array.from({ length: 12 }, (_, i) => ({ targetId, bucket: new Date(Math.floor((T - HOUR) / (5 * MIN)) * 5 * MIN + i * 5 * MIN), samples: 10, failures: 0, p50Ms: 12, p95Ms: 20 }));

const count = (op: string) => db.calls.filter((call) => call.op === op).length;
const at = (ms: number) => vi.spyOn(Date, "now").mockReturnValue(ms);
const history = globalThis as typeof globalThis & { __globalStatusHistory?: unknown };

beforeEach(() => {
  db.services = [service("github"), service("whatsapp", { category: "SOCIAL", sourceType: "NONE", officialStatus: null, officialState: null, status: "DOWN", measuredStatus: "DOWN", measuredReason: "TCP 443: 3 falhas seguidas", latencyMs: null })];
  db.targets = [target("github", "http", "HTTP"), target("github", "tcp", "TCP"), target("whatsapp", "tcp", "TCP", { host: "g.whatsapp.net", status: "DOWN" })];
  db.rollups = [...hourOfRollups("github-tcp"), ...hourOfRollups("github-http")];
  db.checks = [];
  db.calls = [];
  db.rollupError = null;
  history.__globalStatusHistory = undefined;
  vi.clearAllMocks();
  // clearAllMocks não desfaz um mockResolvedValue: sem isto, a conexão "offline" de um teste valeria nos seguintes.
  mocks.getLocalConnectivity.mockResolvedValue({ state: "ok", since: null, reason: null });
  at(T);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  history.__globalStatusHistory = undefined;
});

describe("getGlobalStatus com as medições ligadas", () => {
  it("devolve todos os serviços habilitados, com o que as medições gravaram e o histórico de 24 h", async () => {
    const data = await getGlobalStatus();
    expect(mocks.requireSession).toHaveBeenCalledTimes(1);
    expect(mocks.ensureCatalogSeeded).toHaveBeenCalledTimes(1);
    expect(data.probes).toBe(true);
    expect(db.calls.find((call) => call.op === "statusService.findMany")!.args).toMatchObject({ where: { enabled: true } });
    expect(data.services.map((s) => s.slug)).toEqual(["github", "whatsapp"]);

    const [github, whatsapp] = data.services;
    expect(github).toMatchObject({ status: "OK", hasSource: true, officialState: "OK", measuredStatus: "OK", measuredReason: null, measurementPaused: false, latencyMs: 12.5, uptime24h: 100 });
    expect(github.spark).not.toBeNull();
    expect(whatsapp).toMatchObject({ status: "DOWN", hasSource: false, officialState: null, measuredStatus: "DOWN", measuredReason: "TCP 443: 3 falhas seguidas", measurementPaused: false, latencyMs: null, uptime24h: null, spark: null });
    expect(data.connectivity).toEqual({ state: "ok", since: null, reason: null });
  });

  it("marca o serviço cujas medições estão paradas pela conexão local", async () => {
    db.services = [service("github", { measuredStatus: "UNKNOWN", measuredReason: "Medições pausadas: sem Internet neste servidor.", latencyMs: null })];
    const offline = { state: "offline", since: new Date(T - MIN).toISOString(), reason: "O gateway 192.168.0.1 não responde." };
    mocks.getLocalConnectivity.mockResolvedValue(offline as never);
    const data = await getGlobalStatus();
    expect(data.services[0]).toMatchObject({ status: "OK", measuredStatus: "UNKNOWN", measurementPaused: true, latencyMs: null });
    expect(data.connectivity).toEqual(offline);
  });

  it("um \"Sem dados\" medido que não é pausa não é marcado", async () => {
    db.services = [service("github", { measuredStatus: "UNKNOWN", measuredReason: "Ping: sem permissão para medir neste servidor" })];
    expect((await getGlobalStatus()).services[0].measurementPaused).toBe(false);
  });
});

describe("histórico das medições: uma leitura por minuto", () => {
  it("consultas dentro do mesmo minuto dividem a leitura; depois dele o banco é lido de novo", async () => {
    await Promise.all([getGlobalStatus(), getGlobalStatus(), getGlobalStatus()]);
    expect(count("probeRollup.findMany")).toBe(1);

    at(T + MIN - 1);
    await getGlobalStatus();
    expect(count("probeRollup.findMany")).toBe(1);

    at(T + MIN);
    await getGlobalStatus();
    expect(count("probeRollup.findMany")).toBe(2);
  });

  it("se o relógio do sistema voltar, o histórico é lido de novo em vez de ficar parado até a hora antiga", async () => {
    await getGlobalStatus();
    expect(count("probeRollup.findMany")).toBe(1);

    // O relógio voltou uma hora: a leitura guardada ficou datada do futuro.
    at(T - HOUR);
    await getGlobalStatus();
    expect(count("probeRollup.findMany")).toBe(2);

    // Daí em diante vale o minuto de sempre, contado da hora nova.
    at(T - HOUR + 30_000);
    await getGlobalStatus();
    expect(count("probeRollup.findMany")).toBe(2);
    at(T - HOUR + MIN);
    await getGlobalStatus();
    expect(count("probeRollup.findMany")).toBe(3);
  });

  it("\"Atualizar agora\" exige permissão, consulta e mede, e descarta a leitura guardada", async () => {
    await getGlobalStatus();
    await refreshGlobalStatusNow();
    expect(mocks.requirePermission).toHaveBeenCalledWith("network.operate");
    expect(mocks.checkGlobalStatus).toHaveBeenCalledWith(true);
    expect(mocks.runProbesNow).toHaveBeenCalledTimes(1);

    await getGlobalStatus();
    expect(count("probeRollup.findMany")).toBe(2);
  });

  it("a leitura guardada é descartada mesmo se a atualização falhar", async () => {
    await getGlobalStatus();
    mocks.runProbesNow.mockRejectedValueOnce(new Error("banco ocupado"));
    await expect(refreshGlobalStatusNow()).rejects.toThrow("banco ocupado");
    await getGlobalStatus();
    expect(count("probeRollup.findMany")).toBe(2);
  });

  it("sem conseguir ler o histórico, a página ainda recebe o status; a próxima consulta tenta de novo", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    db.rollupError = "database is locked";
    const data = await getGlobalStatus();
    expect(data.services[0]).toMatchObject({ slug: "github", status: "OK", uptime24h: null, spark: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("database is locked"));

    db.rollupError = null;
    const again = await getGlobalStatus();
    expect(count("probeRollup.findMany")).toBe(2);
    expect(again.services[0].uptime24h).toBe(100);
  });
});

describe("histórico das medições: janelas gravadas e ponta viva", () => {
  // T é 10:07:30: a janela em andamento começou às 10:05 e a anterior a ela, às 10:00.
  const OPEN = Date.parse("2026-11-14T10:05:00Z");
  const PREVIOUS = OPEN - 5 * MIN;
  const rollup = (bucket: number, failures = 0): RollupRow => ({ targetId: "github-tcp", bucket: new Date(bucket), samples: 10, failures, p50Ms: 12, p95Ms: 20 });
  /** `count` medições do TCP do GitHub a partir de `from`, uma a cada 30 s; as `failures` primeiras falham. */
  const checks = (from: number, count: number, failures = 0): CheckRow[] =>
    Array.from({ length: count }, (_, i) => ({ targetId: "github-tcp", at: new Date(from + i * 30_000), ok: i >= failures, latencyMs: i >= failures ? 12 : null, lossPct: null }));
  /** O que a página mostra do TCP do GitHub: disponibilidade de 24 h e falhas somadas no gráfico. */
  const tcp = async () => {
    const target = (await getGlobalStatusDetail("github")).targets.find((t) => t.key === "tcp")!;
    return { uptime24h: target.uptime24h, failures: target.spark ? target.spark.fail.reduce((sum, n) => sum + n, 0) : null };
  };
  const tailQuery = () => (db.calls.find((call) => call.op === "probeCheck.findMany")!.args as { where: { at: unknown } }).where.at;

  it("as medições ainda sem janela gravada entram pela ponta viva", async () => {
    // A janela das 10:00 fechou há 2 min 30 s e ainda não foi gravada.
    db.rollups = [rollup(PREVIOUS - 5 * MIN)];
    db.checks = [...checks(PREVIOUS, 10, 2), ...checks(OPEN, 5, 1)];
    // 10 da janela gravada + 10 + 5 cruas, com 3 falhas.
    expect(await tcp()).toEqual({ uptime24h: 88, failures: 3 });
    expect(tailQuery()).toEqual({ gte: new Date(PREVIOUS), lte: new Date(T) });
  });

  it("a janela anterior à que está em andamento vale pelas medições cruas mesmo já gravada, sem contar duas vezes", async () => {
    db.rollups = [rollup(PREVIOUS - 5 * MIN), rollup(PREVIOUS, 2)];
    db.checks = [...checks(PREVIOUS, 10, 2), ...checks(OPEN, 5, 1)];
    expect(await tcp()).toEqual({ uptime24h: 88, failures: 3 });
    expect(tailQuery()).toEqual({ gte: new Date(PREVIOUS), lte: new Date(T) });
  });

  it("com as janelas atrasadas, a ponta viva cobre no máximo os últimos 30 min", async () => {
    db.rollups = [rollup(OPEN - 2 * HOUR)];
    db.checks = [...checks(OPEN - HOUR, 10, 10), ...checks(OPEN - 30 * MIN, 10, 1)];
    // As medições de 1 h atrás (todas falhas) ficam de fora até o agendador gravar as janelas delas.
    expect(await tcp()).toEqual({ uptime24h: 95, failures: 1 });
    expect(tailQuery()).toEqual({ gte: new Date(OPEN - 30 * MIN), lte: new Date(T) });
  });

  describe("depois de o relógio do sistema voltar 1 h", () => {
    it("as janelas gravadas com data do futuro não seguram a ponta viva: as medições novas aparecem", async () => {
      // Instalação nova: só existem as janelas gravadas antes da volta, agora datadas de daqui a 45 min ou mais.
      db.rollups = [rollup(OPEN + 45 * MIN), rollup(OPEN + 50 * MIN), rollup(OPEN + 55 * MIN)];
      // Medidas depois da volta (2 falhas em 4) e, do futuro, as de antes da volta que ainda não tinham janela.
      db.checks = [...checks(OPEN + 30_000, 4, 2), ...checks(OPEN + HOUR, 5)];
      const seen = await tcp();
      expect(seen.failures).toBe(2);
      // 30 medições nas janelas de antes da volta e 4 depois dela, com 2 falhas.
      expect(seen.uptime24h).toBeCloseTo((1 - 2 / 34) * 100, 6);
      expect(tailQuery()).toEqual({ gte: new Date(OPEN - 30 * MIN), lte: new Date(T) });
    });

    it("a janela em andamento e a anterior valem pelas medições cruas, não pelas janelas gravadas antes da volta", async () => {
      // O servidor já media nesta hora, que agora se repete: há janela gravada para cada 5 min, até 55 min à frente.
      const before = Array.from({ length: 10 }, (_, i) => rollup(PREVIOUS - (i + 1) * 5 * MIN));
      const ahead = Array.from({ length: 11 }, (_, i) => rollup(OPEN + (i + 1) * 5 * MIN));
      db.rollups = [...before, rollup(PREVIOUS), rollup(OPEN), ...ahead];
      db.checks = [
        // 10:00 a 10:05: as 10 da primeira passagem (ok) e as 10 da segunda, com 4 falhas.
        ...checks(PREVIOUS, 10), ...checks(PREVIOUS + 1_000, 10, 4),
        // 10:05 em diante: 5 da primeira passagem e 5 da segunda, com 1 falha; depois de agora, só da primeira.
        ...checks(OPEN, 5), ...checks(OPEN + 1_000, 5, 1), ...checks(T + 30_000, 5),
      ];
      const seen = await tcp();
      // As 4 falhas da janela anterior não estão na janela gravada antes da volta (0 falhas): só aparecem pelas cruas.
      expect(seen.failures).toBe(5);
      // 100 medições nas janelas de antes, 110 nas datadas do futuro, 20 + 10 cruas, com 5 falhas.
      expect(seen.uptime24h).toBeCloseTo((1 - 5 / 240) * 100, 6);
    });

    it("a janela em andamento já gravada antes da volta não esconde as que estão atrasadas", async () => {
      // A das 10:05 está gravada desde a primeira passagem por esta hora; as de 09:50 a 10:00 ainda não foram gravadas.
      db.rollups = [rollup(PREVIOUS - 15 * MIN), rollup(OPEN)];
      db.checks = [...checks(PREVIOUS - 10 * MIN, 10, 3), ...checks(PREVIOUS, 10), ...checks(OPEN, 5, 1)];
      const seen = await tcp();
      expect(seen.failures).toBe(4);
      // 10 medições na janela das 09:45 e 25 cruas, com 4 falhas.
      expect(seen.uptime24h).toBeCloseTo((1 - 4 / 35) * 100, 6);
      // A ponta viva começa logo depois da última janela fechada que está gravada, a das 09:45.
      expect(tailQuery()).toEqual({ gte: new Date(PREVIOUS - 10 * MIN), lte: new Date(T) });
    });
  });
});

describe("com as medições desligadas (GLOBAL_STATUS_PROBES=off)", () => {
  beforeEach(() => {
    vi.stubEnv("GLOBAL_STATUS_PROBES", "off");
  });

  it("serve só os serviços com fonte oficial, sem ler o histórico", async () => {
    const data = await getGlobalStatus();
    expect(data.probes).toBe(false);
    expect(db.calls.find((call) => call.op === "statusService.findMany")!.args).toMatchObject({ where: { enabled: true, sourceType: { not: "NONE" } } });
    expect(data.services.map((s) => s.slug)).toEqual(["github"]);
    expect(count("probeTarget.findMany")).toBe(0);
    expect(count("probeRollup.findMany")).toBe(0);
    expect(count("probeCheck.findMany")).toBe(0);
    expect(data.services[0]).toMatchObject({ uptime24h: null, spark: null });
  });

  it("não serve nada do que as medições gravaram, mesmo que ainda esteja no banco: o status é só o oficial", async () => {
    // Estado de antes de desligar: medido fora do ar, provedor dizendo que está normal.
    db.services = [service("github", { status: "DOWN", measuredStatus: "DOWN", measuredReason: "HTTP: 3 falhas seguidas", latencyMs: 480 })];
    const [github] = (await getGlobalStatus()).services;
    expect(github).toMatchObject({ status: "OK", officialState: "OK", measuredStatus: null, measuredReason: null, measurementPaused: false, latencyMs: null });
  });

  it("o detalhe não lista alvos nem lê medições", async () => {
    db.checks = [{ targetId: "github-tcp", at: new Date(T - 30_000), ok: true }];
    const detail = await getGlobalStatusDetail("github");
    expect(detail.targets).toEqual([]);
    expect(count("probeCheck.findFirst")).toBe(0);
    expect(count("probeRollup.findMany")).toBe(0);
    expect(mocks.defaultGateway).not.toHaveBeenCalled();
  });

  it.each(["OFF", " off ", "Off"])("aceita %j como desligado", async (value) => {
    vi.stubEnv("GLOBAL_STATUS_PROBES", value);
    expect((await getGlobalStatus()).probes).toBe(false);
  });

  it.each(["", "on", "0", "false"])("qualquer outro valor (%j) deixa ligado", async (value) => {
    vi.stubEnv("GLOBAL_STATUS_PROBES", value);
    expect((await getGlobalStatus()).probes).toBe(true);
  });
});

describe("getGlobalStatusDetail com as medições ligadas", () => {
  it("lista os alvos do serviço na ordem do catálogo, com a última medição e o resumo de 24 h", async () => {
    db.checks = [
      { targetId: "github-http", at: new Date(T - 20_000), ok: true, latencyMs: 40, httpStatus: 200, dnsMs: 3, connectMs: 11, tlsMs: 14, ttfbMs: 40, totalMs: 68, lossPct: null, jitterMs: null, certDays: 71 },
      { targetId: "github-tcp", at: new Date(T - 10_000), ok: true, latencyMs: 12, httpStatus: null, dnsMs: 2, connectMs: 12, tlsMs: null, ttfbMs: null, totalMs: 14, lossPct: null, jitterMs: null, certDays: null },
    ];
    // Gravados fora de ordem: quem ordena é o catálogo (HTTP antes do TCP).
    db.targets = [target("github", "tcp", "TCP"), target("github", "http", "HTTP")];
    const detail = await getGlobalStatusDetail("github");
    expect(detail.targets.map((t) => [t.key, t.label, t.address])).toEqual([
      ["http", "HTTP", "https://github.com/.well-known/security.txt"],
      ["tcp", "TCP 443", "github.com:443"],
    ]);
    expect(detail.targets[0]).toMatchObject({ status: "OK", uptime24h: 100, p50Ms: 12, last: { ok: true, httpStatus: 200, ttfbMs: 40, certDays: 71 } });
    expect(detail.targets[1].last).toMatchObject({ connectMs: 12, at: new Date(T - 10_000).toISOString() });
    expect(detail.targets[1].spark).not.toBeNull();
    // Nenhum alvo é o gateway padrão: a descoberta não é chamada.
    expect(mocks.defaultGateway).not.toHaveBeenCalled();
  });

  it("serviço desconhecido ou identificador vazio: nada a listar, sem erro", async () => {
    expect(await getGlobalStatusDetail("nao-existe")).toEqual({ components: [], incidents: [], targets: [] });
    expect(await getGlobalStatusDetail("")).toEqual({ components: [], incidents: [], targets: [] });
    expect(await getGlobalStatusDetail(42 as never)).toEqual({ components: [], incidents: [], targets: [] });
  });
});
