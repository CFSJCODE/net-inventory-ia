import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnrichedHop } from "./route-enrich";
import type { Cable } from "./subsea-cables";
import type { TraceResult } from "./traceroute";

// Prisma de verdade num banco temporário; o traceroute, o DNS e o mapa de cabos são dublês.
const fixture = await vi.hoisted(async () => {
  const { createTempDb } = await import("./__fixtures__/temp-db");
  return { ...createTempDb("netinventory-status-routes-"), trace: null as TraceResult | null, hops: [] as EnrichedHop[], cables: [] as Cable[] };
});

vi.mock("@/lib/prisma", () => ({ prisma: fixture.prisma }));
vi.mock("./traceroute", async (importOriginal) => ({ ...(await importOriginal<typeof import("./traceroute")>()), traceRoute: vi.fn(async () => fixture.trace), traceBest: vi.fn(async () => fixture.trace), traceAllModes: vi.fn(async () => fixture.trace) }));
vi.mock("./route-enrich", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./route-enrich")>()),
  enrichHops: vi.fn(async () => fixture.hops),
  originOf: vi.fn(async () => ({ asn: 15169, country: "US" })),
  asNameOf: vi.fn(async () => "GOOGLE"),
}));
vi.mock("./subsea-cables", async (importOriginal) => ({ ...(await importOriginal<typeof import("./subsea-cables")>()), brazilCables: vi.fn(async () => fixture.cables) }));
vi.mock("./ix-prefixes", async (importOriginal) => ({ ...(await importOriginal<typeof import("./ix-prefixes")>()), refreshIxPrefixes: vi.fn(async () => null) }));
vi.mock("./upstreams", async (importOriginal) => ({ ...(await importOriginal<typeof import("./upstreams")>()), refreshUpstreams: vi.fn(async () => null) }));
vi.mock("./probe-runner", () => ({ getLocalConnectivity: vi.fn(async () => ({ state: "ok", since: null, reason: null })) }));

import { dropTempDb, migrateTempDb } from "./__fixtures__/temp-db";
import { cityFromHostname, distanceKm } from "./route-cities";
import { cymruOriginName, isPrivateIp, parseCymruAsName, parseCymruOrigin } from "./route-enrich";
import { asPathOf, biggestStep, inferRoute, ownerMatches, rankCables, type RouteInput } from "./route-infer";
import { analyzeAgentRoutes, ROUTE_INTERVAL_MS, cleanupRoutes, destinationRtt, nextDue, routesEnabled, runRouteTick, traceAndStore } from "./route-runner";
import { buildCables, parseLengthKm } from "./subsea-cables";
import { monthlyRoutes, rollupRouteDays } from "./route-daily";

const db = fixture.prisma;

// Cabos de teste (formato do resumo guardado, coordenadas aproximadas dos pontos de chegada).
const FORTALEZA_L = { id: "fortaleza-brazil", name: "Fortaleza, Brazil", country: "BR", lat: -3.72, lon: -38.54 };
const SANTOS_L = { id: "santos-brazil", name: "Santos, Brazil", country: "BR", lat: -23.96, lon: -46.33 };
const HOLLYWOOD_L = { id: "hollywood-fl-united-states", name: "Hollywood, FL, United States", country: "US", lat: 26.01, lon: -80.15 };
const BOCA_L = { id: "boca-raton-fl-united-states", name: "Boca Raton, FL, United States", country: "US", lat: 26.37, lon: -80.13 };
const SINES_L = { id: "sines-portugal", name: "Sines, Portugal", country: "PT", lat: 37.96, lon: -8.87 };
const CABLES: Cable[] = [
  { id: "amx-1", name: "AMX-1", owners: "America Movil", lengthKm: 17800, rfsYear: 2014, landings: [FORTALEZA_L, HOLLYWOOD_L] },
  { id: "monet", name: "Monet", owners: "Algar Telecom, Angola Cables, Antel Uruguay, Google", lengthKm: 10556, rfsYear: 2017, landings: [FORTALEZA_L, SANTOS_L, BOCA_L] },
  { id: "ellalink", name: "EllaLink", owners: "EllaLink", lengthKm: 6200, rfsYear: 2021, landings: [FORTALEZA_L, SINES_L] },
];

