import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./email-defaults";
import { buildAlertEmail, buildRecoveryEmail, buildTestEmail, observe, selectAlertObservations, targetName, type HostReading, type Observation } from "./alert-emails";

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
  lastPingAt: T0,
  lastLatencyMs: 3,
};
const offline: HostReading = { ...online, online: false, pingsReceived: 0, latencyMs: null, lossPct: 100, onlineSince: null, offlineSince: T0 - 2 * MIN, lastSeen: T0 - 3 * MIN, lastPingAt: T0 - 3 * MIN, lastLatencyMs: 4 };
const snmp: HostReading = { ...online, cpuPct: 93, memPct: 41, tempC: 52, uptimeMin: 3 * 1440 + 125 };

const modem = { host: "192.168.0.1", label: "Modem" };
const sw = { host: "192.168.0.3", label: "HP V1910-24G" };
const common = { at: T0, intervalMs: MIN, settings, since: T0 };

describe("observe", () => {
  it("equipamento vigiado: fora do ar e degradado; SNMP: cpu, memória e temperatura", () => {
    expect(observe(online, thresholds, true).map((o) => [o.kind, o.bad])).toEqual([
      ["offline", false],
      ["degraded", false],
      ["criticalLatency", false],
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
    expect(observe({ ...online, latencyMs: 700 }, thresholds, true).find((o) => o.kind === "criticalLatency")).toMatchObject({ bad: true, value: 700 });
  });

  it("filtra apenas métricas críticas no perfil crítico e todas no perfil completo", () => {
    const readings = observe({ ...snmp, latencyMs: 700 }, thresholds, true);
    expect(selectAlertObservations(readings, "critical").map((o) => o.kind)).toEqual(["offline", "criticalLatency"]);
    expect(selectAlertObservations(readings, "all").map((o) => o.kind)).toEqual(["offline", "degraded", "cpu", "mem", "temp"]);
  });
});

const obs = (reading: HostReading, kind: Observation["kind"], watched = true) => observe(reading, thresholds, watched).find((o) => o.kind === kind)!;

describe("buildAlertEmail", () => {
  it("fora do ar: assunto, resumo, última resposta e limites", () => {
    const e = buildAlertEmail({ ...common, target: modem, observation: obs(offline, "offline"), reading: offline, checks: 2 });
    expect(e.subject).toBe("🔴 Fora do ar: Modem (192.168.0.1)");
    expect(e.text).toContain("Modem (192.168.0.1) não respondeu a nenhum dos 4 pings nas últimas 2 verificações seguidas.");
    expect(e.text).toContain("- Status: Fora do ar há 2 min, desde ");
    expect(e.text).toMatch(/- Última resposta: .*, latência 4 ms/);
    expect(e.text).not.toContain("Último ping respondido");
    expect(e.text).toContain("- Ping: 0 de 4 respondidos");
    expect(e.text).toContain("- Endereço IP: 192.168.0.1");
    expect(e.text).toContain("LIMITES CONFIGURADOS");
    expect(e.text).not.toContain("- CPU: alerta a partir de 90%");
    expect(e.text).not.toContain("CPU, memória e temperatura");
    expect(e.text).toContain("- Latência média: alerta acima de 100 ms");
    expect(e.text).toContain("- Intervalo mínimo entre alertas: 15 min para o mesmo problema");
    expect(e.text).toContain("Você receberá outro e-mail quando o problema passar.");
    expect(e.html).toContain(">ALERTA<");
    expect(e.html).toContain("#dc2626");
  });

  it("fora do ar depois de responder só ao SNMP: última resposta e último ping em linhas separadas", () => {
    // O switch respondeu ao SNMP às T0-3min (ping já falhava); o último ping respondido foi às T0-10min.
    const r = { ...offline, lastSeen: T0 - 3 * MIN, lastPingAt: T0 - 10 * MIN, lastLatencyMs: 2 };
    const e = buildAlertEmail({ ...common, target: sw, observation: obs(r, "offline"), reading: r, checks: 2 });
    expect(e.text).toMatch(/- Última resposta: \S+ às \S+\n- Último ping respondido: \S+ às \S+, latência 2 ms/);
    const noPing = { ...r, lastPingAt: null, lastLatencyMs: null };
    expect(buildAlertEmail({ ...common, target: sw, observation: obs(noPing, "offline"), reading: noPing, checks: 2 }).text).not.toContain("Último ping");
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

  it("agrupa as métricas anormais no mesmo e-mail e inclui as demais leituras", () => {
    const r = { ...snmp, cpuPct: 97, tempC: 84 };
    const e = buildAlertEmail({
      ...common,
      target: sw,
      observation: obs(r, "cpu", false),
      additionalObservations: [obs(r, "temp", false)],
      reading: r,
      checks: 1,
    });
    expect(e.subject).toContain("CPU alta (97%) + Temperatura alta (84 °C)");
    expect(e.text).toContain("- CPU: 97% (limite ≥ 90%) [ACIMA DO LIMITE]");
    expect(e.text).toContain("- Temperatura: 84 °C (limite ≥ 80 °C) [ACIMA DO LIMITE]");
    expect(e.text).toContain("- Memória: 41% (limite ≥ 90%)");
    expect(e.text).toContain("Métrica anormal: CPU alta");
    expect(e.text).toContain("Métrica anormal: Temperatura alta");
  });

  it("degradado: latência e perda no assunto e no resumo", () => {
    const r = { ...online, pingsReceived: 3, latencyMs: 230, lossPct: 25 };
    const e = buildAlertEmail({ ...common, target: modem, observation: obs(r, "degraded"), reading: r, checks: 3 });
    expect(e.subject).toBe("🟠 Desempenho degradado (230 ms, 25% de perda): Modem (192.168.0.1)");
    expect(e.text).toContain("lenta ou instável nas últimas 3 verificações seguidas: latência média de 230 ms (limite 100 ms) e perda de 25% dos pacotes (limite 25%).");
    expect(e.text).toContain("- Tempo respondendo: há 1h 30min, desde ");
    expect(e.text).not.toContain("Tempo de atividade");
  });

  it("leitura igual ao limite: alerta, mas o texto não diz \"acima\"", () => {
    const r = { ...snmp, cpuPct: 90 };
    const o = obs(r, "cpu", false);
    expect(o.bad).toBe(true);
    const e = buildAlertEmail({ ...common, target: sw, observation: o, reading: r, checks: 3 });
    expect(e.subject).toBe("🟠 CPU alta (90%): HP V1910-24G (192.168.0.3)");
    expect(e.text).toContain("está em 90%, igual ao limite de 90%, nas últimas 3 verificações seguidas.");
  });

  it("equipamento SNMP sem os dados HP/H3C: diz que não informa, em vez de culpar o cadastro", () => {
    const r = { ...online, uptimeMin: 10 };
    const e = buildAlertEmail({ ...common, target: { host: "192.168.0.9", label: "Roteador" }, observation: obs(r, "degraded"), reading: { ...r, latencyMs: 300 }, checks: 3 });
    expect(e.text).toContain("- Tempo de atividade: 10 min (sysUpTime via SNMP)");
    expect(e.text).toContain("- CPU, memória e temperatura: não informados por este equipamento");
    expect(e.text).not.toContain("sem SNMP cadastrado");
  });

  it("alvo vigiado por nome: a linha do endereço não diz IP", () => {
    const e = buildAlertEmail({ ...common, target: { host: "meu-nas.local", label: null }, observation: obs(offline, "offline"), reading: offline, checks: 2 });
    expect(e.text).toContain("- Endereço: meu-nas.local");
    expect(e.text).not.toContain("Endereço IP");
  });

  it("aviso atrasado pelo intervalo mínimo: diz desde quando o problema está confirmado", () => {
    const r = { ...snmp, cpuPct: 95 };
    const e = buildAlertEmail({ ...common, target: sw, observation: obs(r, "cpu", false), reading: r, checks: 3, since: T0 - 16 * MIN });
    expect(e.text).toMatch(/está em 95%, acima do limite de 90%, desde \S+ às \S+ \(confirmado com 3 leituras seguidas\) e continua agora\./);
    expect(e.text).toMatch(/- Problema desde: .*\n- Avisado em: .* \(esperou o intervalo mínimo de 15 min entre alertas\)/);
    expect(e.text).not.toContain("Detectado em");
    expect(e.text).toContain("- Confirmação: 3 leituras seguidas com problema, uma a cada 1 min");
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
    expect(e.html).toContain("border-top:4px solid #16a34a");
  });

  it("CPU normalizada: leitura atual e limite", () => {
    const r = { ...snmp, cpuPct: 35 };
    const e = buildRecoveryEmail({ ...common, target: sw, observation: obs(r, "cpu", false), reading: r, since: null, alertUndelivered: false });
    expect(e.subject).toBe("🟢 CPU normalizada: HP V1910-24G (192.168.0.3)");
    expect(e.text).toContain("voltou ao normal: 35% (limite 90%).");
    const withSince = buildRecoveryEmail({ ...common, target: sw, observation: obs(r, "cpu", false), reading: r, since: T0 - 47 * MIN, alertUndelivered: false });
    expect(withSince.text).toContain("voltou ao normal depois de 47 min com o problema: 35% (limite 90%).");
    // Outra medida ainda estourada aparece em vermelho mesmo no e-mail verde.
    const stillHot = { ...r, tempC: 85 };
    expect(buildRecoveryEmail({ ...common, target: sw, observation: obs(stillHot, "cpu", false), reading: stillHot, since: null, alertUndelivered: false }).html).toContain("color:#dc2626;width:22%\">85 °C");
    expect(e.text).not.toContain("Duração");
    expect(e.text).not.toContain("não pôde ser enviado");
  });
});

describe("buildTestEmail", () => {
  it("lista configuração, limites, leituras de cada equipamento e os tipos de alerta", () => {
    const e = buildTestEmail({
      settings,
      equipment: [
        { target: modem, reading: online, snmpConfigured: false },
        { target: { host: "192.168.0.2", label: null }, reading: null, snmpConfigured: false },
        { target: sw, reading: snmp, snmpConfigured: true },
      ],
      activeProblems: 1,
      intervalMs: MIN,
      at: T0,
    });
    expect(e.subject).toBe("✅ Teste dos alertas do NetInventory: 2 de 2 equipamentos no ar");
    expect(e.text).toContain("- Enviar alertas para: cláudio@example.com");
    expect(e.text).toContain("- Fora do ar e desempenho (ping): Modem (192.168.0.1), 192.168.0.2, HP V1910-24G (192.168.0.3)\n");
    expect(e.text).toContain("- CPU, memória e temperatura (SNMP): HP V1910-24G (192.168.0.3)");
    expect(e.text).toContain("- Situação agora: 1 problema confirmado");
    expect(e.text).toContain("LEITURAS ATUAIS: MODEM (192.168.0.1)");
    expect(e.text).toContain("LEITURAS ATUAIS: 192.168.0.2\n- Status: ainda sem leitura");
    expect(e.text).toContain("LEITURAS ATUAIS: HP V1910-24G (192.168.0.3)");
    expect(e.text).toContain("- CPU: 93% (limite ≥ 90%) [ACIMA DO LIMITE]");
    expect(e.text).toContain("- Temperatura: alerta a partir de 80 °C");
    expect(e.text).toContain("Aviso de recuperação");
    expect(e.text).not.toContain("desativados");
    expect(e.html).toContain(">TESTE<");
  });

  it("avisa quando os alertas estão desativados e não mostra contagem velha de problemas", () => {
    const e = buildTestEmail({ settings: { ...settings, enabled: false }, equipment: [], activeProblems: 2, intervalMs: MIN, at: T0 });
    expect(e.text).toContain("os alertas ainda estão desativados");
    expect(e.text).toContain("- Alertas: desativados");
    expect(e.text).toContain("- Situação agora: verificação desligada");
    expect(e.text).not.toContain("2 problemas");
  });

  it("com muitos equipamentos: 6 completos, 30 no resumo, o resto só contado, e o e-mail fica abaixo do corte do Gmail", () => {
    const equipment = Array.from({ length: 60 }, (_, n) => ({
      target: { host: `192.168.0.${10 + n}`, label: `Aparelho com nome bem comprido número ${n + 1} (sala de equipamentos)` },
      reading: n === 59 ? null : { ...snmp, cpuPct: 20 + n, lossPct: n === 7 ? 25 : 0, pingsReceived: n === 7 ? 3 : 4 },
      snmpConfigured: true,
    }));
    const e = buildTestEmail({ settings, equipment, activeProblems: 0, intervalMs: MIN, at: T0 });
    expect(e.text).toContain("LEITURAS ATUAIS: APARELHO COM NOME BEM COMPRIDO NÚMERO 6 ");
    expect(e.text).not.toContain("LEITURAS ATUAIS: APARELHO COM NOME BEM COMPRIDO NÚMERO 7 ");
    expect(e.text).toContain("OUTROS 54 EQUIPAMENTOS (RESUMO)");
    expect(e.text).toContain("número 8 (sala de equipamentos) (192.168.0.17): No ar · 3 ms · 25% de perda · CPU 27% · memória 41% · 52 °C");
    expect(e.text).toContain("número 36 (sala de equipamentos) (192.168.0.45): No ar");
    expect(e.text).not.toContain("número 37 (sala de equipamentos) (192.168.0.46): ");
    expect(e.text).toMatch(/- CPU, memória e temperatura \(SNMP\): .*número 10 \(sala de equipamentos\) \(192\.168\.0\.19\) e mais 50\n/);
    expect(e.text).toContain("- Mais 24 equipamentos: não listados aqui");
    expect(e.html.length).toBeLessThan(100_000);
    // Sem leitura ainda: aparece como tal quando está entre os resumidos.
    const few = buildTestEmail({ settings, equipment: equipment.slice(0, 8).map((x, n) => (n === 7 ? { ...x, reading: null } : x)), activeProblems: 0, intervalMs: MIN, at: T0 });
    expect(few.text).toContain("OUTROS 2 EQUIPAMENTOS (RESUMO)");
    expect(few.text).toContain("(192.168.0.17): ainda sem leitura");
    expect(few.text).not.toContain("Mais ");
  });

  it("omite leituras e limites SNMP quando só há medição por ping", () => {
    const e = buildTestEmail({
      settings,
      equipment: [{ target: modem, reading: online, snmpConfigured: false }],
      activeProblems: 0,
      intervalMs: MIN,
      at: T0,
    });
    expect(e.text).toContain("- Ping: 4 de 4 respondidos, média 3 ms");
    expect(e.text).toContain("- Latência média: 3 ms");
    expect(e.text).not.toContain("CPU, memória e temperatura");
    expect(e.text).not.toContain("- CPU:");
    expect(e.text).not.toContain("- Memória:");
    expect(e.text).not.toContain("- Temperatura:");
    expect(e.text).not.toContain("não lidos (sem SNMP");
  });

});

describe("targetName", () => {
  it("nome com IP, ou só o IP", () => {
    expect(targetName(modem)).toBe("Modem (192.168.0.1)");
    expect(targetName({ host: "10.0.0.9", label: null })).toBe("10.0.0.9");
  });
});
