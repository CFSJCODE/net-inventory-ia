import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./email-defaults";
import { buildAlertEmail, buildRecoveryEmail, buildTestEmail, observe, targetName, type HostReading, type Observation } from "./alert-emails";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 11, 15, 0);
const settings = { ...DEFAULT_SETTINGS, enabled: true, to: "cláudio@example.com" };
const thresholds = settings.thresholds;

const online: HostReading = {
  at: T0,
  online: true,
  pingsSent: 4,
  pingsReceived: 4,
  latencyMs: 3,
  lossPct: 0,
  cpuPct: null,
  memPct: null,
  tempC: null,
  uptimeMin: null,
  onlineSince: T0 - 90 * MIN,
  offlineSince: null,
  lastSeen: T0,
  lastLatencyMs: 3,
};
const offline: HostReading = { ...online, online: false, pingsReceived: 0, latencyMs: null, lossPct: 100, onlineSince: null, offlineSince: T0 - 2 * MIN, lastSeen: T0 - 3 * MIN, lastLatencyMs: 4 };
const snmp: HostReading = { ...online, cpuPct: 93, memPct: 41, tempC: 52, uptimeMin: 3 * 1440 + 125 };

const modem = { host: "192.168.0.1", label: "Modem" };
const sw = { host: "192.168.0.3", label: "HP V1910-24G" };
const common = { at: T0, intervalMs: MIN, settings };

describe("observe", () => {
  it("equipamento vigiado: fora do ar e degradado; SNMP: cpu, memória e temperatura", () => {
    expect(observe(online, thresholds, true).map((o) => [o.kind, o.bad])).toEqual([
      ["offline", false],
      ["degraded", false],
    ]);
    expect(observe(offline, thresholds, true).map((o) => [o.kind, o.bad])).toEqual([["offline", true]]);
    expect(observe(snmp, thresholds, false).map((o) => [o.kind, o.bad])).toEqual([
      ["cpu", true],
      ["mem", false],
      ["temp", false],
    ]);
  });

  it("degradado por latência ou por perda", () => {
    const slow = { ...online, latencyMs: 230 };
    const lossy = { ...online, pingsReceived: 3, lossPct: 25 };
    expect(observe(slow, thresholds, true)[1]).toMatchObject({ kind: "degraded", bad: true, value: 230 });
    expect(observe(lossy, thresholds, true)[1]).toMatchObject({ kind: "degraded", bad: true });
  });
});

const obs = (reading: HostReading, kind: Observation["kind"], watched = true) => observe(reading, thresholds, watched).find((o) => o.kind === kind)!;

describe("buildAlertEmail", () => {
  it("fora do ar: assunto, resumo, última resposta e limites", () => {
    const e = buildAlertEmail({ ...common, target: modem, observation: obs(offline, "offline"), reading: offline, checks: 2 });
    expect(e.subject).toBe("🔴 Fora do ar: Modem (192.168.0.1)");
    expect(e.text).toContain("Modem (192.168.0.1) não respondeu a nenhum dos 4 pings nas últimas 2 verificações seguidas.");
    expect(e.text).toContain("- Status: Fora do ar há 2 min, desde ");
    expect(e.text).toContain("latência 4 ms");
    expect(e.text).toContain("- Ping: 0 de 4 respondidos");
    expect(e.text).toContain("- Endereço IP: 192.168.0.1");
    expect(e.text).toContain("LIMITES CONFIGURADOS");
    expect(e.text).toContain("- CPU: alerta a partir de 90%");
    expect(e.text).toContain("- Latência média: alerta acima de 100 ms");
    expect(e.text).toContain("- Intervalo mínimo entre alertas: 15 min para o mesmo problema");
    expect(e.text).toContain("Você receberá outro e-mail quando o problema passar.");
    expect(e.html).toContain(">ALERTA<");
    expect(e.html).toContain("#dc2626");
  });

  it("CPU alta: valor no assunto, leituras com barra, uptime do SNMP", () => {
    const e = buildAlertEmail({ ...common, target: sw, observation: obs(snmp, "cpu", false), reading: snmp, checks: 3 });
    expect(e.subject).toBe("🟠 CPU alta (93%): HP V1910-24G (192.168.0.3)");
    expect(e.text).toContain("O uso de CPU de HP V1910-24G (192.168.0.3) está em 93%, acima do limite de 90%, nas últimas 3 verificações seguidas.");
    expect(e.text).toContain("- CPU: 93% (limite ≥ 90%) [ACIMA DO LIMITE]");
    expect(e.text).toContain("- Memória: 41% (limite ≥ 90%)");
    expect(e.text).toContain("- Temperatura: 52 °C (limite ≥ 80 °C)");
    expect(e.text).toContain("- Latência média: 3 ms (limite > 100 ms)");
    expect(e.text).toContain("- Tempo de atividade: 3d 2h (sysUpTime via SNMP)");
    expect(e.html).toContain("#ea580c");
  });

  it("degradado: latência e perda no assunto e no resumo", () => {
    const r = { ...online, pingsReceived: 3, latencyMs: 230, lossPct: 25 };
    const e = buildAlertEmail({ ...common, target: modem, observation: obs(r, "degraded"), reading: r, checks: 3 });
    expect(e.subject).toBe("🟠 Desempenho degradado (230 ms, 25% de perda): Modem (192.168.0.1)");
    expect(e.text).toContain("lenta ou instável nas últimas 3 verificações seguidas: latência média de 230 ms (limite 100 ms) e perda de 25% dos pacotes (limite 25%).");
    expect(e.text).toContain("- Tempo de atividade: respondendo há 1h 30min, desde ");
  });

  it("temperatura alta é crítica", () => {
    const r = { ...snmp, cpuPct: 20, tempC: 82 };
    const e = buildAlertEmail({ ...common, target: sw, observation: obs(r, "temp", false), reading: r, checks: 2 });
    expect(e.subject).toBe("🔴 Temperatura alta (82 °C): HP V1910-24G (192.168.0.3)");
    expect(e.text).toContain("chegou a 82 °C, acima do limite de 80 °C");
    expect(e.html).toContain("#dc2626");
  });
});

