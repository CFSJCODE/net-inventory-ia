import { describe, expect, it } from "vitest";
import alertsSample from "./__fixtures__/ioda-alerts-sample.json";
import { iodaAlertsUrl, iodaRuns, parseIodaAlerts } from "./adapters/ioda";
import { bgpSnapshot, parseNetworkInfo, parseRoutingStatus, routeText, visibilityStatus, type ServiceRoute } from "./adapters/ripestat";
import { planDetected, RESOLVE_AFTER_MS } from "./detected";
import { routeHost } from "./internet-signals";
import { normalizeGlobalStatusSettings } from "./settings";
import { buildStatusEmail, MIN_GAP_MS, planStatusAlerts, STABLE_MS, type WatchedService } from "./status-alerts";

const T = new Date("2026-11-15T20:00:00Z");
const ago = (ms: number) => new Date(T.getTime() - ms);

describe("IODA", () => {
  it("monta a URL com a janela de uma semana", () => {
    const url = iodaAlertsUrl("https://x/v2/outages/alerts?entityType=country&entityCode=BR", T.getTime());
    const until = Math.floor(T.getTime() / 1000);
    expect(url).toBe(`https://x/v2/outages/alerts?entityType=country&entityCode=BR&from=${until - 7 * 86400}&until=${until}`);
  });

  it("junta os alertas reais em quedas e ignora o 'normal' que fecha uma queda de antes da janela", () => {
    const runs = iodaRuns(alertsSample.data);
    expect(runs).toHaveLength(5);
    expect(runs.slice(0, 4).every((r) => r.end !== null)).toBe(true);
    expect(runs[4]).toMatchObject({ datasource: "bgp", start: 1794566700, end: null, level: "critical" });
  });

  it("um sinal em alerta crítico deixa o país degradado, não fora do ar", () => {
    const snap = parseIodaAlerts(alertsSample, { entity: "Venezuela", pageUrl: "https://ioda.inetintel.cc.gatech.edu/country/VE" });
    expect(snap.status).toBe("DEGRADED");
    expect(snap.description).toBe("Alerta do IODA em rotas bgp");
    expect(snap.components?.find((c) => c.externalId === "bgp")?.status).toBe("DOWN");
    expect(snap.components?.find((c) => c.externalId === "ping-slash24")?.status).toBe("OK");
    const open = snap.incidents.filter((i) => i.resolvedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ externalId: "bgp:1794566700", impact: "MAJOR", state: "investigating", url: "https://ioda.inetintel.cc.gatech.edu/country/VE" });
    expect(open[0].affected).toBe("Rotas BGP: 20.414 contra 25.416 do normal (−20%)");
    expect(snap.incidents.filter((i) => i.state === "resolved")).toHaveLength(4);
  });

  it("dois sinais em alerta crítico ao mesmo tempo = fora do ar; sem alertas = normal", () => {
    const two = parseIodaAlerts(
      { data: [{ datasource: "bgp", time: 10, level: "critical" }, { datasource: "ping-slash24", time: 20, level: "critical" }] },
      { entity: "Brasil", pageUrl: null },
    );
    expect(two.status).toBe("DOWN");
    const none = parseIodaAlerts({ data: [] }, { entity: "Brasil", pageUrl: null });
    expect(none).toMatchObject({ status: "OK", description: "Sem alertas do IODA", incidents: [] });
    expect(none.components?.map((c) => c.externalId)).toEqual(["bgp", "ping-slash24", "merit-nt"]);
  });

  it("um aviso que vira crítico sobe o nível da mesma queda", () => {
    const runs = iodaRuns([{ datasource: "bgp", time: 1, level: "warning", value: 90, historyValue: 100 }, { datasource: "bgp", time: 2, level: "critical", value: 50, historyValue: 100 }]);
    expect(runs).toEqual([{ datasource: "bgp", start: 1, end: null, level: "critical", current: "critical", value: 50, historyValue: 100 }]);
  });

  it("crítico que melhora para aviso: o estado de agora é degradado, o impacto fica no pior", () => {
    const body = {
      data: [
        { datasource: "bgp", time: 1, level: "critical" },
        { datasource: "ping-slash24", time: 2, level: "critical" },
        { datasource: "bgp", time: 3, level: "warning" },
      ],
    };
    const snap = parseIodaAlerts(body, { entity: "Brasil", pageUrl: null });
    expect(snap.status).toBe("DEGRADED");
    expect(snap.components?.find((c) => c.externalId === "bgp")?.status).toBe("DEGRADED");
    expect(snap.incidents.find((i) => i.externalId === "bgp:1")?.impact).toBe("MAJOR");
  });

  it("queda aberta que começou antes da janela segue aberta sem alertas novos, e fecha com o 'normal'", () => {
    const carried = [{ datasource: "bgp", start: 5, level: "critical" as const, affected: "Rotas BGP: 9 contra 38 do normal (−76%)" }];
    const still = parseIodaAlerts({ data: [] }, { entity: "Brasil", pageUrl: null, carried });
    expect(still.status).toBe("DEGRADED");
    expect(still.incidents).toEqual([expect.objectContaining({ externalId: "bgp:5", resolvedAt: null, impact: "MAJOR", affected: "Rotas BGP: 9 contra 38 do normal (−76%)" })]);
    const closed = parseIodaAlerts({ data: [{ datasource: "bgp", time: 900, level: "normal" }] }, { entity: "Brasil", pageUrl: null, carried });
    expect(closed.status).toBe("OK");
    expect(closed.incidents[0].resolvedAt).toEqual(new Date(900_000));
  });

  it("resposta sem lista de alertas é erro (o card não vira 'normal' por engano)", () => {
    expect(() => parseIodaAlerts({ error: "x" }, { entity: "Brasil", pageUrl: null })).toThrow();
  });
});

