import { describe, expect, it } from "vitest";
import { pathHistory, placeOfTrace, routeChangeMarks, type TraceLite } from "./route-history";
import { buildStatusEmail, planRouteAlerts, sharedCauses, type StatusChange } from "./status-alerts";

const T0 = Date.parse("2026-11-16T00:00:00Z");
const MIN = 60_000;
const t = (min: number, asPath: string, verdict = "CDN_EDGE", extra: Partial<TraceLite> = {}): TraceLite => ({ at: T0 + min * MIN, asPath, verdict, cableName: null, destCountry: "BR", ...extra });

describe("histórico do caminho (fase 9)", () => {
  it("junta rotas iguais em trechos, do mais novo ao mais antigo", () => {
    const traces = [
      t(0, "28573 4230 15169"),
      t(30, "28573 4230 15169", "DOMESTIC"), // CDN no Brasil e servidor no Brasil contam igual
      t(60, "28573 4230 3356 15169"),
      t(90, "x", "UNDETERMINED"), // rastreio que falhou não abre trecho
      t(120, "28573 4230 3356 15169"),
    ];
    const h = pathHistory(traces);
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ asPath: "28573 4230 3356 15169", from: T0 + 60 * MIN, to: T0 + 120 * MIN, traces: 2 });
    expect(h[1]).toMatchObject({ asPath: "28573 4230 15169", traces: 2, place: "na borda do CDN no Brasil" });
  });

  it("marca as trocas dentro da janela", () => {
    const traces = [t(0, "1 2"), t(30, "1 3", "INTERNATIONAL", { destCountry: "US", cableName: "AMX-1" }), t(60, "1 3", "INTERNATIONAL", { destCountry: "US", cableName: "AMX-1" })];
    expect(routeChangeMarks(traces, T0 + 10 * MIN, T0 + 90 * MIN)).toEqual([{ at: T0 + 30 * MIN, text: "na borda do CDN no Brasil → fora do Brasil (US), cabo AMX-1; ASNs 1 2 → 1 3" }]);
    expect(routeChangeMarks(traces, T0 + 40 * MIN, T0 + 90 * MIN)).toEqual([]);
    expect(placeOfTrace({ verdict: "OPERATOR_CACHE", cableName: null, destCountry: "BR" })).toBe("dentro da operadora");
  });
});

describe("alertas de rota e causa comum (fase 9)", () => {
  it("avisa cada mudança de rota uma vez e marca a ida para fora do país", () => {
    const open = [
      { id: "a", service: "GitHub", title: "Rota mudou: no Brasil → fora do Brasil, cabo AMX-1" },
      { id: "b", service: "MIT", title: "Rota mudou: fora do Brasil, cabo AMX-1 → fora do Brasil, cabo Monet" },
    ];
    const first = planRouteAlerts(open, []);
    expect(first.changes.map((c) => [c.id, c.abroad])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(planRouteAlerts(open, first.next).changes).toEqual([]);
    // Um aviso resolvido sai da lista lembrada.
    expect(planRouteAlerts([open[1]], first.next).next).toEqual(["b"]);
  });

  it("agrupa serviços que caíram juntos pelo lugar que os atende", () => {
    const changes: StatusChange[] = [
      { slug: "github", name: "GitHub", from: "OK", to: "DEGRADED", reason: null, kind: "alert" },
      { slug: "mit", name: "MIT", from: "OK", to: "DEGRADED", reason: null, kind: "alert" },
      { slug: "google", name: "Google", from: "OK", to: "DEGRADED", reason: null, kind: "alert" },
    ];
    const places = [
      { label: "Embratel → Miami", kind: "EXIT", services: [{ slug: "github" }, { slug: "mit" }] },
      { label: "Cloudflare em São Paulo", kind: "EDGE", services: [{ slug: "google" }] },
      { label: "No Brasil", kind: "DOMESTIC", services: [{ slug: "github" }, { slug: "mit" }, { slug: "google" }] },
    ];
    expect(sharedCauses(changes, places)).toEqual([{ label: "Embratel → Miami", services: ["GitHub", "MIT"] }]);
    expect(sharedCauses(changes.slice(0, 1), places)).toEqual([]);

    const email = buildStatusEmail(changes, new Date(T0), { causes: sharedCauses(changes, places), singleExit: { label: "Embratel → Miami", share: 1 } });
    expect(email.subject).toBe("[NetInventory] Embratel → Miami: 2 serviços afetados juntos");
    expect(email.text).toContain("CAUSA PROVÁVEL");
    expect(email.text).toContain("100% das rotas internacionais saem por Embratel → Miami");
  });

  it("e-mail só de rota", () => {
    const email = buildStatusEmail([], new Date(T0), { routes: [{ id: "a", service: "GitHub", title: "Rota mudou: no Brasil → fora do Brasil", abroad: true }] });
    expect(email.subject).toBe("[NetInventory] GitHub: passou a vir de fora do Brasil");
    expect(email.text).toContain("no Brasil → fora do Brasil");
  });
});
