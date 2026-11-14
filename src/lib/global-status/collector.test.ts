import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry, CatalogTarget } from "./catalog";

// Prisma de verdade num banco temporário exclusivo: as exclusões em cascata são as do esquema, não as de um dublê.
const fixture = await vi.hoisted(async () => {
  const { createTempDb } = await import("./__fixtures__/temp-db");
  // O catálogo do teste: a mesma lista, trocada de conteúdo a cada caso.
  return { ...createTempDb("netinventory-status-seed-"), catalog: [] as CatalogEntry[] };
});

vi.mock("@/lib/prisma", () => ({ prisma: fixture.prisma }));
vi.mock("./catalog", async (importOriginal) => ({ ...(await importOriginal<typeof import("./catalog")>()), STATUS_CATALOG: fixture.catalog }));

import { dropTempDb, migrateTempDb } from "./__fixtures__/temp-db";
import { ensureCatalogSeeded, seedStatusCatalog } from "./collector";

const db = fixture.prisma;
const T0 = new Date("2026-11-14T12:00:00Z");

const web = (url: string, tcpHost?: string): CatalogTarget[] => [
  { key: "http", kind: "HTTP", host: new URL(url).hostname, url },
  { key: "tcp", kind: "TCP", host: tcpHost ?? new URL(url).hostname, port: 443 },
];

const GITHUB: CatalogEntry = { slug: "github", name: "GitHub", category: "DEV", sourceType: "STATUSPAGE", sourceUrl: "https://www.githubstatus.com", pageUrl: "https://www.githubstatus.com/", targets: web("https://github.com/robots.txt") };
const DISCORD: CatalogEntry = { slug: "discord", name: "Discord", category: "SOCIAL", sourceType: "STATUSPAGE", sourceUrl: "https://discordstatus.com", pageUrl: "https://discordstatus.com/", targets: web("https://discord.com/api/v10/gateway") };
const WHATSAPP: CatalogEntry = { slug: "whatsapp", name: "WhatsApp", category: "SOCIAL", sourceType: "NONE", sourceUrl: null, pageUrl: null, targets: web("https://web.whatsapp.com/robots.txt", "g.whatsapp.net") };

async function seed(...entries: CatalogEntry[]): Promise<void> {
  fixture.catalog.splice(0, fixture.catalog.length, ...entries);
  await seedStatusCatalog();
}

const serviceOf = (slug: string) => db.statusService.findUniqueOrThrow({ where: { slug }, include: { targets: { orderBy: { key: "asc" } } } });

async function targetOf(slug: string, key: string) {
  const service = await serviceOf(slug);
  return service.targets.find((target) => target.key === key)!;
}

/** Grava `count` medições e uma janela de 5 min para o alvo: o histórico que uma troca de endereço tem de apagar. */
async function addHistory(targetId: string, count = 3): Promise<void> {
  await db.probeCheck.createMany({ data: Array.from({ length: count }, (_, i) => ({ targetId, vantage: "server", at: new Date(T0.getTime() - (i + 1) * 30_000), ok: true, latencyMs: 20 + i })) });
  await db.probeRollup.create({ data: { targetId, vantage: "server", bucket: new Date(T0.getTime() - 10 * 60_000), samples: count, failures: 0, p50Ms: 21, p95Ms: 22 } });
}

const historyOf = async (targetId: string) => ({ checks: await db.probeCheck.count({ where: { targetId } }), rollups: await db.probeRollup.count({ where: { targetId } }) });

/** O que as medições deixam num alvo que está sendo medido. */
const MEASURED_TARGET = { status: "DOWN", statusReason: "3 falhas seguidas", lastCheckAt: T0, lastLatencyMs: 41.5, lastError: "prazo esgotado" };

beforeAll(async () => {
  await migrateTempDb(fixture);
});

