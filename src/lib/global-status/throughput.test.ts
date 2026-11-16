import { describe, expect, it } from "vitest";
import { formatMbps, summarizeThroughput, throughputWarning, type ThroughputRow } from "./throughput";

const NOW = Date.UTC(2026, 10, 16, 12, 0);
const HOUR = 60 * 60_000;
const A = "agent:11111111-1111-1111-1111-111111111111";

function row(hoursAgo: number, up: number | null, down: number | null, extra: Partial<ThroughputRow> = {}): ThroughputRow {
  return { vantage: A, at: new Date(NOW - hoursAgo * HOUR), server: "192.168.0.50", port: 5201, uploadMbps: up, downloadMbps: down, retransmits: null, error: null, ...extra };
}

describe("formatMbps", () => {
  it("inteiro a partir de 100, uma casa com vírgula abaixo", () => {
    expect(formatMbps(906.01)).toBe("906 Mbit/s");
    expect(formatMbps(58.34)).toBe("58,3 Mbit/s");
  });
});

describe("throughputWarning", () => {
  it("teste que falhou vira aviso com o erro", () => {
    expect(throughputWarning(row(0, null, null, { error: "the server is busy" }), 900, 650)).toBe("O último teste falhou: the server is busy.");
  });

  it("abaixo de metade do habitual numa direção avisa; acima disso, não", () => {
    expect(throughputWarning(row(0, 900, 94), 900, 650)).toMatch(/^Banda da rede local abaixo do habitual: download 94,0 Mbit\/s \(costuma ser 650 Mbit\/s\)\./);
    expect(throughputWarning(row(0, 460, 330), 900, 650)).toBeNull();
  });

  it("sem habitual não há com o que comparar", () => {
    expect(throughputWarning(row(0, 10, 10), null, null)).toBeNull();
  });
});

describe("summarizeThroughput", () => {
  it("um resumo por agente, com o habitual da semana sem contar o teste mais novo nem os que falharam", () => {
    const rows = [row(0, 900, 94), row(1, 910, 660), row(2, 890, 640), row(3, 905, 650), row(4, null, null, { error: "x" }), row(24 * 8, 10, 10)];
    const [s] = summarizeThroughput(rows, new Map([[A, "PC-4600G"]]), NOW);
    expect(s.label).toBe("PC-4600G");
    expect(s.server).toBe("192.168.0.50:5201");
    expect(s.latest.downloadMbps).toBe(94);
    expect(s.usualDownloadMbps).toBe(650);
    expect(s.usualUploadMbps).toBe(905);
    expect(s.warning).toMatch(/download 94,0 Mbit\/s/);
    expect(s.recent).toHaveLength(6);
  });

  it("menos de 3 testes anteriores: sem habitual e sem aviso de queda", () => {
    const [s] = summarizeThroughput([row(0, 10, 10), row(1, 900, 650)], new Map(), NOW);
    expect(s.label).toBe("Agente");
    expect(s.usualDownloadMbps).toBeNull();
    expect(s.warning).toBeNull();
  });
});
