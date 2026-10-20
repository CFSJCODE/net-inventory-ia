import { describe, expect, it } from "vitest";
import { EMPTY_STATE, evaluate, lossPct, parsePingOutput, type CheckState } from "./rules";

const opts = { badToFire: 2, goodToClear: 2, cooldownMs: 15 * 60_000 };
const MIN = 60_000;

function run(seq: boolean[], start: CheckState = EMPTY_STATE, t0 = 0) {
  let state = start;
  const events: (string | null)[] = [];
  seq.forEach((bad, i) => {
    const r = evaluate(state, bad, t0 + i * MIN, opts);
    state = r.state;
    events.push(r.event);
  });
  return { state, events };
}

describe("evaluate", () => {
  it("só alerta depois das checagens seguidas", () => {
    expect(run([true]).events).toEqual([null]);
    expect(run([true, true]).events).toEqual([null, "alert"]);
  });

  it("permite configurar alerta na primeira leitura fora do limite", () => {
    const immediate = { ...opts, badToFire: 1 };
    expect(evaluate(EMPTY_STATE, true, 0, immediate).event).toBe("alert");
  });

  it("um ponto bom no meio zera a contagem", () => {
    expect(run([true, false, true, false]).events).toEqual([null, null, null, null]);
  });

  it("não repete o alerta enquanto o problema continua", () => {
    expect(run([true, true, true, true, true]).events).toEqual([null, "alert", null, null, null]);
  });

  it("repete problema persistente quando termina o intervalo configurado", () => {
    let state = EMPTY_STATE;
    const events = [0, 1, 15, 16].map((minute) => {
      const result = evaluate(state, true, minute * MIN, { ...opts, badToFire: 1 });
      state = result.state;
      return result.event;
    });
    expect(events).toEqual(["alert", null, "alert", null]);
  });

  it("manda a recuperação depois de checagens boas seguidas", () => {
    const { events, state } = run([true, true, false, false]);
    expect(events).toEqual([null, "alert", null, "recovery"]);
    expect(state.active).toBe(false);
  });

  it("dentro do intervalo mínimo não manda alerta nem recuperação", () => {
    // Cai, volta e cai de novo em poucos minutos.
    const { events } = run([true, true, false, false, true, true, false, false]);
    expect(events).toEqual([null, "alert", null, "recovery", null, null, null, null]);
  });

  it("problema que começa no intervalo mínimo e continua depois dele é avisado quando o intervalo passa", () => {
    // Alerta em t=1min; volta; cai de novo em t=5min (sem e-mail) e segue caído: avisa em t=16min (15 min após o alerta).
    const seq = [true, true, false, false, ...Array<boolean>(13).fill(true), false, false];
    const { events } = run(seq);
    expect(events.indexOf("alert")).toBe(1);
    expect(events.lastIndexOf("alert")).toBe(16);
    expect(events.filter((e) => e === "alert")).toHaveLength(2);
    expect(events.at(-1)).toBe("recovery");
  });

  it("depois do intervalo mínimo volta a alertar", () => {
    const first = run([true, true, false, false]);
    const later = run([true, true], first.state, 30 * MIN);
    expect(later.events).toEqual([null, "alert"]);
  });
});

describe("parsePingOutput", () => {
  it("lê o ping do Windows em português", () => {
    const out = [
      "Disparando 192.168.0.1 com 32 bytes de dados:",
      "Resposta de 192.168.0.1: bytes=32 tempo=3ms TTL=64",
      "Resposta de 192.168.0.1: bytes=32 tempo<1ms TTL=64",
      "Esgotado o tempo limite do pedido.",
      "Resposta de 192.168.0.1: bytes=32 tempo=5ms TTL=64",
      "",
      "Estatísticas do Ping para 192.168.0.1:",
      "    Pacotes: Enviados = 4, Recebidos = 3, Perdidos = 1 (25% de perda),",
      "Aproximar um número redondo de vezes em milissegundos:",
      "    Mínimo = 0ms, Máximo = 5ms, Média = 2ms",
    ].join("\r\n");
    const p = parsePingOutput(out, 4);
    expect(p).toEqual({ sent: 4, received: 3, avgMs: 3 });
    expect(lossPct(p)).toBe(25);
  });

  it("lê o ping IPv6 do Windows, que não mostra TTL", () => {
    const out = [
      "Disparando fe80::1 com 32 bytes de dados:",
      "Resposta de fe80::1: tempo<1ms",
      "Resposta de fe80::1: tempo=2ms",
      "Esgotado o tempo limite do pedido.",
      "    Mínimo = 0ms, Máximo = 2ms, Média = 1ms",
    ].join("\r\n");
    expect(parsePingOutput(out, 3)).toEqual({ sent: 3, received: 2, avgMs: 1 });
  });

  it("host inacessível não conta como resposta", () => {
    const out = "Resposta de 192.168.0.10: Host de destino inacessível.\r\nResposta de 192.168.0.10: Host de destino inacessível.";
    expect(parsePingOutput(out, 2)).toEqual({ sent: 2, received: 0, avgMs: null });
  });

  it("lê o ping do Linux", () => {
    const out = "64 bytes from 192.168.0.1: icmp_seq=1 ttl=64 time=0.412 ms\n64 bytes from 192.168.0.1: icmp_seq=2 ttl=64 time=1.6 ms";
    expect(parsePingOutput(out, 2)).toEqual({ sent: 2, received: 2, avgMs: 1 });
  });
});
