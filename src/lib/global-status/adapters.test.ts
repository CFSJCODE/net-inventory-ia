import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { componentStatus, parseStatuspageSummary, statuspageVersion } from "./adapters/statuspage";
import { parseGcpIncidents } from "./adapters/gcp";
import { parseAzureRss } from "./adapters/azure-rss";
import { worstStatus } from "./types";

// Respostas reais gravadas em 13/11/2026 (Cloudflare e Google Cloud recortados para caber no repositório).
const fixture = (name: string) => readFileSync(join(__dirname, "__fixtures__", name), "utf8");
const json = (name: string) => JSON.parse(fixture(name));

describe("Statuspage", () => {
  it("lê o summary do GitHub: indicador, componentes e incidentes", () => {
    const snap = parseStatuspageSummary(json("statuspage-github.json"));
    expect(snap.status).toBe("DEGRADED"); // indicador "minor" na gravação
    expect(snap.description).toBe("Serviço parcialmente degradado");
    expect(snap.components!.find((c) => c.name === "Git Operations")).toMatchObject({ status: "OK", groupName: null });
    expect(snap.incidents.length).toBeGreaterThan(0);
    for (const inc of snap.incidents) {
      expect(inc.externalId).toBeTruthy();
      expect(inc.startedAt).toBeInstanceOf(Date);
      expect(inc.resolvedAt).toBeNull();
    }
  });

  it("aceita o formato compatível da OpenAI (incident.io, ids ULID)", () => {
    const snap = parseStatuspageSummary(json("statuspage-openai.json"));
    expect(snap.components!.map((c) => c.name)).toContain("Chat Completions");
    expect(snap.status).not.toBe("UNKNOWN");
  });

  it("grava só componentes reais da Cloudflare, com o nome do grupo", () => {
    const data = json("statuspage-cloudflare.json");
    const snap = parseStatuspageSummary(data);
    const groupNames = new Set(data.components.filter((c: { group: boolean }) => c.group).map((c: { name: string }) => c.name));
    expect(snap.components!.some((c) => groupNames.has(c.name))).toBe(false);
    expect(snap.components!.find((c) => c.name.includes("(AMS)"))?.groupName).toBe("Europe");
    expect(snap.components!.find((c) => c.name.includes("(ALG)"))?.status).toBe("MAINTENANCE");
    expect(statuspageVersion(data)).toBe(data.page.updated_at);
  });

  it("traduz os estados de componente e manutenção em andamento", () => {
    expect(componentStatus("major_outage")).toBe("DOWN");
    expect(componentStatus("partial_outage")).toBe("DEGRADED");
    expect(componentStatus("algo-novo")).toBe("UNKNOWN");
    const snap = parseStatuspageSummary({
      status: { indicator: "none", description: "All Systems Operational" },
      components: [],
      incidents: [],
      scheduled_maintenances: [
        { id: "m1", name: "Janela de manutenção", status: "in_progress", impact: "maintenance", scheduled_for: "2026-11-13T20:00:00Z" },
        { id: "m2", name: "Antiga", status: "completed", impact: "maintenance", scheduled_for: "2026-11-01T20:00:00Z" },
        { id: "m3", name: "Futura", status: "scheduled", impact: "maintenance", scheduled_for: "2026-11-20T20:00:00Z" },
      ],
    });
    expect(snap.status).toBe("MAINTENANCE");
    expect(snap.incidents).toHaveLength(1);
    expect(snap.incidents[0]).toMatchObject({ externalId: "m1", impact: "MAINTENANCE" });
  });
});

describe("Google Cloud", () => {
  const data = json("gcp-incidents.json");

  it("sem incidente aberto fica OK e guarda os resolvidos dos últimos 30 dias", () => {
    const snap = parseGcpIncidents(data, new Date("2026-11-13T20:00:00Z"));
    expect(snap.status).toBe("OK");
    expect(snap.components).toEqual([]);
    // Gravados: só o de 20/10 está dentro de 30 dias; 09/10, 01/09 e 20/08 ficam de fora.
    expect(snap.incidents.map((i) => i.externalId)).toEqual(["Xs2XTHzAVC9YnafnPyzj"]);
    expect(snap.incidents[0]).toMatchObject({ state: "resolved", impact: "MAJOR" });
    expect(snap.incidents[0].url).toMatch(/^https:\/\/status\.cloud\.google\.com\/incidents\//);
  });

  it("incidente aberto marca os produtos afetados; SERVICE_OUTAGE vira fora do ar", () => {
    const open = data.map((i: Record<string, unknown>, n: number) => (n === 3 ? { ...i, end: null } : i));
    const snap = parseGcpIncidents(open, new Date("2026-11-13T20:00:00Z"));
    expect(open[3].status_impact).toBe("SERVICE_OUTAGE");
    expect(snap.status).toBe("DOWN");
    expect(snap.components!.length).toBeGreaterThan(0);
    expect(snap.components!.every((c) => c.status === "DOWN")).toBe(true);
    expect(snap.incidents.find((i) => i.externalId === open[3].id)).toMatchObject({ resolvedAt: null, impact: "CRITICAL" });
  });
});

describe("Azure RSS", () => {
  it("feed vazio = tudo normal", () => {
    const snap = parseAzureRss(fixture("azure-empty.xml"));
    expect(snap).toMatchObject({ status: "OK", components: null, incidents: [] });
  });

  it("cada item é um incidente ativo; 'outage' no título vira fora do ar", () => {
    const xml = `<rss><channel>
      <item><title>Mitigated - Degraded performance in Brazil South</title><link>https://azure.status.microsoft/x/1</link>
        <guid>a1</guid><pubDate>Fri, 13 Nov 2026 18:00:00 Z</pubDate><description><![CDATA[<p>Some customers &amp; services</p>]]></description></item>
      <item><title>Outage - Azure Front Door</title><guid>a2</guid><pubDate>Fri, 13 Nov 2026 19:00:00 Z</pubDate></item>
    </channel></rss>`;
    const snap = parseAzureRss(xml);
    expect(snap.status).toBe("DOWN");
    expect(snap.incidents.map((i) => i.externalId)).toEqual(["a1", "a2"]);
    expect(snap.incidents[0]).toMatchObject({ impact: "MINOR", url: "https://azure.status.microsoft/x/1", affected: "Some customers & services" });
    expect(snap.incidents[1].impact).toBe("MAJOR");
  });
});

it("o pior status vence", () => {
  expect(worstStatus(["OK", "MAINTENANCE", "DEGRADED"])).toBe("DEGRADED");
  expect(worstStatus(["OK", "DOWN", "DEGRADED"])).toBe("DOWN");
  expect(worstStatus([])).toBe("OK");
});