function hop(ttl: number, ip: string | null, rttMs: number | null, extra: Partial<EnrichedHop> = {}): EnrichedHop {
  return { ttl, ip, rttMs, altIps: [], asn: null, asName: null, registryCountry: null, rdns: null, city: null, role: null, ...extra };
}
const withName = (ttl: number, ip: string, rttMs: number, rdns: string, asn: number, asName: string, registryCountry = "BR") =>
  hop(ttl, ip, rttMs, { rdns, asn, asName, registryCountry, city: cityFromHostname(rdns) });

const MIAMI_ROUTE: EnrichedHop[] = [
  hop(1, "192.168.0.1", 0.8),
  hop(2, "100.64.0.1", 6),
  withName(3, "177.1.1.1", 9, "xe-1-0.gru1.claro.net.br", 28573, "CLARO S.A."),
  withName(4, "200.230.1.1", 38, "ae2.for.embratel.net.br", 4230, "CLARO NXT TELECOMUNICACOES LTDA"),
  hop(5, null, null),
  withName(6, "200.230.9.9", 104, "ae9.mia.embratel.net.br", 4230, "CLARO NXT TELECOMUNICACOES LTDA"),
  withName(7, "142.250.1.1", 107, "mia09s12-in-f14.1e100.net", 15169, "GOOGLE", "US"),
];

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return { hops: MIAMI_ROUTE, destRttMs: 107, destAsn: 15169, destAsName: "GOOGLE", destRegistryCountry: "US", isp: { asn: 28573, name: "CLARO S.A." }, cables: CABLES, ...overrides };
}

describe("rota: cidade pelo nome reverso", () => {
  it("reconhece código de aeroporto, CLLI e nome por extenso, com números no fim", () => {
    expect(cityFromHostname("gru09s12-in-f14.1e100.net")?.name).toBe("São Paulo");
    expect(cityFromHostname("ae-1.r20.miamfl02.us.bb.gin.ntt.net")?.name).toBe("Miami");
    expect(cityFromHostname("mia-b2-link.ip.twelve99.net")?.name).toBe("Miami");
    expect(cityFromHostname("be10.core.fortaleza.claro.net.br")?.name).toBe("Fortaleza");
    expect(cityFromHostname("lis1.example.pt")?.country).toBe("PT");
  });

  it("não confunde palavras comuns nem o domínio da operadora", () => {
    expect(cityFromHostname("group-router.example.com")).toBeNull();
    expect(cityFromHostname("core1.bb.net")).toBeNull();
    // "mia" no domínio (as duas últimas partes) não conta.
    expect(cityFromHostname("router.mia.com")).toBeNull();
    expect(cityFromHostname(null)).toBeNull();
  });

  it("distância de Fortaleza a Miami em linha reta (~5.550 km)", () => {
    const km = distanceKm({ lat: -3.72, lon: -38.54 }, { lat: 25.76, lon: -80.19 });
    expect(km).toBeGreaterThan(5450);
    expect(km).toBeLessThan(5650);
  });
});

describe("rota: ASN pelo Team Cymru", () => {
  it("monta o nome da consulta para IPv4 e IPv6", () => {
    expect(cymruOriginName("8.8.4.4")).toBe("4.4.8.8.origin.asn.cymru.com");
    expect(cymruOriginName("2001:db8::1")).toBe(`${"1000000000000000000000008bd01002".split("").join(".")}.origin6.asn.cymru.com`);
    expect(cymruOriginName("nome")).toBeNull();
  });

  it("lê origem e nome do ASN", () => {
    expect(parseCymruOrigin("28573 4230 | 177.0.0.0/14 | BR | lacnic | 2009-02-11")).toEqual({ asn: 28573, country: "BR" });
    expect(parseCymruOrigin("NA | 1.2.3.0/24 | | |")).toEqual({ asn: null, country: null });
    expect(parseCymruAsName("28573 | BR | lacnic | 2005-10-18 | CLARO S.A., BR")).toBe("CLARO S.A.");
    expect(parseCymruAsName("15169 | US | arin | 2000-03-30 | GOOGLE, US")).toBe("GOOGLE");
  });

  it("endereços privados, CGNAT e loopback ficam sem consulta", () => {
    for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.0.1", "100.64.10.1", "127.0.0.1", "169.254.1.1", "fd00::1", "fe80::1"]) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "100.128.0.1", "172.32.0.1", "2804:14c::1"]) expect(isPrivateIp(ip), ip).toBe(false);
  });
});