describe("buildRecoveryEmail", () => {
  it("voltou ao ar: duração no assunto e aviso do alerta que não saiu", () => {
    const e = buildRecoveryEmail({ ...common, target: modem, observation: obs(online, "offline"), reading: online, since: T0 - 18 * MIN, alertUndelivered: true });
    expect(e.subject).toBe("🟢 Voltou ao ar: Modem (192.168.0.1) (após 18 min)");
    expect(e.text).toContain("Modem (192.168.0.1) voltou a responder depois de 18 min fora do ar.");
    expect(e.text).toContain("- Duração: 18 min");
    expect(e.text).toContain("- Status: No ar");
    expect(e.text).toContain("não pôde ser enviado na hora");
    expect(e.html).toContain(">RECUPERADO<");
    expect(e.html).toContain("#16a34a");
  });

  it("CPU normalizada: leitura atual e limite", () => {
    const r = { ...snmp, cpuPct: 35 };
    const e = buildRecoveryEmail({ ...common, target: sw, observation: obs(r, "cpu", false), reading: r, since: null, alertUndelivered: false });
    expect(e.subject).toBe("🟢 CPU normalizada: HP V1910-24G (192.168.0.3)");
    expect(e.text).toContain("voltou ao normal: 35% (limite 90%).");
    expect(e.text).not.toContain("Duração");
    expect(e.text).not.toContain("não pôde ser enviado");
  });
});

describe("buildTestEmail", () => {
  it("lista configuração, limites, leituras de cada equipamento e os tipos de alerta", () => {
    const e = buildTestEmail({
      settings,
      equipment: [
        { target: modem, reading: online, snmp: false },
        { target: { host: "192.168.0.2", label: null }, reading: null, snmp: false },
        { target: sw, reading: snmp, snmp: true },
      ],
      activeProblems: 1,
      intervalMs: MIN,
      at: T0,
    });
    expect(e.subject).toBe("✅ Teste dos alertas do NetInventory: 2 de 2 equipamentos no ar");
    expect(e.text).toContain("- Enviar alertas para: cláudio@example.com");
    expect(e.text).toContain("- Fora do ar e desempenho (ping): Modem (192.168.0.1), 192.168.0.2");
    expect(e.text).toContain("- CPU, memória e temperatura (SNMP): HP V1910-24G (192.168.0.3)");
    expect(e.text).toContain("- Situação agora: 1 problema confirmado");
    expect(e.text).toContain("LEITURAS ATUAIS: MODEM (192.168.0.1)");
    expect(e.text).toContain("LEITURAS ATUAIS: 192.168.0.2\n- Status: ainda sem leitura");
    expect(e.text).toContain("LEITURAS ATUAIS: HP V1910-24G (192.168.0.3)");
    expect(e.text).toContain("- CPU: 93% (limite ≥ 90%) [ACIMA DO LIMITE]");
    expect(e.text).toContain("- Temperatura: alerta a partir de 80 °C");
    expect(e.text).toContain("🟢 Recuperação");
    expect(e.text).not.toContain("desativados");
    expect(e.html).toContain(">TESTE<");
  });

  it("avisa quando os alertas estão desativados", () => {
    const e = buildTestEmail({ settings: { ...settings, enabled: false }, equipment: [], activeProblems: 0, intervalMs: MIN, at: T0 });
    expect(e.text).toContain("os alertas ainda estão desativados");
    expect(e.text).toContain("- Alertas: desativados");
  });
});

describe("targetName", () => {
  it("nome com IP, ou só o IP", () => {
    expect(targetName(modem)).toBe("Modem (192.168.0.1)");
    expect(targetName({ host: "10.0.0.9", label: null })).toBe("10.0.0.9");
  });
});