describe("RIPEstat", () => {
  it("lê prefixo, ASN e visibilidade das respostas reais", () => {
    expect(parseNetworkInfo({ status: "ok", data: { asns: ["15169"], prefix: "8.8.8.0/24" } })).toEqual({ prefix: "8.8.8.0/24", asns: [15169] });
    expect(parseNetworkInfo({ status: "ok", data: { asns: [], prefix: null } })).toBeNull();
    const body = { status: "ok", data: { visibility: { v4: { ris_peers_seeing: 243, total_ris_peers: 244 }, v6: { ris_peers_seeing: 0, total_ris_peers: 0 } } } };
    expect(parseRoutingStatus(body, "1.1.1.0/24")).toEqual({ seeing: 243, total: 244 });
    expect(parseRoutingStatus(body, "2606:4700::/32")).toEqual({ seeing: 0, total: 0 });
    expect(() => parseRoutingStatus({ status: "error" }, "1.1.1.0/24")).toThrow();
  });

  it("classifica a visibilidade: 90% ou mais é normal, abaixo de 50% é fora", () => {
    expect(visibilityStatus({ seeing: 220, total: 244 })).toBe("OK");
    expect(visibilityStatus({ seeing: 200, total: 244 })).toBe("DEGRADED");
    expect(visibilityStatus({ seeing: 100, total: 244 })).toBe("DOWN");
    expect(visibilityStatus({ seeing: 0, total: 0 })).toBe("UNKNOWN");
    expect(visibilityStatus(null)).toBe("UNKNOWN");
  });

  it("um prefixo pouco visto deixa o card degradado, nunca fora; erro de um serviço fica sem dados", () => {
    const route = (slug: string, seeing: number, extra: Partial<ServiceRoute> = {}): ServiceRoute => ({ slug, name: slug, group: "Desenvolvimento", prefix: "140.82.112.0/20", asn: 36459, visibility: { seeing, total: 244 }, error: null, ...extra });
    const snap = bgpSnapshot([route("github", 243), route("vercel", 30), route("x", 0, { prefix: null, visibility: null, error: "x.com sem prefixo anunciado" })]);
    expect(snap.status).toBe("DEGRADED");
    expect(snap.description).toBe("1 de 2 prefixos vistos no mundo todo");
    expect(snap.components?.map((c) => c.status)).toEqual(["OK", "DOWN", "UNKNOWN"]);
    expect(snap.components?.[0].name).toBe("github · 140.82.112.0/20 · AS36459 · vista por 243 de 244 coletores");
    expect(snap.components?.[2].name).toBe("x · x.com sem prefixo anunciado");
    expect(bgpSnapshot([]).status).toBe("UNKNOWN");
    expect(routeText({ prefix: "1.1.1.0/24", asn: 13335, visibility: null, error: "RIPEstat não respondeu a tempo" })).toBe("1.1.1.0/24 · AS13335 · RIPEstat não respondeu a tempo");
  });

  it("a rota que importa é a do TCP, senão a do HTTP; o gateway local não tem rota pública", () => {
    expect(routeHost([{ kind: "HTTP", host: "github.com" }, { kind: "TCP", host: "g.whatsapp.net" }])).toBe("g.whatsapp.net");
    expect(routeHost([{ kind: "HTTP", host: "github.com" }])).toBe("github.com");
    expect(routeHost([{ kind: "ICMP", host: "auto:gateway" }])).toBeNull();
  });
});