beforeEach(async () => {
  // Apaga os serviços; alvos, medições, janelas, componentes e incidentes vão em cascata.
  await db.statusService.deleteMany();
  (globalThis as { __globalStatusSeed?: unknown }).__globalStatusSeed = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await dropTempDb(fixture);
});

describe("seedStatusCatalog", () => {
  it("primeira gravação: os serviços na ordem do catálogo e os alvos com o intervalo padrão de cada tipo", async () => {
    await seed(GITHUB, WHATSAPP, { ...DISCORD, targets: [{ key: "http", kind: "HTTP", host: "discord.com", url: "https://discord.com/api/v10/gateway", intervalSec: 120 }] });

    const services = await db.statusService.findMany({ orderBy: { position: "asc" }, include: { targets: { orderBy: { key: "asc" } } } });
    expect(services.map((s) => [s.slug, s.position, s.category, s.sourceType, s.enabled, s.status])).toEqual([
      ["github", 0, "DEV", "STATUSPAGE", true, "UNKNOWN"],
      ["whatsapp", 1, "SOCIAL", "NONE", true, "UNKNOWN"],
      ["discord", 2, "SOCIAL", "STATUSPAGE", true, "UNKNOWN"],
    ]);
    expect(services[0].targets.map((t) => [t.key, t.kind, t.host, t.url, t.port, t.intervalSec, t.enabled, t.status])).toEqual([
      ["http", "HTTP", "github.com", "https://github.com/robots.txt", null, 60, true, "UNKNOWN"],
      ["tcp", "TCP", "github.com", null, 443, 30, true, "UNKNOWN"],
    ]);
    // O host do TCP do WhatsApp é o do chat, e o intervalo informado no catálogo vale no lugar do padrão.
    expect(services[1].targets.map((t) => t.host)).toEqual(["web.whatsapp.com", "g.whatsapp.net"]);
    expect(services[2].targets.map((t) => t.intervalSec)).toEqual([120]);
  });

  it("gravar de novo o mesmo catálogo não mexe em \"enabled\" nem no que o coletor e as medições gravaram", async () => {
    await seed(GITHUB, WHATSAPP);
    const before = await serviceOf("github");
    await db.statusService.update({ where: { id: before.id }, data: { enabled: false, status: "DOWN", officialState: "OK", officialStatus: "All Systems Operational", measuredStatus: "DOWN", measuredReason: "HTTP: 3 falhas seguidas", latencyMs: 41.5, sourceVersion: "v1", lastCheckAt: T0, lastChangeAt: T0 } });
    await db.probeTarget.update({ where: { id: before.targets[0].id }, data: { enabled: false, ...MEASURED_TARGET } });
    await addHistory(before.targets[0].id);

    await seed(GITHUB, WHATSAPP);

    const after = await serviceOf("github");
    expect(after).toMatchObject({ id: before.id, enabled: false, status: "DOWN", officialState: "OK", officialStatus: "All Systems Operational", measuredStatus: "DOWN", measuredReason: "HTTP: 3 falhas seguidas", latencyMs: 41.5, sourceVersion: "v1", lastCheckAt: T0, lastChangeAt: T0 });
    expect(after.targets[0]).toMatchObject({ id: before.targets[0].id, enabled: false, ...MEASURED_TARGET });
    expect(await historyOf(before.targets[0].id)).toEqual({ checks: 3, rollups: 1 });
  });

  it("nome, categoria, páginas e ordem acompanham o catálogo", async () => {
    await seed(GITHUB, WHATSAPP);
    await seed(WHATSAPP, { ...GITHUB, name: "GitHub.com", category: "CLOUD", pageUrl: "https://status.github.com/" });
    expect(await serviceOf("github")).toMatchObject({ name: "GitHub.com", category: "CLOUD", pageUrl: "https://status.github.com/", position: 1 });
    expect(await serviceOf("whatsapp")).toMatchObject({ position: 0 });
  });

  describe("alvo que trocou de endereço sob a mesma chave", () => {
    it("perde as medições, as janelas e o estado, que eram do endereço antigo; o outro alvo do serviço fica como estava", async () => {
      await seed(GITHUB);
      const [http, tcp] = (await serviceOf("github")).targets;
      await db.probeTarget.updateMany({ where: { id: { in: [http.id, tcp.id] } }, data: MEASURED_TARGET });
      await addHistory(http.id);
      await addHistory(tcp.id, 5);

      await seed({ ...GITHUB, targets: web("https://github.com/.well-known/security.txt") });

      const moved = await targetOf("github", "http");
      expect(moved).toMatchObject({ id: http.id, url: "https://github.com/.well-known/security.txt", status: "UNKNOWN", statusReason: null, lastCheckAt: null, lastLatencyMs: null, lastError: null });
      expect(await historyOf(http.id)).toEqual({ checks: 0, rollups: 0 });
      // O TCP continua em github.com:443.
      expect(await targetOf("github", "tcp")).toMatchObject({ id: tcp.id, ...MEASURED_TARGET });
      expect(await historyOf(tcp.id)).toEqual({ checks: 5, rollups: 1 });
    });

    it.each([
      ["o host", { host: "api.github.com" }],
      ["a porta", { port: 8443 }],
      ["o tipo", { kind: "TLS" as const }],
    ])("trocar %s também é trocar de endereço", async (_what, change) => {
      await seed(GITHUB);
      const tcp = await targetOf("github", "tcp");
      await db.probeTarget.update({ where: { id: tcp.id }, data: MEASURED_TARGET });
      await addHistory(tcp.id);

      await seed({ ...GITHUB, targets: GITHUB.targets.map((target) => (target.key === "tcp" ? { ...target, ...change } : target)) });

      expect(await targetOf("github", "tcp")).toMatchObject({ id: tcp.id, ...change, status: "UNKNOWN", statusReason: null, lastCheckAt: null });
      expect(await historyOf(tcp.id)).toEqual({ checks: 0, rollups: 0 });
    });

    it("mudar só o intervalo não é trocar de endereço: o histórico e o estado ficam", async () => {
      await seed(GITHUB);
      const tcp = await targetOf("github", "tcp");
      await db.probeTarget.update({ where: { id: tcp.id }, data: MEASURED_TARGET });
      await addHistory(tcp.id);

      await seed({ ...GITHUB, targets: GITHUB.targets.map((target) => (target.key === "tcp" ? { ...target, intervalSec: 120 } : target)) });

      expect(await targetOf("github", "tcp")).toMatchObject({ id: tcp.id, intervalSec: 120, ...MEASURED_TARGET });
      expect(await historyOf(tcp.id)).toEqual({ checks: 3, rollups: 1 });
    });
  });

  describe("serviço que deixou de ter fonte oficial", () => {
    const official = { officialState: "DEGRADED", officialStatus: "Partially Degraded Service", sourceVersion: "2026-11-14T11:00:00Z", lastError: "HTTP 503 em discordstatus.com", status: "DEGRADED", measuredStatus: "OK", latencyMs: 30, lastChangeAt: new Date(T0.getTime() - 3_600_000) };

    async function seedDiscordWithOfficialData() {
      await seed(GITHUB, DISCORD);
      const discord = await serviceOf("discord");
      await db.statusService.update({ where: { id: discord.id }, data: official });
      await db.statusComponent.createMany({ data: [{ serviceId: discord.id, externalId: "c1", name: "API", status: "DEGRADED", updatedAt: T0 }, { serviceId: discord.id, externalId: "c2", name: "Gateway", status: "OK", updatedAt: T0 }] });
      const incident = { serviceId: discord.id, title: "API lenta", impact: "MINOR", state: "investigating", startedAt: T0 };
      await db.statusIncident.createMany({ data: [{ ...incident, origin: "OFFICIAL", externalId: "i1" }, { ...incident, origin: "DETECTED", externalId: "d1", title: "Detectado pelas medições" }] });
      return discord;
    }

    it("perde o que a fonte declarou (estado, frase, versão, erro, componentes e incidentes oficiais) e passa a valer pelo medido", async () => {
      const discord = await seedDiscordWithOfficialData();
      const github = await serviceOf("github");
      await db.statusComponent.create({ data: { serviceId: github.id, externalId: "g1", name: "Git Operations", status: "OK", updatedAt: T0 } });

      await seed(GITHUB, { ...DISCORD, sourceType: "NONE", sourceUrl: null, pageUrl: null });

      const after = await serviceOf("discord");
      expect(after).toMatchObject({ id: discord.id, sourceType: "NONE", sourceUrl: null, officialState: null, officialStatus: null, sourceVersion: null, lastError: null, status: "OK", measuredStatus: "OK", latencyMs: 30 });
      // O status do card mudou (de degradado para ok): a hora da mudança é a da gravação.
      expect(after.lastChangeAt!.getTime()).toBeGreaterThan(official.lastChangeAt.getTime());
      expect(await db.statusComponent.count({ where: { serviceId: discord.id } })).toBe(0);
      // Só os incidentes da fonte saem; o detectado pelas medições fica.
      expect((await db.statusIncident.findMany({ where: { serviceId: discord.id } })).map((incident) => incident.origin)).toEqual(["DETECTED"]);
      // O que é de outro serviço não é tocado.
      expect(await db.statusComponent.count({ where: { serviceId: github.id } })).toBe(1);
    });

    it("sem nenhuma medição ainda, o card fica \"Sem dados\"", async () => {
      const discord = await seedDiscordWithOfficialData();
      await db.statusService.update({ where: { id: discord.id }, data: { measuredStatus: null } });
      await seed(GITHUB, { ...DISCORD, sourceType: "NONE", sourceUrl: null, pageUrl: null });
      expect(await serviceOf("discord")).toMatchObject({ officialState: null, status: "UNKNOWN" });
    });

    it("um estado oficial que ficou gravado num serviço já sem fonte (catálogo trocado antes desta limpeza existir) também sai", async () => {
      await seed(WHATSAPP);
      const whatsapp = await serviceOf("whatsapp");
      await db.statusService.update({ where: { id: whatsapp.id }, data: { officialState: "DOWN", officialStatus: "Major outage", status: "DOWN", measuredStatus: "OK" } });
      await seed(WHATSAPP);
      expect(await serviceOf("whatsapp")).toMatchObject({ officialState: null, officialStatus: null, status: "OK" });
    });

    it("um serviço que nunca teve fonte não é tocado, e o que continua com fonte mantém o que ela declarou", async () => {
      await seed(GITHUB, WHATSAPP);
      const [github, whatsapp] = [await serviceOf("github"), await serviceOf("whatsapp")];
      await db.statusService.update({ where: { id: github.id }, data: { officialState: "DEGRADED", officialStatus: "Degraded", sourceVersion: "v7", status: "DEGRADED", lastChangeAt: T0 } });
      await db.statusService.update({ where: { id: whatsapp.id }, data: { status: "DOWN", measuredStatus: "DOWN", lastChangeAt: T0 } });

      await seed(GITHUB, WHATSAPP);

      expect(await serviceOf("github")).toMatchObject({ officialState: "DEGRADED", officialStatus: "Degraded", sourceVersion: "v7", status: "DEGRADED", lastChangeAt: T0 });
      expect(await serviceOf("whatsapp")).toMatchObject({ status: "DOWN", measuredStatus: "DOWN", lastChangeAt: T0 });
    });
  });

  describe("o que saiu do catálogo", () => {
    it("o serviço é apagado com tudo o que era dele; os outros ficam", async () => {
      await seed(GITHUB, DISCORD, WHATSAPP);
      const [github, discord] = [await serviceOf("github"), await serviceOf("discord")];
      await addHistory(discord.targets[0].id);
      await addHistory(github.targets[0].id);
      await db.statusComponent.create({ data: { serviceId: discord.id, externalId: "c1", name: "API", status: "OK", updatedAt: T0 } });
      await db.statusIncident.create({ data: { serviceId: discord.id, origin: "OFFICIAL", externalId: "i1", title: "API lenta", impact: "MINOR", state: "resolved", startedAt: T0 } });

      await seed(GITHUB, WHATSAPP);

      expect((await db.statusService.findMany({ orderBy: { position: "asc" } })).map((s) => s.slug)).toEqual(["github", "whatsapp"]);
      expect(await db.probeTarget.count({ where: { serviceId: discord.id } })).toBe(0);
      expect(await historyOf(discord.targets[0].id)).toEqual({ checks: 0, rollups: 0 });
      expect(await db.statusComponent.count()).toBe(0);
      expect(await db.statusIncident.count()).toBe(0);
      expect(await historyOf(github.targets[0].id)).toEqual({ checks: 3, rollups: 1 });
    });

    it("a chave de alvo que saiu de um serviço é apagada com o histórico; as outras ficam", async () => {
      await seed(GITHUB);
      const [http, tcp] = (await serviceOf("github")).targets;
      await addHistory(http.id);
      await addHistory(tcp.id);

      await seed({ ...GITHUB, targets: GITHUB.targets.filter((target) => target.key === "tcp") });

      expect((await serviceOf("github")).targets.map((target) => target.key)).toEqual(["tcp"]);
      expect(await historyOf(http.id)).toEqual({ checks: 0, rollups: 0 });
      expect(await historyOf(tcp.id)).toEqual({ checks: 3, rollups: 1 });
    });

    it("um serviço desabilitado que saiu do catálogo também é apagado", async () => {
      await seed(GITHUB, DISCORD);
      await db.statusService.update({ where: { slug: "discord" }, data: { enabled: false } });
      await seed(GITHUB);
      expect(await db.statusService.count()).toBe(1);
    });
  });

  it("grava tudo numa transação só: se uma parte falha, nada do catálogo novo fica pela metade", async () => {
    await seed(GITHUB, DISCORD);
    const discord = await serviceOf("discord");
    await addHistory(discord.targets[0].id);
    // O segundo serviço do catálogo novo é inválido (sem nome): o primeiro já teria sido gravado e o Discord, apagado.
    fixture.catalog.splice(0, fixture.catalog.length, { ...GITHUB, name: "GitHub novo" }, { ...WHATSAPP, name: null as never });
    await expect(seedStatusCatalog()).rejects.toThrow();

    expect(await serviceOf("github")).toMatchObject({ name: "GitHub" });
    expect((await db.statusService.findMany({ orderBy: { position: "asc" } })).map((s) => s.slug)).toEqual(["github", "discord"]);
    expect(await historyOf(discord.targets[0].id)).toEqual({ checks: 3, rollups: 1 });
  });
});

describe("ensureCatalogSeeded", () => {
  it("quem pede ao mesmo tempo espera a mesma gravação, e ela roda uma vez por processo", async () => {
    fixture.catalog.splice(0, fixture.catalog.length, GITHUB, WHATSAPP);
    const transaction = vi.spyOn(db, "$transaction");
    await Promise.all([ensureCatalogSeeded(), ensureCatalogSeeded(), ensureCatalogSeeded()]);
    await ensureCatalogSeeded();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(await db.statusService.count()).toBe(2);
  });

  it("uma gravação que falhou é tentada de novo no próximo pedido", async () => {
    fixture.catalog.splice(0, fixture.catalog.length, { ...GITHUB, name: null as never });
    await expect(ensureCatalogSeeded()).rejects.toThrow();
    fixture.catalog.splice(0, fixture.catalog.length, GITHUB);
    await expect(ensureCatalogSeeded()).resolves.toBeUndefined();
    expect(await db.statusService.count()).toBe(1);
  });
});
