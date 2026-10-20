import { describe, expect, it } from "vitest";
import { extractNestTelemetry } from "./nest-telemetry";

const url = "http://192.0.2.68:8008/setup/eureka_info";
describe("leitura para o painel Nest", () => {
  it("seleciona os dez grupos e mantém false, zero e códigos", () => {
    const result = extractNestTelemetry({ connected: false, wpa_id: 0, uptime: 34325, time_format: 2, device_info: { capabilities: { multizone_supported: true } } }, url)!;
    expect(result.groups).toHaveLength(10);
    const fields = result.groups.flatMap(group => group.fields);
    expect(fields.find(field => field.name === "connected")?.value).toBe("Não (false)");
    expect(fields.find(field => field.name === "wpa_id")?.value).toBe("0");
    expect(fields.find(field => field.name === "uptime")?.value).toContain("9 horas, 32 minutos e 5 segundos");
    expect(fields.find(field => field.name === "time_format")?.value).toBe("2");
  });
  it("ignora segredos e objetos não previstos", () => {
    const result = extractNestTelemetry({ secret_token: "secret", device_info: { capabilities: { authorization_token: true, multizone_supported: false } }, setup_stats: { secret_counter: 3, num_obtain_ip: 0 } }, url)!;
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("authorization");
    expect(result.groups.at(-2)?.fields.find(field => field.name === "setup_stats.num_obtain_ip")?.value).toBe("0");
  });
  it("marca dados ausentes e uptime inválido sem criar valores", () => {
    const result = extractNestTelemetry({ uptime: -1, connected: null }, url)!;
    expect(result.groups[0].fields[0].present).toBe(false);
    expect(result.groups[3].fields[0].value).toBe("Não informado");
    expect(extractNestTelemetry([], url)).toBeNull();
    expect(extractNestTelemetry({}, "http://192.0.2.68/another-api")).toBeNull();
  });
});