describe("rota: degrau da travessia", () => {
  it("usa o piso do RTT: um salto lento para responder não vira degrau", () => {
    const step = biggestStep([{ rttMs: 5 }, { rttMs: 90 }, { rttMs: 8 }, { rttMs: 10 }]);
    expect(step!.stepMs).toBeLessThan(10);
  });

  it("acha o degrau da travessia e o salto antes dele", () => {
    const step = biggestStep([{ rttMs: 5 }, { rttMs: 38 }, { rttMs: 104 }, { rttMs: 107 }]);
    expect(step).toEqual({ index: 1, stepMs: 66 });
  });
});

describe("rota: inferência", () => {
  it("abaixo de 30 ms é servido no Brasil, pelo limite físico", () => {
    const r = inferRoute(input({ hops: MIAMI_ROUTE.slice(0, 3), destRttMs: 12, destAsn: 64500 }));
    expect(r.verdict).toBe("DOMESTIC");
    expect(r.destCountry).toBe("BR");
    expect(r.summary).toContain("São Paulo");
    expect(r.summary).toContain("1.200 km");
  });

  it("destino com o ASN da operadora é cache dentro da operadora", () => {
    const r = inferRoute(input({ destAsn: 28573, destRttMs: 4 }));
    expect(r.verdict).toBe("OPERATOR_CACHE");
    expect(r.summary).toContain("CLARO S.A. (AS28573)");
  });

  it("entre 30 e 60 ms sem roteador de fora fica indefinido, mesmo com um degrau (o Brasil é grande)", () => {
    const r = inferRoute(input({ hops: [hop(1, "192.168.0.1", 1), hop(2, "177.1.1.1", 44)], destRttMs: 45, destAsn: 1 }));
    expect(r.verdict).toBe("UNDETERMINED");
    expect(r.cable).toBeNull();
  });

  it("Fortaleza → Miami pela rede da Claro: AMX-1 com confiança alta", () => {
    const r = inferRoute(input());
    expect(r).toMatchObject({ verdict: "INTERNATIONAL", destCountry: "US", cable: { id: "amx-1", name: "AMX-1" }, confidence: "HIGH", exitTtl: 4, entryTtl: 6, stepMs: 66 });
    expect(r.candidates.map((c) => c.name)).toEqual(["AMX-1", "Monet"]);
    expect(r.summary).toContain("Sai do Brasil por Fortaleza e chega em Miami (Estados Unidos)");
    expect(r.summary).toContain("Cabo provável: AMX-1 (confiança alta; outros possíveis: Monet)");
  });

  it("sem dono coincidente, os dois cabos empatam: confiança média", () => {
    const hops = MIAMI_ROUTE.map((h) => ({ ...h, asName: h.asName ? "OUTRA REDE" : null }));
    const r = inferRoute(input({ hops, destAsName: "OUTRA REDE" }));
    expect(r.confidence).toBe("MEDIUM");
    expect(r.candidates.map((c) => c.score)).toEqual([4, 4]);
  });

  it("só o país do registro (sem nomes reversos): confiança baixa", () => {
    const hops = MIAMI_ROUTE.map((h) => ({ ...h, rdns: null, city: null }));
    const r = inferRoute(input({ hops }));
    expect(r.verdict).toBe("INTERNATIONAL");
    expect(r.destCountry).toBe("US");
    expect(r.confidence).toBe("LOW");
  });

  it("a física descarta o cabo que não cabe no tempo medido", () => {
    // 50 ms até o destino: nenhuma ponta Brasil–EUA (≥ 5.900 km, ≥ 59 ms) cabe.
    const hops = [hop(1, "192.168.0.1", 1), withName(2, "177.1.1.1", 5, "gru1.claro.net.br", 28573, "CLARO S.A."), withName(3, "4.4.4.4", 50, "mia1.example.net", 3356, "LEVEL3", "US")];
    const r = inferRoute(input({ hops, destRttMs: 50 }));
    expect(r.verdict).toBe("INTERNATIONAL");
    expect(r.cable).toBeNull();
    expect(r.summary).toContain("Nenhum cabo do Brasil com chegada em Estados Unidos cabe no tempo medido");
  });

  it("sem país de chegada, a rota sai do país sem palpite de cabo", () => {
    const hops = MIAMI_ROUTE.map((h) => ({ ...h, rdns: null, city: null, registryCountry: null }));
    const r = inferRoute(input({ hops, destRegistryCountry: null }));
    expect(r).toMatchObject({ verdict: "INTERNATIONAL", destCountry: null, cable: null, confidence: null });
  });

  it("sem tempo de resposta, nada a dizer", () => {
    expect(inferRoute(input({ hops: [hop(1, null, null)], destRttMs: null })).verdict).toBe("UNDETERMINED");
  });

  it("dono do roteador nos donos do cabo, pelos apelidos", () => {
    expect(ownerMatches(["CLARO NXT TELECOMUNICACOES LTDA"], "América Movil")).toBe(true);
    expect(ownerMatches(["TELEFONICA BRASIL S.A"], "Telxius")).toBe(true);
    expect(ownerMatches(["GOOGLE"], "Algar Telecom, Google")).toBe(true);
    expect(ownerMatches(["ALGAR TELECOM"], "America Movil")).toBe(false);
  });

  it("rankCables pede ponta no Brasil e no país de destino", () => {
    expect(rankCables(CABLES, { country: "PT", exitCity: null, entryCity: null, destRttMs: 120, asNames: [] }).map((c) => c.id)).toEqual(["ellalink"]);
  });

  it("asPathOf junta ASNs repetidos e acrescenta o do destino", () => {
    expect(asPathOf(MIAMI_ROUTE, 15169)).toBe("28573 4230 15169");
    expect(asPathOf([], null)).toBeNull();
  });
});