describe("incidentes detectados", () => {
  const open = (impact: string, state: string, updatedAt = T) => ({ id: "i1", impact, state, updatedAt });

  it("abre ao medir degradado ou fora, com o motivo", () => {
    expect(planDetected(null, { measuredStatus: "DOWN", measuredReason: "HTTP: 3 falhas seguidas" }, T)).toEqual({
      kind: "create",
      data: { externalId: `m-${T.getTime()}`, title: "Fora do ar nas medições deste servidor", impact: "MAJOR", state: "investigating", affected: "HTTP: 3 falhas seguidas", startedAt: T },
    });
    expect(planDetected(null, { measuredStatus: "DEGRADED", measuredReason: null }, T)).toMatchObject({ kind: "create", data: { impact: "MINOR" } });
  });

  it("não abre nada com o serviço normal ou sem dados (medições pausadas)", () => {
    expect(planDetected(null, { measuredStatus: "OK", measuredReason: null }, T)).toEqual({ kind: "none" });
    expect(planDetected(null, { measuredStatus: "UNKNOWN", measuredReason: "pausado" }, T)).toEqual({ kind: "none" });
    expect(planDetected(open("MINOR", "investigating"), { measuredStatus: "UNKNOWN", measuredReason: null }, T)).toEqual({ kind: "none" });
  });

  it("sobe para grave quando piora e fica no pior impacto visto", () => {
    expect(planDetected(open("MINOR", "investigating"), { measuredStatus: "DOWN", measuredReason: "TCP 443: 3 falhas seguidas" }, T)).toEqual({
      kind: "update",
      id: "i1",
      data: { state: "investigating", affected: "TCP 443: 3 falhas seguidas", impact: "MAJOR", title: "Fora do ar nas medições deste servidor" },
    });
    expect(planDetected(open("MAJOR", "investigating"), { measuredStatus: "DEGRADED", measuredReason: "x" }, T)).toEqual({ kind: "none" });
  });

  it("passa a monitorando ao voltar, fecha 10 min depois na hora da volta, e reabre se piorar antes", () => {
    expect(planDetected(open("MINOR", "investigating"), { measuredStatus: "OK", measuredReason: null }, T)).toEqual({ kind: "update", id: "i1", data: { state: "monitoring" } });
    const back = ago(RESOLVE_AFTER_MS - 1000);
    expect(planDetected(open("MINOR", "monitoring", back), { measuredStatus: "OK", measuredReason: null }, T)).toEqual({ kind: "none" });
    const longAgo = ago(RESOLVE_AFTER_MS);
    expect(planDetected(open("MINOR", "monitoring", longAgo), { measuredStatus: "OK", measuredReason: null }, T)).toEqual({ kind: "update", id: "i1", data: { state: "resolved", resolvedAt: longAgo } });
    expect(planDetected(open("MINOR", "monitoring", back), { measuredStatus: "DEGRADED", measuredReason: "y" }, T)).toEqual({ kind: "update", id: "i1", data: { state: "investigating", affected: "y" } });
  });
});

