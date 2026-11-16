import { describe, expect, it } from "vitest";
import { diagnose, type DiagnosisService } from "./diagnosis";
import type { LocalConnectivity, ServiceStatus } from "./types";

const OK_CONN: LocalConnectivity = { state: "ok", since: null, reason: null };

function svc(slug: string, measured: ServiceStatus | null = "OK", extra: Partial<DiagnosisService> = {}): DiagnosisService {
  const official = extra.officialState ?? null;
  const worst = [measured, official].includes("DOWN") ? "DOWN" : [measured, official].includes("DEGRADED") ? "DEGRADED" : "OK";
  return { slug, name: slug.toUpperCase(), category: "CLOUD", status: worst, officialState: official, measuredStatus: measured, measuredReason: measured === "DEGRADED" ? "latência 3,0× acima do normal" : null, ...extra };
}
const healthyLocal = svc("rede-local", "OK", { category: "INTERNET" });

describe("diagnose", () => {
  it("sem nada fora do normal não diz nada", () => {
    expect(diagnose({ services: [svc("a"), svc("b"), healthyLocal], connectivity: OK_CONN })).toEqual({ affected: 0, headline: null, scope: null, groups: [] });
  });

  it("com a conexão do servidor fora, tudo vai para a rede local", () => {
    const d = diagnose({ services: [svc("a", "DOWN"), svc("b", "DEGRADED")], connectivity: { state: "offline", since: null, reason: "O gateway 192.168.0.1 não responde." } });
    expect(d.scope).toBe("LOCAL");
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].services.map((s) => s.slug)).toEqual(["a", "b"]);
    expect(d.groups[0].detail).toContain("192.168.0.1");
  });

  it("rede local degradada leva o que só a medição viu; o confirmado pelo provedor fica com ele", () => {
    const d = diagnose({
      services: [svc("rede-local", "DEGRADED", { category: "INTERNET", measuredReason: "perda de 12% dos pacotes" }), svc("a", "DEGRADED"), svc("b", "DEGRADED", { officialState: "DEGRADED" })],
      connectivity: OK_CONN,
    });
    expect(d.scope).toBe("LOCAL");
    expect(d.groups.map((g) => [g.scope, g.services.map((s) => s.slug)])).toEqual([
      ["LOCAL", ["a"]],
      ["PROVIDER", ["b"]],
    ]);
  });

  it("só o DNS do card \"Rede local\" lento não culpa a rede local (o resolvedor fica na Internet)", () => {
    const d = diagnose({
      services: [svc("rede-local", "DEGRADED", { category: "INTERNET", measuredReason: "DNS: p95 8,0× a mediana das 100 medições anteriores (153 ms)" }), svc("a", "DEGRADED")],
      connectivity: OK_CONN,
    });
    expect(d.scope).not.toBe("LOCAL");
    expect(d.groups.map((g) => [g.scope, g.services.map((s) => s.slug)])).toEqual([["SERVICE", ["a"]]]);

    // DNS fora com o card DOWN: o motivo é o do DNS mesmo com o gateway degradado, então segue culpando a rede local.
    const down = diagnose({
      services: [svc("rede-local", "DOWN", { category: "INTERNET", measuredReason: "DNS: 3 falhas seguidas" }), svc("a", "DEGRADED")],
      connectivity: OK_CONN,
    });
    expect(down.scope).toBe("LOCAL");
  });

  it("muitos serviços lentos por caminhos diferentes, com a rede local normal, apontam o acesso", () => {
    const services = [healthyLocal, ...["a", "b", "c", "d", "e", "f"].map((s) => svc(s, "DEGRADED")), svc("g"), svc("h")];
    const d = diagnose({ services, connectivity: OK_CONN });
    expect(d.scope).toBe("ACCESS");
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].services).toHaveLength(6);
    expect(d.groups[0].action).toMatch(/operadora/);
    expect(d.headline).toMatch(/^6 serviços fora do normal, uma causa provável/);
  });

  it("poucos serviços lentos não culpam o acesso", () => {
    const services = [healthyLocal, ...["a", "b"].map((s) => svc(s, "DEGRADED")), ...["c", "d", "e", "f", "g", "h"].map((s) => svc(s))];
    const d = diagnose({ services, connectivity: OK_CONN });
    expect(d.groups.every((g) => g.scope === "SERVICE")).toBe(true);
    expect(d.scope).toBe("SERVICE");
  });

  it("a rota que mudou explica a lentidão dos serviços dela, antes do acesso", () => {
    const services = [healthyLocal, svc("facebook", "DEGRADED"), svc("instagram", "DEGRADED"), svc("x")];
    const d = diagnose({
      services,
      connectivity: OK_CONN,
      incidents: [
        { origin: "ROUTE", serviceSlug: "facebook", title: "Rota mudou: na borda do CDN no Brasil → fora do Brasil, cabo América" },
        { origin: "ROUTE", serviceSlug: "instagram", title: "Rota mudou: no Brasil → fora do Brasil" },
      ],
    });
    expect(d.scope).toBe("UPSTREAM");
    expect(d.groups[0].label).toBe("Rota passou a sair do Brasil");
    expect(d.groups[0].services.map((s) => s.slug)).toEqual(["facebook", "instagram"]);
  });

  it("vários afetados pelo mesmo lugar viram um grupo só; espalhados por poucos lugares não apontam o acesso", () => {
    const services = [healthyLocal, ...["a", "b", "c", "d", "e"].map((s) => svc(s, "DEGRADED")), svc("f")];
    const places = [
      { label: "Embratel → Miami", kind: "EXIT", services: [{ slug: "a" }, { slug: "b" }, { slug: "c" }] },
      { label: "Cloudflare em São Paulo", kind: "EDGE", services: [{ slug: "d" }, { slug: "e" }] },
    ];
    const d = diagnose({ services, connectivity: OK_CONN, places });
    expect(d.groups.map((g) => [g.scope, g.label, g.services.length])).toEqual([
      ["UPSTREAM", "Embratel → Miami", 3],
      ["UPSTREAM", "Cloudflare em São Paulo", 2],
    ]);
  });

  it("deixa de fora as faixas de Internet e Internet no Brasil", () => {
    const d = diagnose({ services: [svc("dns-google", "DEGRADED", { category: "INTERNET" }), svc("internet-brasil", "DOWN", { category: "REGIONAL" })], connectivity: OK_CONN });
    expect(d.affected).toBe(0);
  });
});