describe("mapa de cabos", () => {
  it("monta os cabos do Brasil em operação, com coordenada e país de cada ponta", () => {
    const country = { cables: [{ id: "monet", is_planned: false, rfs_year: 2017 }, { id: "futuro", is_planned: true, rfs_year: 2027 }] };
    const details = [
      { id: "monet", name: "Monet", length: "10,556 km", owners: "Google", rfs_year: 2017, landing_points: [{ id: "fortaleza-brazil", name: "Fortaleza, Brazil", country: "Brazil" }, { id: "boca", name: "Boca Raton, FL, United States", country: "United States" }, { id: "sem-coordenada", country: "Brazil" }] },
      { id: "futuro", name: "Futuro", landing_points: [{ id: "fortaleza-brazil", country: "Brazil" }] },
    ];
    const geo = { features: [{ properties: { id: "fortaleza-brazil" }, geometry: { coordinates: [-38.5, -3.7] as [number, number] } }, { properties: { id: "boca" }, geometry: { coordinates: [-80.1, 26.4] as [number, number] } }] };
    expect(buildCables(country, details, geo, 2026)).toEqual([
      { id: "monet", name: "Monet", owners: "Google", lengthKm: 10556, rfsYear: 2017, landings: [{ id: "fortaleza-brazil", name: "Fortaleza, Brazil", country: "BR", lat: -3.7, lon: -38.5 }, { id: "boca", name: "Boca Raton, FL, United States", country: "US", lat: 26.4, lon: -80.1 }] },
    ]);
    expect(parseLengthKm(null)).toBeNull();
  });
});

