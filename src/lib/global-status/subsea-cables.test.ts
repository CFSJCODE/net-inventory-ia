import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const upsert = vi.fn(async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
  store.set(where.key, update.value);
  return {};
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (store.has(where.key) ? { key: where.key, value: store.get(where.key)! } : null)),
      upsert: (args: Parameters<typeof upsert>[0]) => upsert(args),
    },
  },
}));

import { brazilCables, CABLES_ERROR_KEY, CABLES_KEY } from "./subsea-cables";

const NOW = Date.UTC(2026, 10, 15, 12);
const country = { cables: [{ id: "amx-1", is_planned: false, rfs_year: 2014 }] };
const cable = { id: "amx-1", name: "AMX-1", length: "17,800 km", owners: "América Movil", rfs_year: 2014, landing_points: [{ id: "fortaleza-brazil", name: "Fortaleza, Brazil", country: "Brazil" }] };
const geo = { features: [{ properties: { id: "fortaleza-brazil" }, geometry: { coordinates: [-38.5, -3.7] } }] };

function okFetch() {
  return vi.fn(async (url: string) => {
    const body = url.endsWith("country/brazil.json") ? country : url.includes("/cable/") ? cable : geo;
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

const g = globalThis as { __subseaCables?: unknown; __subseaCablesFailedAt?: number };

beforeEach(() => {
  store.clear();
  upsert.mockClear();
  g.__subseaCables = undefined;
  g.__subseaCablesFailedAt = undefined;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("brazilCables", () => {
  it("baixa, grava e devolve os cabos", async () => {
    vi.stubGlobal("fetch", okFetch());
    const cables = await brazilCables(NOW);
    expect(cables.map((c) => c.name)).toEqual(["AMX-1"]);
    expect(JSON.parse(store.get(CABLES_KEY)!).cables).toHaveLength(1);
  });

  it("uma falha ao gravar não perde os cabos baixados e fica registrada", async () => {
    vi.stubGlobal("fetch", okFetch());
    upsert.mockImplementationOnce(async () => {
      throw new Error("database is locked");
    });
    expect(await brazilCables(NOW)).toHaveLength(1);
    expect(JSON.parse(store.get(CABLES_ERROR_KEY)!).error).toMatch(/gravar: database is locked/);
    // O processo segue com os cabos sem buscar de novo.
    const again = okFetch();
    vi.stubGlobal("fetch", again);
    expect(await brazilCables(NOW + 60_000)).toHaveLength(1);
    expect(again).not.toHaveBeenCalled();
  });

  it("uma falha ao buscar fica registrada com a causa e tenta de novo depois de 30 min", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo EAI_AGAIN") });
    }));
    expect(await brazilCables(NOW)).toEqual([]);
    expect(JSON.parse(store.get(CABLES_ERROR_KEY)!)).toEqual({ at: NOW, error: "fetch failed (getaddrinfo EAI_AGAIN)" });
    const retry = okFetch();
    vi.stubGlobal("fetch", retry);
    expect(await brazilCables(NOW + 10 * 60_000)).toEqual([]);
    expect(retry).not.toHaveBeenCalled();
    expect(await brazilCables(NOW + 31 * 60_000)).toHaveLength(1);
  });
});