describe("alerta por e-mail do Status global", () => {
  const svc = (slug: string, status: WatchedService["status"], changedAgo = STABLE_MS, extra: Partial<WatchedService> = {}): WatchedService => ({ slug, name: slug.toUpperCase(), category: "DEV", status, lastChangeAt: ago(changedAgo), reason: null, ...extra });

  it("avisa a queda que já dura 5 min e espera a que acabou de acontecer", () => {
    const { changes, next } = planStatusAlerts([svc("github", "DOWN"), svc("vercel", "DOWN", STABLE_MS - 1000)], {}, "DOWN", T);
    expect(changes.map((c) => c.slug)).toEqual(["github"]);
    expect(next).toEqual({ github: "DOWN" });
  });

  it("no nível 'fora do ar' degradado não é aviso, mas a volta de uma queda é", () => {
    expect(planStatusAlerts([svc("github", "DEGRADED")], {}, "DOWN", T).changes).toEqual([]);
    const { changes } = planStatusAlerts([svc("github", "OK")], { github: "DOWN" }, "DOWN", T);
    expect(changes).toEqual([{ slug: "github", name: "GITHUB", from: "DOWN", to: "OK", reason: null, kind: "recovery" }]);
    // Fora → degradado no nível "fora do ar" conta como volta.
    expect(planStatusAlerts([svc("github", "DEGRADED")], { github: "DOWN" }, "DOWN", T).changes[0]?.kind).toBe("recovery");
  });

  it("no nível 'degradado' avisa a piora de degradado para fora, e não repete o que já avisou", () => {
    expect(planStatusAlerts([svc("github", "DOWN")], { github: "DEGRADED" }, "DEGRADED", T).changes[0]).toMatchObject({ kind: "alert", from: "DEGRADED", to: "DOWN" });
    expect(planStatusAlerts([svc("github", "DEGRADED")], { github: "DEGRADED" }, "DEGRADED", T).changes).toEqual([]);
    expect(planStatusAlerts([svc("github", "DEGRADED")], { github: "DOWN" }, "DEGRADED", T).changes).toEqual([]);
  });

  it("com as medições pausadas pela queda da conexão do servidor, nem volta nem queda: fica o último avisado", () => {
    const { changes, next } = planStatusAlerts([svc("github", "OK", STABLE_MS, { paused: true })], { github: "DOWN" }, "DOWN", T);
    expect(changes).toEqual([]);
    expect(next).toEqual({ github: "DOWN" });
  });

  it("sem dados, manutenção e a faixa 'Sua Internet' não são notícia", () => {
    const { changes, next } = planStatusAlerts([svc("a", "UNKNOWN"), svc("b", "MAINTENANCE"), svc("rede-local", "DOWN", STABLE_MS, { category: "INTERNET" })], { a: "DOWN" }, "DOWN", T);
    expect(changes).toEqual([]);
    expect(next).toEqual({ a: "DOWN" });
  });

  it("monta um e-mail só com todas as mudanças", () => {
    const email = buildStatusEmail(
      [
        { slug: "github", name: "GitHub", from: "OK", to: "DOWN", reason: "HTTP: 3 falhas seguidas", kind: "alert" },
        { slug: "vercel", name: "Vercel", from: "DOWN", to: "OK", reason: null, kind: "recovery" },
      ],
      T,
    );
    expect(email.subject).toBe("[NetInventory] 2 serviços mudaram de estado");
    expect(email.text).toContain("normalizado → fora do ar · HTTP: 3 falhas seguidas");
    expect(email.text).toContain("Status global → Configurar");
    expect(buildStatusEmail([{ slug: "github", name: "GitHub", from: "DOWN", to: "OK", reason: null, kind: "recovery" }], T).subject).toBe("[NetInventory] GitHub: normalizado");
    expect(MIN_GAP_MS).toBe(10 * 60_000);
  });
});

describe("configuração", () => {
  it("volta ao padrão o que não faz sentido", () => {
    expect(normalizeGlobalStatusSettings(null)).toEqual({ alerts: { enabled: false, level: "DOWN" }, ispAsn: null });
    expect(normalizeGlobalStatusSettings({ alerts: { enabled: true, level: "DEGRADED" }, ispAsn: 28573 })).toEqual({ alerts: { enabled: true, level: "DEGRADED" }, ispAsn: 28573 });
    expect(normalizeGlobalStatusSettings({ alerts: { enabled: "sim", level: "x" }, ispAsn: -1 })).toEqual({ alerts: { enabled: false, level: "DOWN" }, ispAsn: null });
    expect(normalizeGlobalStatusSettings({ ispAsn: "" }).ispAsn).toBeNull();
    expect(normalizeGlobalStatusSettings({ ispAsn: 1.5 }).ispAsn).toBeNull();
  });
});