describe("agendador da rota", () => {
  beforeAll(async () => {
    await migrateTempDb(fixture);
  });
  beforeEach(async () => {
    await db.statusService.deleteMany();
    fixture.cables = CABLES;
    fixture.hops = MIAMI_ROUTE;
    fixture.trace = { ok: true, host: "google.com", address: "142.250.1.1", tool: "traceroute", hops: MIAMI_ROUTE.map(({ ttl, ip, rttMs }) => ({ ttl, ip, rttMs, altIps: [] })), reached: true, error: null, mode: "paris" };
    (globalThis as { __globalStatusRoutes?: unknown }).__globalStatusRoutes = undefined;
  });
  afterAll(async () => {
    await dropTempDb(fixture);
  });

  async function service(slug = "google") {
    return db.statusService.create({
      data: { slug, name: "Google", category: "DEV", position: 1, latencyMs: 110, targets: { create: [{ key: "tcp", kind: "TCP", host: `${slug}.com`, port: 443 }] } },
    });
  }

  it("grava a rota com os saltos, o veredito e o cabo provável", async () => {
    const s = await service();
    const id = await traceAndStore({ id: s.id, slug: s.slug, name: s.name, host: "google.com", latencyMs: 110 }, Date.parse("2026-11-15T22:00:00Z"));
    const trace = await db.routeTrace.findUniqueOrThrow({ where: { id: id! }, include: { hops: { orderBy: { ttl: "asc" } } } });
    expect(trace).toMatchObject({ host: "google.com", destIp: "142.250.1.1", reached: true, destRttMs: 107, verdict: "INTERNATIONAL", destCountry: "US", cableId: "amx-1", cableName: "AMX-1", confidence: "HIGH", asPath: "28573 4230 15169", candidates: "AMX-1 · Monet", error: null });
    expect(trace.hops.map((h) => [h.ttl, h.city, h.asn])).toEqual([
      [1, null, null],
      [2, null, null],
      [3, "São Paulo", 28573],
      [4, "Fortaleza", 4230],
      [5, null, null],
      [6, "Miami", 4230],
      [7, "Miami", 15169],
    ]);
  });

  it("mudança de onde o serviço é servido vira aviso no ticker, encerrado depois de 1 h", async () => {
    const s = await service();
    const svc = { id: s.id, slug: s.slug, name: s.name, host: "google.com", latencyMs: 110 };
    const t0 = Date.parse("2026-11-15T22:00:00Z");
    await traceAndStore(svc, t0);
    // Agora servido no Brasil.
    fixture.hops = MIAMI_ROUTE.slice(0, 3);
    fixture.trace = { ...fixture.trace!, hops: fixture.hops.map(({ ttl, ip, rttMs }) => ({ ttl, ip, rttMs, altIps: [] })) };
    await traceAndStore(svc, t0 + 30 * 60_000);
    const open = await db.statusIncident.findMany({ where: { serviceId: s.id, origin: "ROUTE" } });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: "Rota mudou: fora do Brasil, cabo AMX-1 → na borda do CDN no Brasil", resolvedAt: null, impact: "MINOR" });

    // A mesma rota de novo não abre outro aviso.
    await traceAndStore(svc, t0 + 60 * 60_000);
    expect(await db.statusIncident.count({ where: { origin: "ROUTE" } })).toBe(1);

    await cleanupRoutes(t0 + 30 * 60_000 + 61 * 60_000);
    expect((await db.statusIncident.findFirstOrThrow({ where: { origin: "ROUTE" } })).resolvedAt).not.toBeNull();
  });

  it("apaga as rotas com mais de 7 dias", async () => {
    const s = await service();
    const t0 = Date.parse("2026-11-01T00:00:00Z");
    await traceAndStore({ id: s.id, slug: s.slug, name: s.name, host: "google.com", latencyMs: 110 }, t0);
    await cleanupRoutes(t0 + 8 * 24 * 60 * 60_000);
    expect(await db.routeTrace.count()).toBe(0);
    expect(await db.routeHop.count()).toBe(0);
  });

  it("sem traceroute no servidor nada é gravado", async () => {
    const s = await service();
    fixture.trace = { ok: false, host: "google.com", address: "142.250.1.1", tool: null, hops: [], reached: false, error: "traceroute indisponível no servidor (sudo apt install traceroute)", mode: "paris" };
    expect(await traceAndStore({ id: s.id, slug: s.slug, name: s.name, host: "google.com", latencyMs: 110 })).toBeNull();
    expect(await db.routeTrace.count()).toBe(0);
  });

  it("a rodada rastreia o serviço com a rota mais antiga, um por vez", async () => {
    await service("google");
    const other = await service("github");
    const now = Date.parse("2026-11-15T22:00:00Z");
    await db.routeTrace.create({ data: { serviceId: other.id, at: new Date(now - 5 * 60_000), host: "github.com", verdict: "DOMESTIC", summary: "x" } });
    await runRouteTick(now);
    const traces = await db.routeTrace.findMany({ include: { service: true }, orderBy: { at: "asc" } });
    expect(traces.map((t) => t.service.slug)).toEqual(["github", "google"]);
  });

  it("nextDue respeita o intervalo de 30 min e destinationRtt prefere o destino alcançado", () => {
    const now = 10 * ROUTE_INTERVAL_MS;
    expect(nextDue([{ lastAt: now - 1000 }], now)).toBeNull();
    expect(nextDue([{ lastAt: now - ROUTE_INTERVAL_MS, n: 1 }, { lastAt: 0, n: 2 }], now)?.n).toBe(2);
    expect(destinationRtt({ ...fixture.trace!, reached: true }, 200)).toBe(107);
    expect(destinationRtt({ ...fixture.trace!, reached: false }, 200)).toBe(200);
  });

  it("GLOBAL_STATUS_ROUTES=off e as medições desligadas desligam a rota", () => {
    expect(routesEnabled({})).toBe(true);
    expect(routesEnabled({ GLOBAL_STATUS_ROUTES: "off" })).toBe(false);
    expect(routesEnabled({ GLOBAL_STATUS_PROBES: "off" })).toBe(false);
  });
  it("completa a rota que o agente mandou (só IP e tempo) com ASN, cidade, veredito e cabo", async () => {
    const s = await service();
    const at = new Date("2026-11-15T22:10:00Z");
    const raw = await db.routeTrace.create({
      data: {
        serviceId: s.id,
        vantage: "agent:pc-1",
        at,
        host: "google.com",
        destIp: "142.250.1.1",
        tool: "icmp",
        reached: true,
        verdict: "PENDING",
        summary: "",
        hops: { create: MIAMI_ROUTE.map(({ ttl, ip, rttMs }) => ({ ttl, ip, rttMs })) },
      },
    });
    expect(await analyzeAgentRoutes(at.getTime())).toBe(1);
    const done = await db.routeTrace.findUniqueOrThrow({ where: { id: raw.id }, include: { hops: { orderBy: { ttl: "asc" } } } });
    expect(done).toMatchObject({ verdict: "INTERNATIONAL", destRttMs: 107, cableName: "AMX-1", asPath: "28573 4230 15169", mode: "icmp" });
    expect(done.hops.find((h) => h.ttl === 6)).toMatchObject({ city: "Miami", asn: 4230 });
    // Nada mais pendente: a rodada seguinte não faz nada.
    expect(await analyzeAgentRoutes(at.getTime())).toBe(0);
  });

  it("uma rota do agente que falha na análise não trava a fila", async () => {
    const s = await service();
    const { enrichHops } = await import("./route-enrich");
    vi.mocked(enrichHops).mockRejectedValueOnce(new Error("rDNS fora do ar"));
    const raw = await db.routeTrace.create({ data: { serviceId: s.id, vantage: "agent:pc-1", host: "google.com", reached: false, verdict: "PENDING", summary: "", hops: { create: [{ ttl: 1, ip: "192.168.0.1", rttMs: 1 }] } } });
    await analyzeAgentRoutes();
    expect(await db.routeTrace.findUniqueOrThrow({ where: { id: raw.id } })).toMatchObject({ verdict: "UNDETERMINED", summary: "Não foi possível analisar a rota do agente: rDNS fora do ar." });
  });

  it("resume o dia: rotas internacionais, saída do país e trocas de caminho", async () => {
    const s = await service();
    const svc = { id: s.id, slug: s.slug, name: s.name, host: "google.com", latencyMs: 110 };
    const t0 = Date.parse("2026-11-15T15:00:00Z");
    await traceAndStore(svc, t0);
    await traceAndStore(svc, t0 + ROUTE_INTERVAL_MS);
    fixture.hops = MIAMI_ROUTE.slice(0, 3);
    fixture.trace = { ...fixture.trace!, hops: fixture.trace!.hops.slice(0, 3) };
    await traceAndStore(svc, t0 + 2 * ROUTE_INTERVAL_MS);
    await rollupRouteDays(t0 + 3 * ROUTE_INTERVAL_MS, true);
    const day = await db.routeDaily.findFirstOrThrow({ where: { serviceId: s.id } });
    expect(day).toMatchObject({ day: "2026-11-15", vantage: "server", traces: 3, international: 2, domestic: 1, pathChanges: 1 });
    expect(day.topExit).toContain("Miami");
    const month = await monthlyRoutes(s.id, t0 + 3 * ROUTE_INTERVAL_MS);
    expect(month).toMatchObject({ days: 1, abroadDays: 1, pathChanges: 1 });
  });
});
