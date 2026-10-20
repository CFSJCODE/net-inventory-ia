import { describe, expect, it } from "vitest";
import { appendNestSample, nestBoolean, nestChanges, nestConnection, nestHistoryStats, nestSample, nestUptime, nestValue, type NestDetails, type NestEndpoint, type NestSample } from "./nest-monitoring";

const details = (values: Record<string, string>): NestDetails => ({ title: "Nest", groups: [{ title: "Teste", description: "", fields: Object.entries(values).map(([name, value]) => ({ name, value, present: true })) }] });
const endpoint = (overrides: Partial<NestEndpoint> = {}): NestEndpoint => ({ id: "test", name: "Teste", url: "http://192.0.2.68:8008/setup/eureka_info", readAt: "2026-10-12T20:00:00Z", ok: true, httpStatus: 200, durationMs: 0, error: null, details: details({ connected: "Sim (true)", uptime: "9 horas, 32 minutos e 5 segundos (34.325 s)", build_version: "1" }), ...overrides });
const sample = (overrides: Partial<NestSample> = {}): NestSample => ({ ...nestSample(endpoint()), ...overrides });

describe("painel de monitoramento Nest", () => {
  it("preserva false e valores zero; não interpreta códigos como booleanos", () => {
    const data = details({ connected: "Não (false)", wpa_id: "0", setup_state: "60" });
    expect(nestBoolean(data, "connected")).toBe(false);
    expect(nestValue(data, "wpa_id")).toBe("0");
    expect(nestBoolean(data, "setup_state")).toBeNull();
    expect(nestValue(data, "ssid")).toBe("Não informado");
  });
  it("não infere Wi-Fi quando o tipo de conexão não foi informado", () => {
    expect(nestConnection(details({ connected: "Sim (true)" }))).toBe("Não informado");
    expect(nestConnection(details({ connected: "Sim (true)", ethernet_connected: "Não (false)" }))).toBe("Wi-Fi");
    expect(nestConnection(details({ ethernet_connected: "Sim (true)" }))).toBe("Ethernet");
  });
  it("lê segundos formatados e valores decimais sem perder zero", () => {
    expect(nestUptime(endpoint().details)).toBe(34325);
    expect(nestUptime(details({ uptime: "0 segundos (0 s)" }))).toBe(0);
    expect(nestUptime(details({ uptime: "25 horas (90.061,9 s)" }))).toBe(90061.9);
    expect(nestUptime(details({ uptime: "Não informado" }))).toBeNull();
  });
  it("falha da API não vira confirmação de desconexão do Nest", () => {
    expect(nestSample(endpoint({ ok: false, httpStatus: null })).connected).toBeNull();
    expect(nestSample(endpoint({ ok: false })).uptime).toBeNull();
    expect(nestSample(endpoint({ durationMs: NaN })).durationMs).toBeNull();
  });
  it("limita a janela a 60 consultas e não duplica a mesma leitura", () => {
    let history: NestSample[] = [];
    for (let index = 0; index < 70; index++) history = appendNestSample(history, sample({ readAt: String(index) }));
    expect(history).toHaveLength(60);
    expect(history[0].readAt).toBe("10");
    expect(appendNestSample(history, history.at(-1)!)).toBe(history);
  });
  it("calcula disponibilidade da API; latência usa somente consultas válidas", () => {
    const stats = nestHistoryStats([sample({ durationMs: 0 }), sample({ durationMs: 40 }), sample({ ok: false, durationMs: 5000 })]);
    expect(stats).toEqual({ count: 3, successful: 2, availablePct: 67, averageMs: 20, minMs: 0, maxMs: 40, errors: 1 });
    expect(nestHistoryStats([]).availablePct).toBeNull();
  });
  it("aponta mudança de uptime e firmware com evidência de duas leituras", () => {
    expect(nestChanges([sample({ uptime: 100, firmware: "1" }), sample({ uptime: 1, firmware: "2", connected: false })])).toHaveLength(3);
    expect(nestChanges([sample()])).toEqual([]);
    expect(nestChanges([sample({ uptime: 100 }), sample({ uptime: 99 })])).toEqual([]);
  });
  it("ignora amostras com erro ao comparar informações do aparelho", () => {
    expect(nestChanges([sample({ uptime: 100 }), sample({ ok: false, uptime: 0 })])).toEqual([]);
  });
});
