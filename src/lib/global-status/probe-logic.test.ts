import { describe, expect, it } from "vitest";
import {
  CHECK_RETENTION_MS,
  CLEARED_TARGET_DATA,
  DNS_REASON,
  MAX_ROLLUP_WINDOWS,
  ROLLUP_RETENTION_MS,
  advanceAgenda,
  buildRollups,
  cleanupCutoffs,
  clearedServiceData,
  closedWindows,
  decideConnectivity,
  dueAfterRun,
  endpointChanged,
  firstDueTimes,
  groupBaseline,
  hydrateTarget,
  initialRing,
  internetEvidence,
  isAnchor,
  isGatewayTarget,
  isInternetTarget,
  isStale,
  maintenanceDue,
  measurementPaused,
  needsEvidenceRound,
  neverAnsweredReason,
  nextConnectivity,
  nextDueTime,
  nextEvidenceStep,
  pauseServiceTargets,
  pauseToWrite,
  pausedReason,
  pausedRoundDue,
  pausedRoundTargets,
  pausedServiceData,
  pausedTargetData,
  pickCanaries,
  planRollup,
  probesEnabled,
  realignAgenda,
  reconcileTargets,
  recordResult,
  recordTick,
  respreadServices,
  ringMaxAgeMs,
  rollupStart,
  selectDue,
  servedMeasure,
  serviceData,
  serviceEvidence,
  settlePausedRound,
  sortByCatalog,
  summarizeService,
  unsourcedServiceData,
  type ConnectivityEvidence,
  type LoadedTarget,
  type Measurement,
  type ServiceEvidence,
  type TargetState,
  type TickProgress,
} from "./probe-logic";
import { BUCKET_MS, bucketStart, type RecentCheck } from "./stats";
import { AUTO_GATEWAY, AUTO_SYSTEM_DNS, type LocalConnectivity, type ProbeKind, type ProbePhase, type ProbeResult } from "./types";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** Meio-dia em ponto: início exato de uma janela de 5 min. */
const T0 = Date.parse("2026-11-14T12:00:00.000Z");

// ---------------------------------------------------------------- material dos testes

function target(over: Partial<TargetState> & Pick<TargetState, "id">): TargetState {
  return {
    serviceId: "github",
    serviceSlug: "github",
    category: "DEV",
    sourceType: "STATUSPAGE",
    key: "tcp",
    kind: "TCP",
    host: "github.example",
    url: null,
    port: 443,
    intervalSec: 30,
    dueAt: T0,
    ring: [],
    status: "UNKNOWN",
    reason: null,
    lastLatencyMs: null,
    everOk: false,
    beforePause: null,
    ...over,
  };
}

/** Os dois alvos de um serviço do catálogo: HTTP a cada 60 s e TCP 443 a cada 30 s. */
function service(slug: string, category: string, sourceType = "STATUSPAGE") {
  const base = { serviceId: slug, serviceSlug: slug, category, sourceType, host: `${slug}.example` };
  return {
    http: target({ ...base, id: `${slug}-http`, key: "http", kind: "HTTP", url: `https://${slug}.example/`, port: null, intervalSec: 60 }),
    tcp: target({ ...base, id: `${slug}-tcp`, key: "tcp", kind: "TCP", port: 443, intervalSec: 30 }),
  };
}

function internetTarget(id: string, serviceId: string, kind: ProbeKind, host: string, everOk = true): TargetState {
  const dns = kind === "DNS";
  return target({ id, serviceId, serviceSlug: serviceId, category: "INTERNET", sourceType: "NONE", key: dns ? "dns" : "ping", kind, host, url: dns ? "example.com" : null, port: null, intervalSec: dns ? 300 : 60, everOk });
}

/** Uma instalação pequena: 5 serviços de 4 categorias e a base da faixa "Sua Internet" (todos já responderam alguma vez). */
function world() {
  const github = service("github", "DEV");
  const cloudflare = service("cloudflare", "CDN");
  const netflix = service("netflix", "STREAMING", "NONE");
  const whatsapp = service("whatsapp", "SOCIAL", "NONE");
  const instagram = service("instagram", "SOCIAL", "NONE");
  const gateway = internetTarget("gateway", "rede-local", "ICMP", AUTO_GATEWAY);
  const systemDns = internetTarget("system-dns", "rede-local", "DNS", AUTO_SYSTEM_DNS);
  const ping1 = internetTarget("ping-1", "dns-cloudflare", "ICMP", "1.1.1.1");
  const dns1 = internetTarget("dns-1", "dns-cloudflare", "DNS", "1.1.1.1");
  const ping8 = internetTarget("ping-8", "dns-google", "ICMP", "8.8.8.8");
  const dns8 = internetTarget("dns-8", "dns-google", "DNS", "8.8.8.8");
  const services = [github, cloudflare, netflix, whatsapp, instagram].flatMap((s) => [s.http, s.tcp]);
  const internet = [gateway, systemDns, ping1, dns1, ping8, dns8];
  return { github, cloudflare, netflix, whatsapp, instagram, gateway, systemDns, ping1, dns1, ping8, dns8, services, internet, all: [...services, ...internet] };
}

const up = (latencyMs = 20, extra: Partial<ProbeResult> = {}): ProbeResult => ({ ok: true, latencyMs, ...extra });
const down = (failedAt: ProbePhase = "connect", error = "tempo esgotado ao conectar"): ProbeResult => ({ ok: false, latencyMs: null, error, failedAt });
const noPing: ProbeResult = { ok: false, latencyMs: null, unsupported: true, error: "ping indisponível neste servidor" };
const noReply: ProbeResult = { ok: false, latencyMs: null, lossPct: 100, error: "sem resposta ao ping", failedAt: "connect" };

const measured = (t: TargetState, result: ProbeResult, at = T0): Measurement => ({ target: t, at: new Date(at), result });
const byId = (targets: TargetState[]) => new Map(targets.map((t) => [t.id, t]));
const ids = (list: { id: string }[]) => list.map((t) => t.id);
const check = (ok: boolean, latencyMs: number | null = ok ? 20 : null): RecentCheck => ({ ok, latencyMs, lossPct: null, certDays: null });

/**
 * Conduz um passo como o agendador: mede os vencidos e depois o que a lógica pedir (canários, alvos de
 * Internet), até ela decidir. `probe` faz o papel da rede.
 */
function runTick(all: TargetState[], due: TargetState[], probe: (t: TargetState) => ProbeResult, options: { rotation?: number; gatewayIp?: string | null } = {}) {
  const rotation = options.rotation ?? 0;
  const asked: { canaries: string[] | null; internet: string[] | null } = { canaries: null, internet: null };
  let progress: TickProgress = { measured: due.map((t) => measured(t, probe(t))), canaries: null, internet: null, gatewayIp: null };
  let step = nextEvidenceStep(all, progress, rotation);
  while (step.kind !== "done") {
    const results = step.targets.map((t) => measured(t, probe(t)));
    asked[step.kind] = ids(step.targets);
    progress = step.kind === "canaries" ? { ...progress, canaries: results } : { ...progress, internet: results, gatewayIp: options.gatewayIp ?? null };
    step = nextEvidenceStep(all, progress, rotation);
  }
  return { decision: step.decision, record: step.record, recorded: step.record.map((m) => m.target.id), asked };
}

/** Quantos alvos vencem em cada passo de 5 s a partir de `start`. */
function loadPerTick(due: Iterable<number>, start: number): number[] {
  const load: number[] = [];
  for (const at of due) {
    const tick = Math.ceil((at - start) / (5 * SEC));
    load[tick] = (load[tick] ?? 0) + 1;
  }
  return Array.from(load, (n) => n ?? 0);
}

// ---------------------------------------------------------------- liga/desliga e vocabulário

describe("GLOBAL_STATUS_PROBES", () => {
  it("só o valor off desliga as medições", () => {
    expect(probesEnabled(undefined)).toBe(true);
    expect(probesEnabled("")).toBe(true);
    expect(probesEnabled("on")).toBe(true);
    expect(probesEnabled("off")).toBe(false);
    expect(probesEnabled(" OFF ")).toBe(false);
  });
});

describe("tipos de alvo", () => {
  const w = world();

  it("alvo de Internet é o de um serviço da categoria INTERNET", () => {
    expect(w.internet.every(isInternetTarget)).toBe(true);
    expect(w.services.some(isInternetTarget)).toBe(false);
  });

  it("âncora é o alvo de Internet com IP literal, tanto o ping quanto o DNS do resolvedor", () => {
    expect(ids(w.all.filter(isAnchor))).toEqual(["ping-1", "dns-1", "ping-8", "dns-8"]);
    expect(isAnchor(internetTarget("v6", "dns-x", "ICMP", "2606:4700:4700::1111"))).toBe(true);
    // Um serviço comum com IP literal não é testemunha da saída para a Internet.
    expect(isAnchor(target({ id: "ip", host: "1.1.1.1" }))).toBe(false);
  });

  it("o gateway é o alvo de Internet com host auto:gateway", () => {
    expect(ids(w.all.filter(isGatewayTarget))).toEqual(["gateway"]);
  });
});

describe("ordem do catálogo", () => {
  const catalog = [
    { slug: "cloudflare", targets: [{ key: "http", kind: "HTTP" as const, host: "a" }, { key: "tcp", kind: "TCP" as const, host: "a" }] },
    { slug: "github", targets: [{ key: "http", kind: "HTTP" as const, host: "b" }, { key: "tcp", kind: "TCP" as const, host: "b" }] },
  ];
  const row = (serviceSlug: string, key: string) => ({ serviceSlug, key });

  it("serviços na ordem do catálogo e alvos na ordem declarada, com o que é desconhecido por último", () => {
    const sorted = sortByCatalog([row("zeta", "tcp"), row("github", "tcp"), row("github", "extra"), row("cloudflare", "tcp"), row("github", "http"), row("alfa", "http"), row("cloudflare", "http")], catalog);
    expect(sorted.map((t) => `${t.serviceSlug}/${t.key}`)).toEqual(["cloudflare/http", "cloudflare/tcp", "github/http", "github/tcp", "github/extra", "alfa/http", "zeta/tcp"]);
  });

  it("não altera a lista recebida", () => {
    const rows = [row("github", "tcp"), row("cloudflare", "http")];
    sortByCatalog(rows, catalog);
    expect(rows[0].serviceSlug).toBe("github");
  });
});

// ---------------------------------------------------------------- agenda

describe("primeiros vencimentos", () => {
  /** O catálogo completo: 21 serviços (HTTP 60 s + TCP 30 s) e 8 alvos de Internet (4 pings de 60 s e 4 DNS de 5 min). */
  const catalogTargets = [
    ...Array.from({ length: 21 }, (_, i) => ({ id: `tcp-${String(i).padStart(2, "0")}`, intervalSec: 30 })),
    ...Array.from({ length: 21 }, (_, i) => ({ id: `http-${String(i).padStart(2, "0")}`, intervalSec: 60 })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `ping-${i}`, intervalSec: 60 })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `dns-${i}`, intervalSec: 300 })),
  ];

  it("em um grupo de m alvos de mesmo intervalo, o alvo j vence em início + (j ÷ m) × intervalo", () => {
    const due = firstDueTimes([{ id: "a", intervalSec: 30 }, { id: "b", intervalSec: 30 }, { id: "c", intervalSec: 30 }], T0);
    expect([due.get("a"), due.get("b"), due.get("c")]).toEqual([T0, T0 + 10 * SEC, T0 + 20 * SEC]);
  });

  it("a posição vem da ordem dos ids, não da ordem em que os alvos chegaram", () => {
    const due = firstDueTimes([{ id: "c", intervalSec: 30 }, { id: "a", intervalSec: 30 }, { id: "b", intervalSec: 30 }], T0);
    expect([due.get("a"), due.get("b"), due.get("c")]).toEqual([T0, T0 + 10 * SEC, T0 + 20 * SEC]);
  });

  it("cada intervalo é um grupo à parte", () => {
    const due = firstDueTimes([{ id: "a", intervalSec: 30 }, { id: "b", intervalSec: 60 }, { id: "c", intervalSec: 30 }, { id: "d", intervalSec: 60 }], T0);
    expect([due.get("a"), due.get("c")]).toEqual([T0, T0 + 15 * SEC]);
    expect([due.get("b"), due.get("d")]).toEqual([T0, T0 + 30 * SEC]);
  });

  it("intervalos longos se espalham em 60 s: tudo tem o primeiro valor no primeiro minuto", () => {
    const due = firstDueTimes(Array.from({ length: 4 }, (_, i) => ({ id: `dns-${i}`, intervalSec: 300 })), T0);
    expect(Array.from(due.values())).toEqual([T0, T0 + 15 * SEC, T0 + 30 * SEC, T0 + 45 * SEC]);
  });

  it("espalha o catálogo inteiro sem juntar tudo num passo", () => {
    const due = firstDueTimes(catalogTargets, T0);
    expect(due.size).toBe(50);
    const times = Array.from(due.values());
    expect(Math.min(...times)).toBe(T0);
    expect(Math.max(...times)).toBeLessThan(T0 + 60 * SEC);
    // Os 21 TCP cabem em 30 s e nenhum vence junto com outro do mesmo grupo.
    const tcp = catalogTargets.filter((t) => t.intervalSec === 30).map((t) => due.get(t.id)!);
    expect(new Set(tcp).size).toBe(21);
    expect(Math.max(...tcp)).toBeLessThan(T0 + 30 * SEC);
    // Passos de 5 s: no pior passo vencem 8 dos 50 alvos (4 TCP, 3 de 60 s e 1 DNS), o que cabe nas 8 sondas simultâneas.
    const load = loadPerTick(times, T0);
    expect(load.reduce((a, b) => a + b, 0)).toBe(50);
    expect(Math.max(...load)).toBeLessThanOrEqual(8);
    expect(Math.max(...loadPerTick(tcp, T0))).toBeLessThanOrEqual(4);
  });
});

describe("próximo vencimento", () => {
  it("é o vencimento anterior + intervalo, mesmo quando o passo atrasa: o alvo não sai do seu lugar na agenda", () => {
    expect(nextDueTime(T0, 30, T0)).toBe(T0 + 30 * SEC);
    expect(nextDueTime(T0, 30, T0 + 4 * SEC)).toBe(T0 + 30 * SEC);
    expect(nextDueTime(T0, 30, T0 + 29 * SEC)).toBe(T0 + 30 * SEC);
  });

  it("medições perdidas são puladas: depois de uma parada o alvo volta no seu lugar da agenda, uma medição só", () => {
    const now = T0 + 10 * MIN;
    const next = nextDueTime(T0, 30, now);
    expect(next).toBe(now + 30 * SEC);
    // A seguinte volta ao ritmo normal, sem pagar as 19 que ficaram para trás.
    expect(nextDueTime(next, 30, next + 2 * SEC)).toBe(next + 30 * SEC);
    // O lugar é o do vencimento anterior, não o da hora em que o passo rodou: 7 s depois ainda é T0 + 10 min 30 s.
    expect(nextDueTime(T0, 30, now + 7 * SEC)).toBe(now + 30 * SEC);
    expect(nextDueTime(T0 + 11 * SEC, 30, now)).toBe(now + 11 * SEC);
    expect(nextDueTime(T0 + 11 * SEC, 60, now + 20 * SEC)).toBe(now + 11 * SEC + MIN);
  });

  it("um passo demorado não junta os alvos atrasados no mesmo instante: cada um segue no seu lugar", () => {
    // 21 alvos TCP espalhados em 30 s, como no catálogo.
    const list = Array.from({ length: 21 }, (_, i) => target({ id: `t${String(i).padStart(2, "0")}`, intervalSec: 30 }));
    const first = firstDueTimes(list, T0);
    let state = byId(list.map((t) => ({ ...t, dueAt: first.get(t.id)! })));
    const tick = (now: number) => {
      state = advanceAgenda(state, ids(selectDue(Array.from(state.values()), now)), now);
    };
    for (let now = T0; now < T0 + MIN; now += 5 * SEC) tick(now);
    // Um passo que só roda 40 s depois do anterior (rodada de evidência demorada, máquina suspensa): todos estão vencidos.
    const late = T0 + MIN + 35 * SEC;
    expect(selectDue(Array.from(state.values()), late)).toHaveLength(21);
    tick(late);
    const due = Array.from(state.values(), (t) => t.dueAt);
    expect(new Set(due).size).toBe(21);
    expect(due.every((at) => at > late && at <= late + 30 * SEC)).toBe(true);
    // E continua espalhado: nenhum passo de 5 s recebe mais que 4 dos 21.
    expect(Math.max(...loadPerTick(due, late))).toBeLessThanOrEqual(4);
  });

  it("um vencimento que cairia exatamente agora já passou", () => {
    expect(nextDueTime(T0, 30, T0 + 30 * SEC)).toBe(T0 + 60 * SEC);
  });

  it("um alvo em dia mantém o ritmo por horas, sem deriva, com passos de 5 s", () => {
    let state = byId([target({ id: "a", intervalSec: 30, dueAt: T0 + 2 * SEC })]);
    const runs: number[] = [];
    for (let now = T0; now <= T0 + HOUR; now += 5 * SEC) {
      const due = selectDue(Array.from(state.values()), now);
      if (due.length) runs.push(now);
      state = advanceAgenda(state, ids(due), now);
    }
    expect(runs).toHaveLength(120);
    expect(runs[0]).toBe(T0 + 5 * SEC);
    expect(runs.every((at, i) => i === 0 || at - runs[i - 1] === 30 * SEC)).toBe(true);
  });

  it("depois de uma parada cada alvo é medido uma vez, não uma vez por medição perdida", () => {
    let state = byId([target({ id: "a", intervalSec: 30, dueAt: T0 }), target({ id: "b", intervalSec: 60, dueAt: T0 + 20 * SEC })]);
    const runs: Record<string, number[]> = { a: [], b: [] };
    const tick = (now: number) => {
      const due = selectDue(Array.from(state.values()), now);
      for (const t of due) runs[t.id].push(now);
      state = advanceAgenda(state, ids(due), now);
    };
    tick(T0);
    // O servidor fica 10 min parado (suspensão, por exemplo) e volta a rodar passos de 5 s por 1 min.
    for (let now = T0 + 10 * MIN; now < T0 + 11 * MIN; now += 5 * SEC) tick(now);
    expect(runs.a).toEqual([T0, T0 + 10 * MIN, T0 + 10 * MIN + 30 * SEC]);
    // O alvo de 60 s volta no lugar dele (20 s depois do minuto), não um intervalo inteiro depois da volta.
    expect(runs.b).toEqual([T0 + 10 * MIN, T0 + 10 * MIN + 20 * SEC]);
  });
});

describe("relógio do sistema que volta", () => {
  // Acerto de hora, ou máquina virtual retomada: "agora" passa a ser antes do que já foi anotado.
  const back = T0 - HOUR;

  it("o que tem idade negativa conta como vencido: listas em memória, rodada com a conexão fora e manutenção", () => {
    expect(isStale(T0, back, 5 * MIN)).toBe(true);
    expect(pausedRoundDue(T0, back)).toBe(true);
    expect(maintenanceDue({ rollupAt: T0, cleanupAt: T0 }, back)).toEqual({ rollup: true, cleanup: true });
    // No sentido normal do tempo nada muda.
    expect(isStale(T0, T0 + SEC, 5 * MIN)).toBe(false);
    expect(pausedRoundDue(T0, T0 + 29 * SEC)).toBe(false);
    expect(maintenanceDue({ rollupAt: T0, cleanupAt: T0 }, T0 + 30 * SEC)).toEqual({ rollup: false, cleanup: false });
  });

  it("os vencimentos que ficaram no futuro voltam para dentro do intervalo, cada alvo no seu lugar", () => {
    const state = byId([
      target({ id: "a", intervalSec: 30, dueAt: T0 + 12 * SEC }),
      target({ id: "b", intervalSec: 30, dueAt: T0 + 20 * SEC }),
      target({ id: "c", intervalSec: 60, dueAt: T0 + 45 * SEC }),
    ]);
    // Sem o ajuste nenhum alvo venceria por uma hora.
    expect(selectDue(Array.from(state.values()), back)).toEqual([]);
    const realigned = realignAgenda(state, back);
    expect(Array.from(realigned.values(), (t) => t.dueAt - back)).toEqual([12 * SEC, 20 * SEC, 45 * SEC]);
    // O que não é agenda fica igual, e o mapa recebido não é alterado.
    expect(realigned.get("a")).toEqual({ ...state.get("a")!, dueAt: back + 12 * SEC });
    expect(state.get("a")!.dueAt).toBe(T0 + 12 * SEC);
  });

  it("um vencimento a exatamente um múltiplo do intervalo vence agora", () => {
    const realigned = realignAgenda(byId([target({ id: "a", intervalSec: 30, dueAt: T0 })]), back);
    expect(realigned.get("a")!.dueAt).toBe(back);
  });

  it("com o relógio normal a agenda não é tocada: devolve o mesmo mapa", () => {
    const state = byId([target({ id: "a", intervalSec: 30, dueAt: T0 + 30 * SEC }), target({ id: "b", intervalSec: 60, dueAt: T0 - 3 * SEC }), target({ id: "c", intervalSec: 300, dueAt: T0 + 60 * SEC })]);
    expect(realignAgenda(state, T0)).toBe(state);
    // Alvo atrasado (o servidor ficou parado) não é assunto daqui: quem o trata é o próximo vencimento.
    expect(realignAgenda(byId([target({ id: "a", dueAt: T0 - HOUR })]), T0).get("a")!.dueAt).toBe(T0 - HOUR);
  });

  it("um intervalo que diminuiu numa versão nova do catálogo também volta para dentro do intervalo novo", () => {
    const realigned = realignAgenda(byId([target({ id: "a", intervalSec: 30, dueAt: T0 + 50 * SEC })]), T0);
    expect(realigned.get("a")!.dueAt).toBe(T0 + 20 * SEC);
  });

  it("depois do ajuste os alvos voltam a ser medidos no ritmo de sempre", () => {
    let state = realignAgenda(byId([target({ id: "a", intervalSec: 30, dueAt: T0 + 12 * SEC })]), back);
    const runs: number[] = [];
    for (let now = back; now < back + 2 * MIN; now += 5 * SEC) {
      const due = selectDue(Array.from(state.values()), now);
      if (due.length) runs.push(now - back);
      state = advanceAgenda(state, ids(due), now);
    }
    expect(runs).toEqual([15 * SEC, 45 * SEC, 75 * SEC, 105 * SEC]);
  });
});

describe("passo forçado e medição fora de hora", () => {
  const states = [target({ id: "a", dueAt: T0 - SEC }), target({ id: "b", dueAt: T0 + 12 * SEC }), target({ id: "c", dueAt: T0 + 25 * SEC, intervalSec: 60 })];

  it("o passo normal mede só os vencidos; o forçado mede todos", () => {
    expect(ids(selectDue(states, T0))).toEqual(["a"]);
    expect(ids(selectDue(states, T0 + 12 * SEC))).toEqual(["a", "b"]);
    expect(ids(selectDue(states, T0, true))).toEqual(["a", "b", "c"]);
  });

  it("o passo forçado deixa a agenda como estava, para o espalhamento sobreviver", () => {
    const before = byId(states);
    const after = advanceAgenda(before, ids(selectDue(states, T0, true)), T0, { force: true });
    expect(Array.from(after.values(), (t) => t.dueAt)).toEqual([T0 - SEC, T0 + 12 * SEC, T0 + 25 * SEC]);
    expect(dueAfterRun(T0 - SEC, 30, T0, { force: true })).toBe(T0 - SEC);
  });

  it("o passo normal avança só os alvos medidos", () => {
    const after = advanceAgenda(byId(states), ["a"], T0);
    expect(Array.from(after.values(), (t) => t.dueAt)).toEqual([T0 + 29 * SEC, T0 + 12 * SEC, T0 + 25 * SEC]);
  });

  it("alvo medido fora de hora (rodada de evidência) mantém o vencimento", () => {
    expect(dueAfterRun(T0 + 12 * SEC, 30, T0)).toBe(T0 + 12 * SEC);
    const after = advanceAgenda(byId(states), ["a", "b", "inexistente"], T0);
    expect(after.get("b")!.dueAt).toBe(T0 + 12 * SEC);
    expect(after.size).toBe(3);
  });
});

describe("lista de alvos em memória", () => {
  const loaded = (id: string, over: Partial<LoadedTarget> = {}): LoadedTarget => {
    const { dueAt, ring, reason, everOk, beforePause, ...info } = target({ id });
    void dueAt; void ring; void reason; void everOk; void beforePause;
    return { ...info, statusReason: null, ...over };
  };

  it("é relida quando nunca foi carregada, a cada 5 min, ou num passo forçado", () => {
    expect(isStale(0, T0, 5 * MIN)).toBe(true);
    expect(isStale(T0, T0 + 5 * MIN - 1, 5 * MIN)).toBe(false);
    expect(isStale(T0, T0 + 5 * MIN, 5 * MIN)).toBe(true);
    expect(isStale(T0, T0 + SEC, 5 * MIN, true)).toBe(true);
  });

  it("na primeira carga todos são novos: primeiro vencimento espalhado e o estado gravado na linha", () => {
    const { targets, added } = reconcileTargets(new Map(), [loaded("a", { status: "DOWN", statusReason: "3 falhas seguidas", lastLatencyMs: null }), loaded("b", { status: "OK", lastLatencyMs: 18 })], T0);
    expect(added).toEqual(["a", "b"]);
    expect(targets.get("a")).toMatchObject({ dueAt: T0, status: "DOWN", reason: "3 falhas seguidas", ring: [], everOk: false, beforePause: null });
    expect(targets.get("b")).toMatchObject({ dueAt: T0 + 15 * SEC, status: "OK", lastLatencyMs: 18 });
  });

  it("um estado que o alvo não pode ter vira Sem dados", () => {
    const { targets } = reconcileTargets(new Map(), [loaded("a", { status: "MAINTENANCE" }), loaded("b", { status: "qualquer" })], T0);
    expect(Array.from(targets.values(), (t) => t.status)).toEqual(["UNKNOWN", "UNKNOWN"]);
  });

  it("alvo que sumiu é descartado, o novo ganha vencimento e os demais mantêm agenda e histórico com a ficha atualizada", () => {
    const kept = target({ id: "a", dueAt: T0 + 7 * SEC, ring: [check(false), check(true)], status: "OK", lastLatencyMs: 20, everOk: true, intervalSec: 30 });
    const gone = target({ id: "z" });
    const later = T0 + 5 * MIN;
    const { targets, added } = reconcileTargets(byId([kept, gone]), [loaded("a", { status: "DOWN", intervalSec: 45, category: "CLOUD", sourceType: "NONE" }), loaded("n")], later);
    expect(added).toEqual(["n"]);
    expect(Array.from(targets.keys())).toEqual(["a", "n"]);
    // O estado em memória vale mais que a linha do banco; a ficha (intervalo, categoria, fonte) é a do banco.
    expect(targets.get("a")).toMatchObject({ dueAt: T0 + 7 * SEC, ring: [check(false), check(true)], status: "OK", lastLatencyMs: 20, everOk: true, intervalSec: 45, category: "CLOUD", sourceType: "NONE" });
    expect(targets.get("n")!.dueAt).toBeGreaterThanOrEqual(later);
    expect(targets.get("n")!.dueAt).toBeLessThan(later + 60 * SEC);
  });

  it("alvo que mudou de endereço conta como novo: as medições recentes eram do endereço antigo", () => {
    const kept = target({ id: "a", dueAt: T0 + 7 * SEC, ring: [check(false), check(false), check(false)], status: "DOWN", reason: "3 falhas seguidas", everOk: true });
    for (const change of [{ host: "novo.example" }, { port: 8443 }, { kind: "TLS" as const }, { url: "https://novo.example/" }]) {
      const { targets, added } = reconcileTargets(byId([kept]), [loaded("a", { status: "UNKNOWN", ...change })], T0 + 5 * MIN);
      expect(added).toEqual(["a"]);
      expect(targets.get("a")).toMatchObject({ ring: [], status: "UNKNOWN", reason: null, everOk: false, ...change });
      expect(targets.get("a")!.dueAt).toBeGreaterThanOrEqual(T0 + 5 * MIN);
    }
  });

  it("o histórico inicial são as 5 medições mais novas, sem misturar com as de outra época", () => {
    expect(ringMaxAgeMs(30)).toBe(10 * MIN);
    expect(ringMaxAgeMs(60)).toBe(10 * MIN);
    expect(ringMaxAgeMs(300)).toBe(50 * MIN);

    const at = (minutesAgo: number, ok: boolean) => ({ ...check(ok), at: new Date(T0 - minutesAgo * MIN) });
    // Fora de ordem, 7 medições recentes e 2 de antes de uma parada de 11 min.
    const checks = [at(3, true), at(1, false), at(2, true), at(4, true), at(5, false), at(6, true), at(7, true), at(11, false), at(12, false)];
    const ring = initialRing(checks, 60, T0);
    expect(ring.map((c) => c.ok)).toEqual([false, true, true, true, false]);
    expect(ring[0]).toEqual(check(false));
    // Só restam as velhas: o alvo começa sem histórico.
    expect(initialRing([at(11, false), at(12, false)], 60, T0)).toEqual([]);
    // DNS mede a cada 5 min: a janela é de 50 min.
    expect(initialRing([at(45, true), at(55, true)], 300, T0)).toHaveLength(1);
  });

  it("o alvo recém-carregado recebe o histórico e se já respondeu alguma vez", () => {
    const fresh = internetTarget("ping-1", "dns-cloudflare", "ICMP", "1.1.1.1", false);
    const hydrated = hydrateTarget(fresh, { checks: [{ ...check(true, 12), at: new Date(T0 - MIN) }], everOk: true }, T0);
    expect(hydrated).toMatchObject({ id: "ping-1", ring: [check(true, 12)], everOk: true, dueAt: fresh.dueAt });
    expect(fresh.ring).toEqual([]);
  });

  describe("alvo que o banco guarda como pausado (o servidor parou durante uma queda da conexão local)", () => {
    const stored = target({ id: "http", key: "http", kind: "HTTP", intervalSec: 60, status: "UNKNOWN", reason: pausedReason("offline") });
    // As últimas medições dele, mais nova primeiro, todas de antes da pausa e mais velhas que as que entram como recentes.
    const wasDown = [check(false), check(false), check(false), check(true), check(true)];
    const hydrate = (lastChecks: RecentCheck[] | undefined, state = stored) => hydrateTarget(state, { checks: [], everOk: false, lastChecks }, T0);

    it("recebe o veredito de antes da pausa, recalculado das últimas medições dele, e segue pausado", () => {
      expect(hydrate(wasDown)).toMatchObject({ status: "UNKNOWN", reason: pausedReason("offline"), ring: [], beforePause: { status: "DOWN", reason: "3 falhas seguidas" } });
      expect(hydrate([check(false), check(false), check(true)]).beforePause).toEqual({ status: "DEGRADED", reason: "2 falhas seguidas" });
      expect(hydrate([check(true), check(false), check(false)]).beforePause).toEqual({ status: "OK", reason: null });
      // O certificado vencido não depende da linha de base, que não existe mais para aquela hora.
      expect(hydrate([{ ...check(true), certDays: -3 }]).beforePause).toEqual({ status: "DEGRADED", reason: "certificado vencido" });
      // Só as 5 mais novas contam: a sexta, mais velha, não muda o veredito.
      expect(hydrate([check(true), check(true), check(true), check(true), check(true), check(false)]).beforePause).toEqual({ status: "OK", reason: null });
    });

    it("sem nenhuma medição guardada não há veredito a recuperar", () => {
      expect(hydrate([]).beforePause).toBeNull();
      expect(hydrate(undefined).beforePause).toBeNull();
    });

    it("um alvo que não está pausado não recebe veredito das medições velhas: para ele valem só as recentes", () => {
      const down = target({ id: "http", status: "DOWN", reason: "3 falhas seguidas" });
      expect(hydrate(wasDown, down)).toMatchObject({ status: "DOWN", ring: [], beforePause: null });
      // Sem dados por outro motivo (a sonda não roda neste servidor) também não é pausa.
      expect(hydrate(wasDown, target({ id: "ping", status: "UNKNOWN", reason: "ping indisponível neste servidor" })).beforePause).toBeNull();
    });

    it("a conexão volta: o alvo que estava fora do ar continua fora na primeira falha, sem passar por Sem dados, ok e degradado", () => {
      const recorded = recordResult(hydrate(wasDown), down(), new Date(T0));
      expect(recorded.update).toMatchObject({ status: "DOWN", statusReason: "3 falhas seguidas" });
      // Sem o veredito recuperado, a mesma falha deixaria o alvo "Sem dados", e o serviço valeria pelo outro alvo.
      expect(recordResult(hydrate([]), down(), new Date(T0)).update).toMatchObject({ status: "UNKNOWN", statusReason: null });
    });
  });
});

// ---------------------------------------------------------------- canários

describe("pickCanaries", () => {
  /** 10 serviços em 4 categorias, na ordem do catálogo, mais alvos que nunca podem ser canário. */
  const catalog: [string, string][] = [
    ["cloudflare", "CDN"], ["akamai", "CDN"], ["azure", "CLOUD"], ["github", "DEV"],
    ["whatsapp", "SOCIAL"], ["instagram", "SOCIAL"], ["facebook", "SOCIAL"], ["youtube", "SOCIAL"], ["discord", "SOCIAL"], ["reddit", "SOCIAL"],
  ];
  const candidates = [...catalog.flatMap(([slug, category]) => { const s = service(slug, category); return [s.http, s.tcp]; }), ...world().internet];
  const categoryOf = new Map(catalog);

  it("escolhe 3 alvos TCP de serviços e categorias diferentes", () => {
    const picked = pickCanaries(candidates, { count: 3, rotation: 0 });
    expect(ids(picked)).toEqual(["cloudflare-tcp", "azure-tcp", "github-tcp"]);
    expect(picked.every((t) => t.kind === "TCP" && t.category !== "INTERNET")).toBe(true);
  });

  it("deixa de fora os serviços que falharam no passo", () => {
    const picked = pickCanaries(candidates, { exclude: ["cloudflare", "azure"], count: 3, rotation: 0 });
    expect(ids(picked)).toEqual(["akamai-tcp", "github-tcp", "whatsapp-tcp"]);
    for (let rotation = 0; rotation < 40; rotation++) {
      const services = pickCanaries(candidates, { exclude: ["cloudflare", "azure"], count: 3, rotation }).map((t) => t.serviceId);
      expect(services).not.toContain("cloudflare");
      expect(services).not.toContain("azure");
    }
  });

  it("em qualquer rodada os 3 são de serviços e categorias diferentes", () => {
    for (let rotation = 0; rotation < 60; rotation++) {
      const picked = pickCanaries(candidates, { count: 3, rotation });
      expect(new Set(picked.map((t) => t.serviceId)).size).toBe(3);
      expect(new Set(picked.map((t) => t.category)).size).toBe(3);
    }
  });

  it("a rotação muda o ponto de partida: não são sempre os mesmos três, e todo serviço entra em algum momento", () => {
    expect(ids(pickCanaries(candidates, { count: 3, rotation: 1 }))).toEqual(["azure-tcp", "github-tcp", "whatsapp-tcp"]);
    expect(ids(pickCanaries(candidates, { count: 3, rotation: 4 }))).toEqual(["akamai-tcp", "azure-tcp", "github-tcp"]);
    const used = new Set<string>();
    for (let rotation = 0; rotation < 24; rotation++) for (const t of pickCanaries(candidates, { count: 3, rotation })) used.add(t.serviceId);
    expect(used.size).toBe(10);
  });

  it("com menos categorias que canários, completa com outros serviços", () => {
    const social = candidates.filter((t) => t.category === "SOCIAL" || t.category === "DEV");
    const picked = pickCanaries(social, { count: 3, rotation: 0 });
    expect(new Set(picked.map((t) => t.serviceId)).size).toBe(3);
    expect(picked.map((t) => categoryOf.get(t.serviceId))).toEqual(["DEV", "SOCIAL", "SOCIAL"]);
  });

  it("devolve o que houver: menos serviços que o pedido, ou nenhum", () => {
    const two = [service("github", "DEV").tcp, service("azure", "CLOUD").tcp];
    expect(ids(pickCanaries(two, { count: 3, rotation: 7 })).sort()).toEqual(["azure-tcp", "github-tcp"]);
    expect(pickCanaries(two, { exclude: ["github", "azure"], count: 3, rotation: 0 })).toEqual([]);
    expect(pickCanaries(world().internet, { count: 3, rotation: 0 })).toEqual([]);
    expect(pickCanaries([service("github", "DEV").http], { count: 3, rotation: 0 })).toEqual([]);
  });

  it("usa um alvo por serviço, mesmo que ele tenha dois TCP", () => {
    const s = service("github", "DEV");
    const second = target({ ...s.tcp, id: "github-tcp-80", key: "tcp80", port: 80 });
    expect(ids(pickCanaries([s.tcp, second], { count: 3, rotation: 0 }))).toEqual(["github-tcp"]);
  });
});

// ---------------------------------------------------------------- decideConnectivity

describe("decideConnectivity", () => {
  const failed = (serviceId: string, failedAt: ProbePhase | null = "connect"): ServiceEvidence => ({ serviceId, ok: false, failedAt });
  const answered = (serviceId: string): ServiceEvidence => ({ serviceId, ok: true, failedAt: null });
  const three = [failed("a"), failed("b"), failed("c")];
  const anchors = (...ok: boolean[]) => ok.map((value) => ({ ok: value }));
  const decide = (evidence: Partial<ConnectivityEvidence>) => decideConnectivity({ services: [], anchors: [], gateway: null, ...evidence });
  const OK = { state: "ok", reason: null };

  it("regra 1: algum serviço respondeu, a conexão está ok, mesmo com âncoras e gateway mudos", () => {
    expect(decide({ services: [failed("a"), failed("b"), failed("c"), answered("d")], anchors: anchors(false, false, false), gateway: { ok: false, ip: "192.168.0.1" } })).toEqual(OK);
  });

  it("regra 2: duas ou mais âncoras e nenhuma respondeu, sem Internet", () => {
    expect(decide({ services: [failed("a")], anchors: anchors(false, false) }).state).toBe("offline");
    expect(decide({ services: three, anchors: anchors(false, false, false, false) }).state).toBe("offline");
    // Vale também sem nenhum serviço como evidência (rodada pausada sem canários).
    expect(decide({ services: [], anchors: anchors(false, false) }).state).toBe("offline");
  });

  it("regra 2 não vale quando uma âncora responde: a saída para a Internet funciona", () => {
    expect(decide({ services: three, anchors: anchors(false, true, false) })).toEqual(OK);
    expect(decide({ services: [failed("a")], anchors: anchors(true, true) })).toEqual(OK);
  });

  it("regra 3: menos de duas âncoras mensuráveis e falhas em 3 ou mais serviços diferentes, sem Internet", () => {
    expect(decide({ services: three, anchors: [] }).state).toBe("offline");
    expect(decide({ services: three, anchors: anchors(false) }).state).toBe("offline");
    // Uma testemunha só não basta, nem respondendo.
    expect(decide({ services: three, anchors: anchors(true) }).state).toBe("offline");
  });

  it("regra 3 conta serviços diferentes, não alvos: dois alvos do mesmo serviço são um serviço", () => {
    expect(decide({ services: [failed("a"), failed("a"), failed("b")], anchors: [] })).toEqual(OK);
    expect(decide({ services: [failed("a"), failed("b")], anchors: anchors(false) })).toEqual(OK);
  });

  it("regra 4: falhas em 3 ou mais serviços, todas na resolução do nome, com âncoras respondendo: o DNS não resolve", () => {
    const dns = [failed("a", "dns"), failed("a", "dns"), failed("b", "dns"), failed("c", "dns")];
    expect(decide({ services: dns, anchors: anchors(true, true, false) })).toEqual({ state: "dns", reason: "O DNS deste servidor não está resolvendo nomes." });
    expect(DNS_REASON).toBe("O DNS deste servidor não está resolvendo nomes.");
  });

  it("regra 4 não vale com uma falha fora do DNS, nem com menos de 3 serviços", () => {
    expect(decide({ services: [failed("a", "dns"), failed("b", "dns"), failed("c", "connect")], anchors: anchors(true, true) })).toEqual(OK);
    expect(decide({ services: [failed("a", "dns"), failed("b", "dns"), failed("c", null)], anchors: anchors(true, true) })).toEqual(OK);
    expect(decide({ services: [failed("a", "dns"), failed("b", "dns")], anchors: anchors(true, true) })).toEqual(OK);
  });

  it("a ordem importa: âncoras mudas ganham da regra do DNS", () => {
    const dns = [failed("a", "dns"), failed("b", "dns"), failed("c", "dns")];
    expect(decide({ services: dns, anchors: anchors(false, false) }).state).toBe("offline");
    expect(decide({ services: dns, anchors: [] }).state).toBe("offline");
  });

  it("regra 5: nos demais casos a conexão está ok e as falhas são dos serviços", () => {
    // Queda de um provedor grande: vários serviços fora, âncoras respondendo.
    expect(decide({ services: [failed("a", "connect"), failed("b", "http"), failed("c", "tls"), failed("d", "connect")], anchors: anchors(true, true, true, true) })).toEqual(OK);
    // Um serviço fora, sem testemunhas.
    expect(decide({ services: [failed("a")], anchors: [] })).toEqual(OK);
    // Nada medido.
    expect(decide({})).toEqual(OK);
  });

  describe("frase de sem Internet", () => {
    const offline = { services: three, anchors: anchors(false, false) };

    it("gateway não responde: a frase traz o IP dele", () => {
      expect(decide({ ...offline, gateway: { ok: false, ip: "192.168.0.1" } })).toEqual({ state: "offline", reason: "O gateway 192.168.0.1 não responde." });
    });

    it("gateway não responde e o IP não foi descoberto", () => {
      expect(decide({ ...offline, gateway: { ok: false, ip: null } })).toEqual({ state: "offline", reason: "O gateway padrão não responde." });
    });

    it("gateway responde, mas as âncoras não", () => {
      expect(decide({ ...offline, gateway: { ok: true, ip: "192.168.0.1" } })).toEqual({ state: "offline", reason: "O gateway responde, mas não há saída para a Internet." });
    });

    it("sem evidência do gateway", () => {
      expect(decide({ ...offline, gateway: null })).toEqual({ state: "offline", reason: "Este servidor não alcança a Internet." });
      expect(decide({ services: three, anchors: [], gateway: null }).reason).toBe("Este servidor não alcança a Internet.");
    });
  });
});

// ---------------------------------------------------------------- evidência

describe("evidência de um passo", () => {
  const w = world();

  it("resultado de alvo de serviço vira evidência com a etapa da falha; alvo de Internet e sonda que não rodou ficam de fora", () => {
    const evidence = serviceEvidence([measured(w.github.tcp, down("dns")), measured(w.github.http, up(120)), measured(w.ping1, up(8)), measured(w.netflix.tcp, noPing), measured(w.whatsapp.tcp, { ok: false, latencyMs: null })]);
    expect(evidence).toEqual([
      { serviceId: "github", ok: false, failedAt: "dns" },
      { serviceId: "github", ok: true, failedAt: null },
      { serviceId: "whatsapp", ok: false, failedAt: null },
    ]);
  });

  it("só há suspeita sobre a conexão quando algum serviço foi medido e nenhum respondeu", () => {
    expect(needsEvidenceRound([])).toBe(false);
    expect(needsEvidenceRound([{ serviceId: "a", ok: true, failedAt: null }, { serviceId: "b", ok: false, failedAt: "connect" }])).toBe(false);
    expect(needsEvidenceRound([{ serviceId: "a", ok: false, failedAt: "connect" }])).toBe(true);
  });

  it("âncora e gateway só contam quando mensuráveis: a sonda rodou e o alvo já respondeu alguma vez, antes ou agora", () => {
    const neverPing = internetTarget("ping-1", "dns-cloudflare", "ICMP", "1.1.1.1", false);
    const neverDns = internetTarget("dns-9", "dns-quad9", "DNS", "9.9.9.9", false);
    const evidence = internetEvidence(
      [
        measured(neverPing, noReply), // nunca respondeu: o ICMP pode estar bloqueado, não é testemunha
        measured(w.dns1, down("dns")), // já respondeu e agora falhou: testemunha de que não há saída
        measured(w.ping8, noPing), // sem binário de ping: não é testemunha
        measured(w.dns8, up(15)), // respondeu
        measured(neverDns, up(22)), // primeira resposta da vida: passa a contar
        measured(w.systemDns, down("dns")), // DNS do sistema não é âncora (não tem IP literal)
        measured(w.github.tcp, down()), // alvo de serviço não é âncora
      ],
      "192.168.0.1",
    );
    expect(evidence.anchors).toEqual([{ ok: false }, { ok: true }, { ok: true }]);
    expect(evidence.gateway).toBeNull();
  });

  it("o gateway entra com o IP descoberto; sem rota ou sem nunca ter respondido, não há evidência dele", () => {
    expect(internetEvidence([measured(w.gateway, noReply)], "192.168.0.1").gateway).toEqual({ ok: false, ip: "192.168.0.1" });
    expect(internetEvidence([measured(w.gateway, up(1))], null).gateway).toEqual({ ok: true, ip: null });
    const noRoute: ProbeResult = { ok: false, latencyMs: null, unsupported: true, error: "gateway padrão não encontrado" };
    expect(internetEvidence([measured(w.gateway, noRoute)], null).gateway).toBeNull();
    const silent = internetTarget("gateway", "rede-local", "ICMP", AUTO_GATEWAY, false);
    expect(internetEvidence([measured(silent, noReply)], "192.168.0.1").gateway).toBeNull();
  });
});

describe("passo com a conexão ok", () => {
  it("sem alvo de serviço vencido não há o que suspeitar: grava tudo", () => {
    const w = world();
    const tick = runTick(w.all, [w.ping1, w.dns1], () => noReply);
    expect(tick.decision).toEqual({ state: "ok", reason: null });
    expect(tick.recorded).toEqual(["ping-1", "dns-1"]);
    expect(tick.asked).toEqual({ canaries: null, internet: null });
    expect(runTick(w.all, [], () => up()).recorded).toEqual([]);
  });

  it("um serviço respondeu: a conexão está ok e tudo é gravado, sem canários", () => {
    const w = world();
    const tick = runTick(w.all, [w.github.tcp, w.cloudflare.http, w.ping1], (t) => (t.serviceId === "github" ? down() : up()));
    expect(tick.decision.state).toBe("ok");
    expect(tick.recorded).toEqual(["github-tcp", "cloudflare-http", "ping-1"]);
    expect(tick.asked.canaries).toBeNull();
  });

  it("um serviço fora e os canários respondendo: fica ok, a falha é real e é gravada", () => {
    const w = world();
    // Só os dois alvos do GitHub venceram neste passo, e os dois falharam.
    const tick = runTick(w.all, [w.github.http, w.github.tcp], (t) => (t.serviceId === "github" ? down() : up()));
    expect(tick.decision).toEqual({ state: "ok", reason: null });
    // Canários: TCP de outros serviços, de categorias diferentes; o GitHub fica de fora.
    expect(tick.asked.canaries).toEqual(["cloudflare-tcp", "netflix-tcp", "whatsapp-tcp"]);
    // Com um canário respondendo não é preciso medir âncoras nem gateway.
    expect(tick.asked.internet).toBeNull();
    // Canário é só evidência: nunca é gravado.
    expect(tick.recorded).toEqual(["github-http", "github-tcp"]);
    expect(tick.record.every((m) => !m.result.ok)).toBe(true);
  });

  it("basta um canário responder", () => {
    const w = world();
    const tick = runTick(w.all, [w.github.tcp], (t) => (t.id === "whatsapp-tcp" ? up() : down()));
    expect(tick.decision.state).toBe("ok");
    expect(tick.asked.internet).toBeNull();
    expect(tick.recorded).toEqual(["github-tcp"]);
  });

  it("queda de um provedor grande (vários serviços fora, âncoras respondendo): fica ok e as falhas são gravadas", () => {
    const w = world();
    const due = [w.github.http, w.github.tcp, w.cloudflare.tcp, w.ping1];
    // Todos os serviços falham ao conectar, inclusive os canários; a Internet responde.
    const tick = runTick(w.all, due, (t) => (isInternetTarget(t) ? up(9) : down("connect")));
    expect(tick.asked.canaries).toEqual(["netflix-tcp", "whatsapp-tcp", "instagram-tcp"]);
    // Os alvos de Internet que o passo ainda não tinha medido são medidos agora (o ping-1 já estava no passo).
    expect(tick.asked.internet).toEqual(["gateway", "system-dns", "dns-1", "ping-8", "dns-8"]);
    expect(tick.decision).toEqual({ state: "ok", reason: null });
    expect(tick.recorded).toEqual(["github-http", "github-tcp", "cloudflare-tcp", "ping-1", "gateway", "system-dns", "dns-1", "ping-8", "dns-8"]);
    // As falhas viram medições de verdade.
    const outcome = recordTick(byId(w.all), tick.record, new Map());
    expect(outcome.rows.filter((r) => !r.ok).map((r) => r.targetId)).toEqual(["github-http", "github-tcp", "cloudflare-tcp"]);
    expect(outcome.rows).toHaveLength(9);
  });

  it("tudo fora e o gateway mudo: sem Internet, com o IP do gateway na frase, e os serviços não são culpados", () => {
    const w = world();
    const due = [w.github.tcp, w.cloudflare.http, w.dns8];
    const tick = runTick(w.all, due, (t) => (t.kind === "ICMP" ? noReply : down()), { gatewayIp: "192.168.0.1" });
    expect(tick.decision).toEqual({ state: "offline", reason: "O gateway 192.168.0.1 não responde." });
    expect(tick.asked.internet).toEqual(["gateway", "system-dns", "ping-1", "dns-1", "ping-8"]);
    // Os resultados dos serviços são descartados; os de Internet são gravados (os do passo e os da rodada).
    expect(tick.recorded).toEqual(["dns-8", "gateway", "system-dns", "ping-1", "dns-1", "ping-8"]);
    const outcome = recordTick(byId(w.all), tick.record, new Map());
    expect(outcome.rows.every((r) => !r.ok)).toBe(true);
    expect(outcome.targets.get("github-tcp")).toBe(w.github.tcp);
    expect(outcome.services.map((s) => s.serviceId)).toEqual(["dns-google", "rede-local", "dns-cloudflare"]);
  });

  it("o gateway responde e as âncoras não: sem saída para a Internet", () => {
    const w = world();
    const tick = runTick(w.all, [w.netflix.tcp], (t) => (t.id === "gateway" ? up(1) : t.kind === "ICMP" ? noReply : down()), { gatewayIp: "192.168.0.1" });
    expect(tick.decision).toEqual({ state: "offline", reason: "O gateway responde, mas não há saída para a Internet." });
    expect(tick.recorded).not.toContain("netflix-tcp");
  });

  it("nenhuma âncora mensurável (ping indisponível, DNS externo nunca respondeu): 3 serviços falhando juntos bastam", () => {
    const w = world();
    const blocked = w.all.map((t) => (isInternetTarget(t) ? { ...t, everOk: false } : t));
    const due = blocked.filter((t) => t.id === "github-tcp");
    const tick = runTick(blocked, due, (t) => (t.kind === "ICMP" ? noPing : down()), { gatewayIp: "192.168.0.1" });
    // 1 serviço do passo + 3 canários = 4 serviços diferentes, sem testemunhas.
    expect(tick.decision).toEqual({ state: "offline", reason: "Este servidor não alcança a Internet." });
  });

  it("nenhuma âncora mensurável e menos de 3 serviços como evidência: não dá para culpar a conexão", () => {
    const w = world();
    // Só dois serviços habilitados: o que falhou e um canário.
    const few = [...w.github.http ? [w.github.http, w.github.tcp, w.cloudflare.http, w.cloudflare.tcp] : [], ...w.internet.map((t) => ({ ...t, everOk: false }))];
    const tick = runTick(few, [w.github.tcp], (t) => (t.kind === "ICMP" ? noPing : down()));
    expect(tick.asked.canaries).toEqual(["cloudflare-tcp"]);
    expect(tick.decision).toEqual({ state: "ok", reason: null });
    expect(tick.recorded).toContain("github-tcp");
  });

  it("o DNS do servidor parou: serviços e canários falham na resolução do nome, as âncoras respondem por IP", () => {
    const w = world();
    const probe = (t: TargetState) => (isInternetTarget(t) ? (t.id === "system-dns" ? down("dns", "o servidor DNS não respondeu") : up(10)) : down("dns", "o DNS não respondeu"));
    const tick = runTick(w.all, [w.github.http, w.github.tcp], probe);
    expect(tick.decision).toEqual({ state: "dns", reason: "O DNS deste servidor não está resolvendo nomes." });
    expect(tick.recorded).toEqual(["gateway", "system-dns", "ping-1", "dns-1", "ping-8", "dns-8"]);
  });

  it("um ping de âncora que nunca respondeu não conta como testemunha da queda", () => {
    const w = world();
    // Rede que descarta ICMP: os pings nunca responderam; os DNS por IP respondem.
    const noIcmp = w.all.map((t) => (isInternetTarget(t) && t.kind === "ICMP" ? { ...t, everOk: false } : t));
    const tick = runTick(noIcmp, noIcmp.filter((t) => t.id === "github-tcp"), (t) => (t.kind === "DNS" ? up(12) : t.kind === "ICMP" ? noReply : down()));
    // As duas âncoras DNS respondem: as falhas são dos serviços.
    expect(tick.decision.state).toBe("ok");
  });

  it("num passo forçado em que tudo falha não sobram canários nem alvos de Internet a medir, e a decisão sai do próprio passo", () => {
    const w = world();
    const tick = runTick(w.all, w.all, (t) => (t.kind === "ICMP" ? noReply : down()), { gatewayIp: "10.0.0.1" });
    expect(tick.asked).toEqual({ canaries: [], internet: [] });
    expect(tick.decision).toEqual({ state: "offline", reason: "O gateway 10.0.0.1 não responde." });
    expect(tick.recorded).toEqual(ids(w.internet));
  });

  it("a rotação troca os canários de uma rodada para a outra", () => {
    const w = world();
    const first = runTick(w.all, [w.github.tcp], (t) => (t.serviceId === "github" ? down() : up()), { rotation: 0 });
    const second = runTick(w.all, [w.github.tcp], (t) => (t.serviceId === "github" ? down() : up()), { rotation: 1 });
    expect(second.asked.canaries).not.toEqual(first.asked.canaries);
  });
});

describe("rodada com a conexão fora", () => {
  const offline: LocalConnectivity = { state: "offline", since: new Date(T0).toISOString(), reason: "O gateway 192.168.0.1 não responde." };

  it("roda a cada 30 s e em todo passo forçado", () => {
    expect(pausedRoundDue(T0, T0 + 5 * SEC)).toBe(false);
    expect(pausedRoundDue(T0, T0 + 29 * SEC)).toBe(false);
    expect(pausedRoundDue(T0, T0 + 30 * SEC)).toBe(true);
    expect(pausedRoundDue(T0, T0 + 5 * SEC, true)).toBe(true);
  });

  it("mede todos os alvos de Internet e 3 canários; os alvos de serviço ficam parados", () => {
    const w = world();
    const round = pausedRoundTargets(w.all, 0);
    expect(ids(round.internet)).toEqual(ids(w.internet));
    expect(ids(round.canaries)).toEqual(["github-tcp", "cloudflare-tcp", "netflix-tcp"]);
    expect(ids(pausedRoundTargets(w.all, 1).canaries)).not.toEqual(ids(round.canaries));
  });

  it("continua fora enquanto canários e âncoras não respondem; grava os alvos de Internet e nunca os canários", () => {
    const w = world();
    const round = pausedRoundTargets(w.all, 0);
    const settled = settlePausedRound(round.internet.map((t) => measured(t, t.kind === "ICMP" ? noReply : down())), round.canaries.map((t) => measured(t, down())), "192.168.0.1");
    expect(settled.decision).toEqual({ state: "offline", reason: "O gateway 192.168.0.1 não responde." });
    expect(settled.record.map((m) => m.target.id)).toEqual(ids(w.internet));
  });

  it("recuperação: um canário responde e a conexão volta a ok", () => {
    const w = world();
    const round = pausedRoundTargets(w.all, 0);
    const settled = settlePausedRound(round.internet.map((t) => measured(t, up(8))), round.canaries.map((t, i) => measured(t, i === 2 ? up() : down())), "192.168.0.1");
    expect(settled.decision).toEqual({ state: "ok", reason: null });
    expect(settled.record.map((m) => m.target.id)).toEqual(ids(w.internet));
    expect(nextConnectivity(offline, settled.decision, T0 + 5 * MIN)).toEqual({ connectivity: { state: "ok", since: null, reason: null }, change: "restored" });
  });

  it("as âncoras voltam e os canários seguem falhando ao conectar: a conexão voltou e as falhas passam a ser dos serviços", () => {
    const w = world();
    const round = pausedRoundTargets(w.all, 0);
    const settled = settlePausedRound(round.internet.map((t) => measured(t, up(8))), round.canaries.map((t) => measured(t, down("connect"))), "192.168.0.1");
    expect(settled.decision.state).toBe("ok");
  });

  it("a rota volta mas o DNS não: passa de sem Internet para sem DNS", () => {
    const w = world();
    const round = pausedRoundTargets(w.all, 0);
    const settled = settlePausedRound(round.internet.map((t) => measured(t, t.id === "system-dns" ? down("dns") : up(8))), round.canaries.map((t) => measured(t, down("dns"))), "192.168.0.1");
    expect(settled.decision).toEqual({ state: "dns", reason: "O DNS deste servidor não está resolvendo nomes." });
    const next = nextConnectivity(offline, settled.decision, T0 + 2 * MIN);
    expect(next).toEqual({ connectivity: { state: "dns", since: offline.since, reason: "O DNS deste servidor não está resolvendo nomes." }, change: "moved" });
  });
});

describe("estado da conexão local", () => {
  const ok: LocalConnectivity = { state: "ok", since: null, reason: null };
  const since = new Date(T0).toISOString();

  it("ok e continua ok: nada muda", () => {
    expect(nextConnectivity(ok, { state: "ok", reason: null }, T0)).toEqual({ connectivity: ok, change: "none" });
  });

  it("ao cair guarda desde quando e a frase", () => {
    expect(nextConnectivity(ok, { state: "offline", reason: "Este servidor não alcança a Internet." }, T0)).toEqual({
      connectivity: { state: "offline", since, reason: "Este servidor não alcança a Internet." },
      change: "lost",
    });
    expect(nextConnectivity(ok, { state: "dns", reason: DNS_REASON }, T0).connectivity).toEqual({ state: "dns", since, reason: DNS_REASON });
  });

  it("enquanto continua fora mantém desde quando e atualiza a frase", () => {
    const current: LocalConnectivity = { state: "offline", since, reason: "O gateway 192.168.0.1 não responde." };
    expect(nextConnectivity(current, { state: "offline", reason: "O gateway responde, mas não há saída para a Internet." }, T0 + MIN)).toEqual({
      connectivity: { state: "offline", since, reason: "O gateway responde, mas não há saída para a Internet." },
      change: "none",
    });
  });

  it("trocar entre sem Internet e sem DNS é uma mudança, com o mesmo desde quando", () => {
    const current: LocalConnectivity = { state: "dns", since, reason: DNS_REASON };
    const next = nextConnectivity(current, { state: "offline", reason: "Este servidor não alcança a Internet." }, T0 + MIN);
    expect(next.change).toBe("moved");
    expect(next.connectivity.since).toBe(since);
  });

  it("ao voltar limpa desde quando e a frase", () => {
    expect(nextConnectivity({ state: "dns", since, reason: DNS_REASON }, { state: "ok", reason: null }, T0 + MIN)).toEqual({ connectivity: ok, change: "restored" });
  });
});

// ---------------------------------------------------------------- pausa

describe("pausa das medições", () => {
  it("a frase diz o motivo", () => {
    expect(pausedReason("offline")).toBe("Medições pausadas: sem Internet neste servidor.");
    expect(pausedReason("dns")).toBe("Medições pausadas: o DNS deste servidor não resolve nomes.");
  });

  it("em memória os alvos de serviço ficam Sem dados com a frase; os de Internet não mudam", () => {
    const w = world();
    const live = w.all.map((t) => ({ ...t, status: "OK" as const, ring: [check(true)], lastLatencyMs: 20 }));
    const paused = pauseServiceTargets(byId(live), pausedReason("offline"));
    // A última latência sai junto: durante a pausa ela não é mais "agora". As medições recentes ficam.
    expect(paused.get("github-tcp")).toMatchObject({ status: "UNKNOWN", reason: "Medições pausadas: sem Internet neste servidor.", ring: [check(true)], lastLatencyMs: null });
    expect(paused.get("ping-1")).toBe(live.find((t) => t.id === "ping-1"));
    expect(paused.get("ping-1")?.lastLatencyMs).toBe(20);
    expect(Array.from(paused.keys())).toEqual(ids(live));
  });

  it("a pausa guarda o veredito que cada alvo de serviço tinha: é dele que o julgamento parte quando o alvo voltar a ser medido", () => {
    const w = world();
    const live = byId([
      { ...w.github.http, status: "DOWN" as const, reason: "3 falhas seguidas" },
      { ...w.github.tcp, status: "OK" as const, lastLatencyMs: 20 },
      { ...w.cloudflare.http, status: "DEGRADED" as const, reason: "certificado vencido" },
      // Nunca medido: Sem dados, sem veredito a guardar.
      w.cloudflare.tcp,
      { ...w.ping1, status: "DOWN" as const, reason: "3 falhas seguidas" },
    ]);
    const paused = pauseServiceTargets(live, pausedReason("offline"));
    expect(paused.get("github-http")?.beforePause).toEqual({ status: "DOWN", reason: "3 falhas seguidas" });
    expect(paused.get("github-tcp")?.beforePause).toEqual({ status: "OK", reason: null });
    expect(paused.get("cloudflare-http")?.beforePause).toEqual({ status: "DEGRADED", reason: "certificado vencido" });
    expect(paused.get("cloudflare-tcp")?.beforePause).toBeNull();
    // O alvo de Internet não é pausado e não guarda nada.
    expect(paused.get("ping-1")?.beforePause).toBeNull();

    // De "sem Internet" para "sem DNS" a pausa é marcada de novo: fica a frase nova e o veredito de antes da primeira.
    const moved = pauseServiceTargets(paused, pausedReason("dns"));
    expect(moved.get("github-http")).toMatchObject({ status: "UNKNOWN", reason: "Medições pausadas: o DNS deste servidor não resolve nomes.", beforePause: { status: "DOWN", reason: "3 falhas seguidas" } });
    expect(moved.get("github-tcp")?.beforePause).toEqual({ status: "OK", reason: null });
    expect(moved.get("cloudflare-tcp")?.beforePause).toBeNull();
  });

  it("no banco o alvo de serviço recebe o mesmo: Sem dados, a frase e nenhuma latência", () => {
    expect(pausedTargetData("offline")).toEqual({ status: "UNKNOWN", statusReason: "Medições pausadas: sem Internet neste servidor.", lastLatencyMs: null });
    expect(pausedTargetData("dns")).toEqual({ status: "UNKNOWN", statusReason: "Medições pausadas: o DNS deste servidor não resolve nomes.", lastLatencyMs: null });
  });

  it("o serviço passa a mostrar só o status oficial", () => {
    const now = new Date(T0);
    // Medido estava fora e o oficial ok: o card volta para o oficial, e isso é uma mudança.
    expect(pausedServiceData({ officialState: "OK", status: "DOWN" }, "offline", now)).toEqual({
      measuredStatus: "UNKNOWN",
      measuredReason: "Medições pausadas: sem Internet neste servidor.",
      latencyMs: null,
      status: "OK",
      lastChangeAt: now,
    });
    // O oficial já era o pior: o status do card não muda.
    expect(pausedServiceData({ officialState: "DEGRADED", status: "DEGRADED" }, "dns", now)).toEqual({
      measuredStatus: "UNKNOWN",
      measuredReason: "Medições pausadas: o DNS deste servidor não resolve nomes.",
      latencyMs: null,
      status: "DEGRADED",
    });
    // Sem fonte oficial (ou fonte sem dados) não sobra nada a mostrar.
    expect(pausedServiceData({ officialState: null, status: "OK" }, "offline", now)).toMatchObject({ status: "UNKNOWN", lastChangeAt: now });
    expect(pausedServiceData({ officialState: "UNKNOWN", status: "UNKNOWN" }, "offline", now)).not.toHaveProperty("lastChangeAt");
  });

  it("a marcação de pausa é gravada ao cair ou trocar de tipo, e repetida enquanto o banco não a aceitar", () => {
    const offline = { state: "offline" as const };
    const dns = { state: "dns" as const };
    // Acabou de ser decidida.
    expect(pauseToWrite(null, offline, "lost")).toBe("offline");
    expect(pauseToWrite(null, dns, "moved")).toBe("dns");
    // Já gravada: nas rodadas seguintes não há o que repetir.
    expect(pauseToWrite(null, offline, "none")).toBeNull();
    // A gravação falhou: a rodada seguinte tenta de novo, e vale o tipo mais recente.
    expect(pauseToWrite("offline", offline, "none")).toBe("offline");
    expect(pauseToWrite("offline", dns, "moved")).toBe("dns");
    // A conexão voltou: nada mais a gravar, mesmo com uma pendente.
    expect(pauseToWrite("offline", { state: "ok" }, "restored")).toBeNull();
    expect(pauseToWrite(null, { state: "ok" }, "none")).toBeNull();
  });

  it("um serviço está com as medições paradas enquanto o medido for Sem dados com a frase da pausa", () => {
    expect(measurementPaused({ measuredStatus: "UNKNOWN", measuredReason: pausedReason("offline") })).toBe(true);
    expect(measurementPaused({ measuredStatus: "UNKNOWN", measuredReason: pausedReason("dns") })).toBe(true);
    // Sem dados por outro motivo, ou já julgado de novo, não é pausa.
    expect(measurementPaused({ measuredStatus: "UNKNOWN", measuredReason: "Ping: ping indisponível neste servidor" })).toBe(false);
    expect(measurementPaused({ measuredStatus: "UNKNOWN", measuredReason: null })).toBe(false);
    expect(measurementPaused({ measuredStatus: "DOWN", measuredReason: "TCP 443: 3 falhas seguidas" })).toBe(false);
    expect(measurementPaused({ measuredStatus: "OK", measuredReason: null })).toBe(false);
    expect(measurementPaused({ measuredStatus: null, measuredReason: null })).toBe(false);
  });

  it("ao voltar, os alvos de serviço ganham vencimentos novos e espalhados; os de Internet seguem na agenda deles", () => {
    const w = world();
    const resumeAt = T0 + 7 * MIN;
    // Durante a pausa todos os alvos de serviço ficaram vencidos.
    const stale = byId(w.all.map((t) => (isInternetTarget(t) ? { ...t, dueAt: resumeAt + 11 * SEC } : { ...t, dueAt: T0 })));
    const resumed = respreadServices(stale, resumeAt);
    const services = Array.from(resumed.values()).filter((t) => !isInternetTarget(t));
    expect(services.every((t) => t.dueAt >= resumeAt && t.dueAt < resumeAt + 60 * SEC)).toBe(true);
    // 5 TCP espalhados em 30 s e 5 HTTP em 60 s: no primeiro passo vencem só 2, não os 10.
    expect(selectDue(services, resumeAt)).toHaveLength(2);
    expect(Math.max(...loadPerTick(services.map((t) => t.dueAt), resumeAt))).toBeLessThanOrEqual(2);
    expect(Array.from(resumed.values()).filter(isInternetTarget).every((t) => t.dueAt === resumeAt + 11 * SEC)).toBe(true);
  });
});

// ---------------------------------------------------------------- gravação e veredito

describe("recordResult", () => {
  const at = new Date(T0);

  it("uma medição que deu certo vira linha, entra na frente das recentes e o alvo fica ok", () => {
    const state = target({ id: "http", kind: "HTTP", key: "http", ring: [check(true, 90)] });
    const result = up(120.4, { httpStatus: 200, dnsMs: 12.1, connectMs: 20.2, tlsMs: 40.3, ttfbMs: 47.8, totalMs: 120.4, certDays: 60, failedAt: null });
    const recorded = recordResult(state, result, at);
    expect(recorded.row).toEqual({
      targetId: "http", vantage: "server", at, ok: true, latencyMs: 120.4, httpStatus: 200, dnsMs: 12.1, connectMs: 20.2, tlsMs: 40.3, ttfbMs: 47.8, totalMs: 120.4,
      lossPct: null, jitterMs: null, certDays: 60, error: null,
    });
    expect(recorded.row).not.toHaveProperty("failedAt");
    expect(recorded.state.ring).toEqual([{ ok: true, latencyMs: 120.4, lossPct: null, certDays: 60 }, check(true, 90)]);
    expect(recorded.state).toMatchObject({ status: "OK", reason: null, lastLatencyMs: 120.4, everOk: true });
    expect(recorded.update).toEqual({ status: "OK", statusReason: null, lastCheckAt: at, lastLatencyMs: 120.4, lastError: null });
    // O estado recebido não é alterado.
    expect(state.ring).toEqual([check(true, 90)]);
  });

  it("uma falha vira linha sem latência, com as parcelas de tempo que a sonda devolveu e o erro cortado em 200 caracteres", () => {
    const state = target({ id: "http", kind: "HTTP", key: "http", ring: [check(true), check(true)], lastLatencyMs: 20 });
    const result: ProbeResult = { ok: false, latencyMs: 0, httpStatus: 503, dnsMs: 10, connectMs: 20, tlsMs: 30, ttfbMs: 40, totalMs: 100, error: "x".repeat(300), failedAt: "http" };
    const recorded = recordResult(state, result, at);
    expect(recorded.row).toMatchObject({ ok: false, latencyMs: null, httpStatus: 503, dnsMs: 10, connectMs: 20, tlsMs: 30, ttfbMs: 40, totalMs: 100, error: "x".repeat(200) });
    expect(recorded.update).toMatchObject({ lastLatencyMs: null, lastError: "x".repeat(200) });
    // Uma falha isolada não muda o estado.
    expect(recorded.state).toMatchObject({ status: "OK", reason: null, lastLatencyMs: null });
  });

  it("as falhas seguidas levam a degradado e a fora do ar; o histórico guarda só as 5 mais novas", () => {
    let state = target({ id: "tcp", ring: [check(true), check(true), check(true), check(true), check(true)], status: "OK" });
    const reasons: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const recorded = recordResult(state, down(), new Date(T0 + i * 30 * SEC));
      state = recorded.state;
      reasons.push(`${recorded.update.status}: ${recorded.update.statusReason}`);
    }
    expect(reasons).toEqual(["OK: null", "DEGRADED: 2 falhas seguidas", "DOWN: 3 falhas seguidas", "DOWN: 4 falhas seguidas", "DOWN: sem resposta nas últimas 5 medições"]);
    expect(state.ring).toHaveLength(5);
    // Voltou: uma resposta basta para sair de fora do ar.
    expect(recordResult(state, up(), at).state).toMatchObject({ status: "OK", reason: null });
  });

  describe("só falhas nas medições recentes", () => {
    // Alvo novo, ou servidor que ficou parado mais que a idade das medições recentes: o histórico começa vazio.
    const failing = (over: Partial<TargetState>) => target({ id: "tcp", ring: [], ...over });
    const feed = (state: TargetState, results: ProbeResult[]) => {
      const seen: string[] = [];
      for (const result of results) {
        const recorded = recordResult(state, result, at);
        state = recorded.state;
        seen.push(`${recorded.update.status}: ${recorded.update.statusReason}`);
      }
      return seen;
    };

    it("um alvo que estava fora do ar continua fora enquanto só falhar, sem passar por ok nem por degradado", () => {
      const before = failing({ status: "DOWN", reason: "sem resposta nas últimas 5 medições" });
      expect(feed(before, [down(), down(), down(), down()])).toEqual([
        "DOWN: sem resposta nas últimas 5 medições",
        "DOWN: sem resposta nas últimas 5 medições",
        "DOWN: 3 falhas seguidas",
        "DOWN: 4 falhas seguidas",
      ]);
      // A medição é gravada do mesmo jeito: só o veredito espera.
      const first = recordResult(before, down(), at);
      expect(first.row).toMatchObject({ ok: false, error: "tempo esgotado ao conectar" });
      expect(first.state.ring).toEqual([check(false)]);
      expect(first.update.lastError).toBe("tempo esgotado ao conectar");
    });

    it("a primeira resposta tira o alvo de fora do ar na hora", () => {
      expect(feed(failing({ status: "DOWN", reason: "3 falhas seguidas" }), [down(), up()])).toEqual(["DOWN: 3 falhas seguidas", "OK: null"]);
    });

    it("um alvo novo que falha na primeira medição continua Sem dados; a segunda falha já avisa", () => {
      expect(feed(failing({ status: "UNKNOWN" }), [down(), down(), down()])).toEqual(["UNKNOWN: null", "DEGRADED: 2 falhas seguidas", "DOWN: 3 falhas seguidas"]);
      expect(feed(failing({ status: "UNKNOWN" }), [up()])).toEqual(["OK: null"]);
    });

    it("o motivo antigo de um alvo Sem dados não fica: podia ser o de uma pausa que acabou", () => {
      const paused = failing({ status: "UNKNOWN", reason: pausedReason("offline") });
      expect(recordResult(paused, down(), at).update).toMatchObject({ status: "UNKNOWN", statusReason: null });
    });

    it("um alvo que estava ok continua ok com uma falha só, como em qualquer falha isolada", () => {
      expect(feed(failing({ status: "OK" }), [down(), down()])).toEqual(["OK: null", "DEGRADED: 2 falhas seguidas"]);
    });

    it("um alvo degradado continua degradado, com o motivo que tinha, até haver o que julgar", () => {
      expect(feed(failing({ status: "DEGRADED", reason: "latência 3,0× acima do normal (90 ms)" }), [down(), down(), up()])).toEqual([
        "DEGRADED: latência 3,0× acima do normal (90 ms)",
        "DEGRADED: 2 falhas seguidas",
        "OK: null",
      ]);
    });

    describe("voltando de uma pausa sem medições recentes (o servidor reiniciou durante a queda da conexão local)", () => {
      const paused = (beforePause: TargetState["beforePause"]) => failing({ status: "UNKNOWN", reason: pausedReason("offline"), beforePause });

      it("o alvo que estava fora do ar antes da pausa continua fora enquanto só falhar", () => {
        expect(feed(paused({ status: "DOWN", reason: "sem resposta nas últimas 5 medições" }), [down(), down(), down()])).toEqual([
          "DOWN: sem resposta nas últimas 5 medições",
          "DOWN: sem resposta nas últimas 5 medições",
          "DOWN: 3 falhas seguidas",
        ]);
      });

      it("a primeira resposta vale na hora, qualquer que fosse o veredito guardado", () => {
        expect(feed(paused({ status: "DOWN", reason: "3 falhas seguidas" }), [up()])).toEqual(["OK: null"]);
        expect(feed(paused({ status: "DOWN", reason: "3 falhas seguidas" }), [down(), up()])).toEqual(["DOWN: 3 falhas seguidas", "OK: null"]);
      });

      it("o que estava degradado segue degradado, com o motivo que tinha, até haver o que julgar", () => {
        expect(feed(paused({ status: "DEGRADED", reason: "certificado vencido" }), [down(), down(), down()])).toEqual([
          "DEGRADED: certificado vencido",
          "DEGRADED: 2 falhas seguidas",
          "DOWN: 3 falhas seguidas",
        ]);
      });

      it("o que estava ok continua ok com uma falha só", () => {
        expect(feed(paused({ status: "OK", reason: null }), [down(), down()])).toEqual(["OK: null", "DEGRADED: 2 falhas seguidas"]);
      });

      it("o veredito guardado vale só para o primeiro resultado depois da pausa", () => {
        const before = paused({ status: "DOWN", reason: "3 falhas seguidas" });
        expect(recordResult(before, down(), at).state.beforePause).toBeNull();
        expect(recordResult(before, up(), at).state.beforePause).toBeNull();
        // A sonda que não pôde rodar também encerra a pausa do alvo: ele fica Sem dados pelo motivo dela.
        const unsupported = recordResult(before, { ok: false, latencyMs: null, unsupported: true, error: "falha interna da sonda" }, at);
        expect(unsupported.state).toMatchObject({ status: "UNKNOWN", reason: "falha interna da sonda", beforePause: null });
        expect(feed(unsupported.state, [down()])).toEqual(["UNKNOWN: null"]);
      });
    });

    it("com alguma resposta entre as recentes o veredito é o de sempre, qualquer que fosse o estado", () => {
      const before = target({ id: "tcp", ring: [check(true), check(true)], status: "DOWN", reason: "3 falhas seguidas" });
      expect(feed(before, [down()])).toEqual(["OK: null"]);
      // Voltando de uma pausa com o histórico de antes: as falhas antigas contam com a nova.
      const afterPause = target({ id: "tcp", ring: [check(false), check(false), check(true)], status: "UNKNOWN", reason: pausedReason("offline") });
      expect(feed(afterPause, [down()])).toEqual(["DOWN: 3 falhas seguidas"]);
    });
  });

  it("o ping grava perda e jitter, e a perda entra no veredito", () => {
    const state = internetTarget("ping-1", "dns-cloudflare", "ICMP", "1.1.1.1");
    const recorded = recordResult(state, up(14.2, { lossPct: 40, jitterMs: 1.5 }), at);
    expect(recorded.row).toMatchObject({ ok: true, latencyMs: 14.2, lossPct: 40, jitterMs: 1.5 });
    expect(recorded.state).toMatchObject({ status: "DEGRADED", reason: "perda de 40% dos pacotes" });
  });

  it("só o certificado já vencido muda o estado: perto de vencer é normal (o provedor renova na última hora)", () => {
    const state = target({ id: "http", kind: "HTTP", key: "http" });
    expect(recordResult(state, up(100, { certDays: 7 }), at).state).toMatchObject({ status: "OK", reason: null });
    expect(recordResult(state, up(100, { certDays: 0 }), at).state).toMatchObject({ status: "OK", reason: null });
    expect(recordResult(state, up(100, { certDays: -1 }), at).state).toMatchObject({ status: "DEGRADED", reason: "certificado vencido" });
    // Os dias restantes continuam gravados, para o detalhe do alvo.
    expect(recordResult(state, up(100, { certDays: 7 }), at).row?.certDays).toBe(7);
  });

  it("a linha de base do alvo decide a latência acima do normal", () => {
    const baseline = Array.from({ length: 12 }, () => 20);
    let state = target({ id: "tcp" });
    for (let i = 0; i < 3; i++) state = recordResult(state, up(100), at, baseline).state;
    expect(state).toMatchObject({ status: "DEGRADED", reason: "latência 5,0× acima do normal (100 ms)" });
    // Sem linha de base (menos de 1 h de janelas) a latência não é julgada.
    let fresh = target({ id: "tcp" });
    for (let i = 0; i < 3; i++) fresh = recordResult(fresh, up(100), at, baseline.slice(0, 11)).state;
    expect(fresh.status).toBe("OK");
  });

  it("valores que não são números finitos viram ausência, e dias de certificado e código HTTP são inteiros", () => {
    const recorded = recordResult(target({ id: "http", kind: "HTTP" }), up(Number.NaN, { dnsMs: Number.POSITIVE_INFINITY, certDays: 29.7, httpStatus: 204.0 }), at);
    expect(recorded.row).toMatchObject({ latencyMs: null, dnsMs: null, certDays: 29, httpStatus: 204 });
  });

  describe("resultados que não viram medição", () => {
    it("sonda que não pôde rodar: sem linha, alvo Sem dados com o motivo da sonda, histórico intacto", () => {
      const state = internetTarget("ping-1", "dns-cloudflare", "ICMP", "1.1.1.1");
      const before = { ...state, ring: [check(true, 9)], status: "OK" as const, lastLatencyMs: 9 };
      const recorded = recordResult(before, noPing, at);
      expect(recorded.row).toBeNull();
      expect(recorded.state).toMatchObject({ status: "UNKNOWN", reason: "ping indisponível neste servidor", ring: [check(true, 9)], lastLatencyMs: null, everOk: true });
      expect(recorded.update).toEqual({ status: "UNKNOWN", statusReason: "ping indisponível neste servidor", lastCheckAt: at, lastLatencyMs: null, lastError: "ping indisponível neste servidor" });
    });

    it("vale para qualquer alvo, inclusive de serviço, e a sonda sem frase ganha uma", () => {
      const recorded = recordResult(target({ id: "tcp" }), { ok: false, latencyMs: null, unsupported: true }, at);
      expect(recorded.row).toBeNull();
      expect(recorded.update).toMatchObject({ status: "UNKNOWN", statusReason: "A sonda não pôde rodar neste servidor.", lastError: null });
    });

    it("ping de Internet que nunca respondeu e falhou de novo: sem linha, Sem dados, com a frase do ICMP bloqueado", () => {
      const never = internetTarget("ping-1", "dns-cloudflare", "ICMP", "1.1.1.1", false);
      const recorded = recordResult(never, noReply, at);
      expect(recorded.row).toBeNull();
      expect(recorded.state).toMatchObject({ status: "UNKNOWN", reason: "Sem resposta a ping até agora (o ICMP pode estar bloqueado nesta rede).", ring: [], everOk: false });
      expect(recorded.update).toEqual({
        status: "UNKNOWN",
        statusReason: "Sem resposta a ping até agora (o ICMP pode estar bloqueado nesta rede).",
        lastCheckAt: at,
        lastLatencyMs: null,
        lastError: "sem resposta ao ping",
      });
    });

    it("DNS de Internet que nunca respondeu: a frase do DNS externo bloqueado", () => {
      const never = internetTarget("dns-1", "dns-cloudflare", "DNS", "1.1.1.1", false);
      const recorded = recordResult(never, down("dns", "o servidor DNS não respondeu"), at);
      expect(recorded.row).toBeNull();
      expect(recorded.update.statusReason).toBe("Sem resposta a consultas DNS até agora (o DNS externo pode estar bloqueado nesta rede).");
      expect(neverAnsweredReason("ICMP")).toBe("Sem resposta a ping até agora (o ICMP pode estar bloqueado nesta rede).");
      expect(neverAnsweredReason("DNS")).toBe("Sem resposta a consultas DNS até agora (o DNS externo pode estar bloqueado nesta rede).");
      expect(neverAnsweredReason("TCP")).toMatch(/^Sem resposta até agora/);
    });

    it("a partir da primeira resposta o alvo de Internet conta normalmente: a falha seguinte é uma medição", () => {
      const never = internetTarget("ping-1", "dns-cloudflare", "ICMP", "1.1.1.1", false);
      const first = recordResult(never, up(11, { lossPct: 0 }), at);
      expect(first.row).toMatchObject({ ok: true, latencyMs: 11 });
      expect(first.state).toMatchObject({ status: "OK", everOk: true });
      const then = recordResult(first.state, { ...noReply, lossPct: null }, at);
      expect(then.row).toMatchObject({ ok: false, error: "sem resposta ao ping" });
      expect(then.state.ring).toHaveLength(2);
    });

    it("a regra do nunca respondeu é só dos alvos de Internet: a primeira falha de um serviço é uma medição", () => {
      const recorded = recordResult(target({ id: "tcp", everOk: false }), down(), at);
      expect(recorded.row).toMatchObject({ ok: false, error: "tempo esgotado ao conectar" });
      expect(recorded.state.ring).toHaveLength(1);
    });
  });
});

describe("summarizeService", () => {
  const t = (kind: ProbeKind, status: TargetState["status"], reason: string | null = null, lastLatencyMs: number | null = null, port: number | null = kind === "TCP" ? 443 : null) => ({ kind, port, status, reason, lastLatencyMs });

  it("o estado medido é o pior entre os alvos com estado conhecido", () => {
    expect(summarizeService([t("HTTP", "OK"), t("TCP", "OK")]).measuredStatus).toBe("OK");
    expect(summarizeService([t("HTTP", "DEGRADED", "2 falhas seguidas"), t("TCP", "OK")]).measuredStatus).toBe("DEGRADED");
    expect(summarizeService([t("HTTP", "DEGRADED", "2 falhas seguidas"), t("TCP", "DOWN", "3 falhas seguidas")]).measuredStatus).toBe("DOWN");
    // Um alvo Sem dados (ping indisponível, alvo novo que falhou uma vez) não esconde o que os outros sabem.
    expect(summarizeService([t("ICMP", "UNKNOWN", "ping indisponível neste servidor"), t("DNS", "OK", null, 12)]).measuredStatus).toBe("OK");
    expect(summarizeService([t("HTTP", "UNKNOWN"), t("TCP", "DOWN", "3 falhas seguidas")]).measuredStatus).toBe("DOWN");
  });

  it("voltando de uma pausa, o serviço segue pausado até todos os alvos serem medidos de novo", () => {
    const paused = pausedReason("offline");
    // O TCP já voltou (ok, ou fora), o HTTP ainda não: julgar agora seria julgar pela metade.
    for (const tcp of [t("TCP", "OK", null, 20), t("TCP", "DOWN", "3 falhas seguidas")]) {
      expect(summarizeService([t("HTTP", "UNKNOWN", paused), tcp])).toEqual({ measuredStatus: "UNKNOWN", measuredReason: paused, latencyMs: null });
      expect(summarizeService([tcp, t("HTTP", "UNKNOWN", paused)])).toEqual({ measuredStatus: "UNKNOWN", measuredReason: paused, latencyMs: null });
    }
    expect(measurementPaused(summarizeService([t("HTTP", "UNKNOWN", paused), t("TCP", "OK", null, 20)]))).toBe(true);
    // Todos medidos: o resumo de sempre.
    expect(summarizeService([t("HTTP", "DOWN", "3 falhas seguidas"), t("TCP", "OK", null, 20)])).toEqual({ measuredStatus: "DOWN", measuredReason: "HTTP: 3 falhas seguidas", latencyMs: 20 });
    // Um alvo que voltou sem veredito (falhou uma vez, sem histórico) já não está pausado: perdeu a frase.
    expect(summarizeService([t("HTTP", "UNKNOWN"), t("TCP", "OK", null, 20)])).toEqual({ measuredStatus: "OK", measuredReason: null, latencyMs: 20 });
    // A frase da pausa de DNS vale igual.
    expect(summarizeService([t("HTTP", "UNKNOWN", pausedReason("dns")), t("TCP", "OK", null, 20)]).measuredReason).toBe(pausedReason("dns"));
  });

  it("o motivo é o do primeiro alvo no pior estado, com o rótulo do alvo na frente", () => {
    expect(summarizeService([t("HTTP", "DEGRADED", "2 falhas seguidas"), t("TCP", "DOWN", "3 falhas seguidas")]).measuredReason).toBe("TCP 443: 3 falhas seguidas");
    expect(summarizeService([t("HTTP", "DOWN", "sem resposta nas últimas 5 medições"), t("TCP", "DOWN", "3 falhas seguidas")]).measuredReason).toBe("HTTP: sem resposta nas últimas 5 medições");
    expect(summarizeService([t("ICMP", "DEGRADED", "perda de 20% dos pacotes"), t("DNS", "OK")]).measuredReason).toBe("Ping: perda de 20% dos pacotes");
    expect(summarizeService([t("TLS", "DEGRADED", "certificado vencido")]).measuredReason).toBe("Certificado TLS: certificado vencido");
  });

  it("com tudo normal não há motivo", () => {
    expect(summarizeService([t("HTTP", "OK"), t("TCP", "OK", null, 20)])).toEqual({ measuredStatus: "OK", measuredReason: null, latencyMs: 20 });
    // Nem o motivo de um alvo Sem dados aparece quando os outros estão normais.
    expect(summarizeService([t("ICMP", "UNKNOWN", "ping indisponível neste servidor"), t("DNS", "OK")]).measuredReason).toBeNull();
  });

  it("a latência vem do primeiro alvo que tiver uma, na ordem TCP, ping, TLS, DNS, e nunca do HTTP", () => {
    expect(summarizeService([t("HTTP", "OK", null, 300), t("TCP", "OK", null, 20)]).latencyMs).toBe(20);
    expect(summarizeService([t("DNS", "OK", null, 30), t("TLS", "OK", null, 40), t("ICMP", "OK", null, 10), t("HTTP", "OK", null, 300)]).latencyMs).toBe(10);
    expect(summarizeService([t("DNS", "OK", null, 30), t("TLS", "OK", null, 40)]).latencyMs).toBe(40);
    // O TCP falhou (sem latência): não vale a do HTTP no lugar.
    expect(summarizeService([t("HTTP", "OK", null, 300), t("TCP", "DOWN", "3 falhas seguidas")]).latencyMs).toBeNull();
    // Ping indisponível: a rede local mostra a latência do DNS.
    expect(summarizeService([t("ICMP", "UNKNOWN", "ping indisponível neste servidor"), t("DNS", "OK", null, 12)]).latencyMs).toBe(12);
    // Dois alvos do mesmo tipo: vale o primeiro na ordem do catálogo.
    expect(summarizeService([t("TCP", "OK", null, 25, 443), t("TCP", "OK", null, 5, 80)]).latencyMs).toBe(25);
  });

  it("com todos os alvos Sem dados o serviço fica Sem dados, com o primeiro motivo que houver", () => {
    expect(summarizeService([t("ICMP", "UNKNOWN", "Sem resposta a ping até agora (o ICMP pode estar bloqueado nesta rede)."), t("DNS", "UNKNOWN", "Sem resposta a consultas DNS até agora (o DNS externo pode estar bloqueado nesta rede).")])).toEqual({
      measuredStatus: "UNKNOWN",
      measuredReason: "Ping: Sem resposta a ping até agora (o ICMP pode estar bloqueado nesta rede).",
      latencyMs: null,
    });
    expect(summarizeService([t("HTTP", "UNKNOWN"), t("TCP", "UNKNOWN", "A sonda não pôde rodar neste servidor.")]).measuredReason).toBe("TCP 443: A sonda não pôde rodar neste servidor.");
    expect(summarizeService([t("HTTP", "UNKNOWN"), t("TCP", "UNKNOWN")])).toEqual({ measuredStatus: "UNKNOWN", measuredReason: null, latencyMs: null });
    expect(summarizeService([])).toEqual({ measuredStatus: "UNKNOWN", measuredReason: null, latencyMs: null });
  });
});

describe("linha do serviço", () => {
  const now = new Date(T0 + 4 * SEC);
  const at = new Date(T0);
  const summary = { measuredStatus: "DOWN" as const, measuredReason: "TCP 443: 3 falhas seguidas", latencyMs: null };

  it("o status do card é o pior entre o oficial e o medido, e a mudança marca a hora", () => {
    expect(serviceData(summary, { officialState: "OK", status: "OK" }, { sourceType: "STATUSPAGE", at, now })).toEqual({ ...summary, status: "DOWN", lastChangeAt: now });
    // Sem mudança de status não mexe em lastChangeAt.
    expect(serviceData(summary, { officialState: "OK", status: "DOWN" }, { sourceType: "STATUSPAGE", at, now })).toEqual({ ...summary, status: "DOWN" });
    // O oficial pior que o medido continua valendo.
    const fine = { measuredStatus: "OK" as const, measuredReason: null, latencyMs: 20 };
    expect(serviceData(fine, { officialState: "DEGRADED", status: "DEGRADED" }, { sourceType: "STATUSPAGE", at, now }).status).toBe("DEGRADED");
    // Fonte oficial sem dados não esconde o que foi medido.
    expect(serviceData(fine, { officialState: "UNKNOWN", status: "UNKNOWN" }, { sourceType: "GCP", at, now })).toMatchObject({ status: "OK", lastChangeAt: now });
    // Manutenção declarada pelo provedor aparece enquanto o medido está normal.
    expect(serviceData(fine, { officialState: "MAINTENANCE", status: "MAINTENANCE" }, { sourceType: "STATUSPAGE", at, now }).status).toBe("MAINTENANCE");
  });

  it("lastCheckAt só é escrito para serviços sem fonte oficial; nos outros a coluna é do coletor", () => {
    expect(serviceData(summary, { officialState: null, status: "UNKNOWN" }, { sourceType: "NONE", at, now })).toEqual({ ...summary, status: "DOWN", lastChangeAt: now, lastCheckAt: at });
    expect(serviceData(summary, { officialState: "OK", status: "DOWN" }, { sourceType: "STATUSPAGE", at, now })).not.toHaveProperty("lastCheckAt");
  });

  it("medido Sem dados e sem fonte oficial: o card fica Sem dados", () => {
    const unknown = { measuredStatus: "UNKNOWN" as const, measuredReason: null, latencyMs: null };
    expect(serviceData(unknown, { officialState: null, status: "UNKNOWN" }, { sourceType: "NONE", at, now })).toEqual({ ...unknown, status: "UNKNOWN", lastCheckAt: at });
  });
});

describe("recordTick", () => {
  it("monta as linhas, as atualizações dos alvos e um resumo por serviço com resultado, olhando todos os alvos do serviço", () => {
    const w = world();
    const failing = { ...w.github.tcp, ring: [check(false), check(false), check(true)], status: "DEGRADED" as const, reason: "2 falhas seguidas" };
    const http = { ...w.github.http, ring: [check(true, 150)], status: "OK" as const, lastLatencyMs: 150 };
    const states = byId(w.all.map((t) => (t.id === failing.id ? failing : t.id === http.id ? http : t)));
    const record = [measured(failing, down(), T0), measured(w.netflix.tcp, up(31), T0 + 2 * SEC), measured(w.netflix.http, up(180, { httpStatus: 200 }), T0 + SEC)];
    const outcome = recordTick(states, record, new Map());

    expect(outcome.rows.map((r) => [r.targetId, r.ok])).toEqual([["github-tcp", false], ["netflix-tcp", true], ["netflix-http", true]]);
    expect(outcome.targetUpdates.map((u) => [u.id, u.data.status])).toEqual([["github-tcp", "DOWN"], ["netflix-tcp", "OK"], ["netflix-http", "OK"]]);
    expect(outcome.services).toEqual([
      // O HTTP do GitHub não foi medido agora, mas o estado dele em memória entra no resumo.
      { serviceId: "github", sourceType: "STATUSPAGE", at: new Date(T0), summary: { measuredStatus: "DOWN", measuredReason: "TCP 443: 3 falhas seguidas", latencyMs: null } },
      // `at` é a medição mais nova do serviço no passo; a latência é a do TCP, não a do HTTP.
      { serviceId: "netflix", sourceType: "NONE", at: new Date(T0 + 2 * SEC), summary: { measuredStatus: "OK", measuredReason: null, latencyMs: 31 } },
    ]);
    // O estado novo fica em memória e o antigo não é alterado.
    expect(outcome.targets.get("github-tcp")).toMatchObject({ status: "DOWN", reason: "3 falhas seguidas" });
    expect(states.get("github-tcp")!.status).toBe("DEGRADED");
    expect(Array.from(outcome.targets.keys())).toEqual(ids(w.all));
  });

  it("usa a linha de base de cada alvo", () => {
    const w = world();
    const slow = { ...w.github.tcp, ring: [check(true, 100), check(true, 100)] };
    const outcome = recordTick(byId([slow]), [measured(slow, up(100))], new Map([["github-tcp", Array.from({ length: 12 }, () => 20)]]));
    expect(outcome.services[0].summary).toEqual({ measuredStatus: "DEGRADED", measuredReason: "TCP 443: latência 5,0× acima do normal (100 ms)", latencyMs: 100 });
  });

  it("resultado que não vira medição atualiza o alvo e o resumo, sem linha", () => {
    const w = world();
    const blocked = w.all.map((t) => (isInternetTarget(t) ? { ...t, everOk: false } : t));
    const pick = (id: string) => blocked.find((t) => t.id === id)!;
    const outcome = recordTick(byId(blocked), [measured(pick("gateway"), noPing), measured(pick("system-dns"), up(4)), measured(pick("ping-1"), noReply), measured(pick("dns-1"), down("dns"))], new Map());
    expect(outcome.rows.map((r) => r.targetId)).toEqual(["system-dns"]);
    expect(outcome.targetUpdates).toHaveLength(4);
    expect(outcome.services.map((s) => [s.serviceId, s.summary.measuredStatus, s.summary.measuredReason, s.summary.latencyMs])).toEqual([
      ["rede-local", "OK", null, 4],
      ["dns-cloudflare", "UNKNOWN", "Ping: Sem resposta a ping até agora (o ICMP pode estar bloqueado nesta rede).", null],
    ]);
  });

  it("depois de uma pausa, um serviço com o HTTP fora e o TCP ok não aparece como ok no meio do caminho", () => {
    const w = world();
    // Antes da queda local: o HTTP do GitHub fora do ar (503), o TCP respondendo.
    const live = w.all.map((t) => (t.id === "github-http" ? { ...t, ring: [check(false), check(false), check(false), check(true), check(true)], status: "DOWN" as const, reason: "3 falhas seguidas" } : { ...t, ring: [check(true)], status: "OK" as const, lastLatencyMs: 20 }));
    const paused = pauseServiceTargets(byId(live), pausedReason("offline"));
    // A conexão volta e o TCP é o primeiro a ser medido.
    const first = recordTick(paused, [measured(paused.get("github-tcp")!, up(18))], new Map());
    expect(first.targetUpdates).toEqual([{ id: "github-tcp", data: { status: "OK", statusReason: null, lastCheckAt: new Date(T0), lastLatencyMs: 18, lastError: null } }]);
    expect(first.services).toEqual([{ serviceId: "github", sourceType: "STATUSPAGE", at: new Date(T0), summary: { measuredStatus: "UNKNOWN", measuredReason: pausedReason("offline"), latencyMs: null } }]);
    // Meio minuto depois o HTTP falha de novo: com as falhas de antes da pausa, segue fora do ar.
    const second = recordTick(first.targets, [measured(first.targets.get("github-http")!, down("http", "HTTP 503"), T0 + 30 * SEC)], new Map());
    expect(second.services[0].summary).toEqual({ measuredStatus: "DOWN", measuredReason: "HTTP: 4 falhas seguidas", latencyMs: 18 });
  });

  it("sem nada a gravar não produz nada, e ignora medição de alvo que não está mais na lista", () => {
    const w = world();
    const states = byId(w.all);
    expect(recordTick(states, [], new Map())).toEqual({ targets: states, rows: [], targetUpdates: [], services: [] });
    expect(recordTick(states, [measured(target({ id: "sumiu" }), up())], new Map()).rows).toEqual([]);
  });
});

// ---------------------------------------------------------------- manutenção

describe("janelas de 5 min", () => {
  it("uma janela só fecha 60 s depois do fim dela", () => {
    // Relógio 12:10:59: a janela das 12:05 termina 12:10 e ainda pode receber medições atrasadas.
    expect(closedWindows(T0, T0 + 10 * MIN + 59 * SEC)).toEqual([T0]);
    // Relógio 12:11:00: fechou.
    expect(closedWindows(T0, T0 + 11 * MIN)).toEqual([T0, T0 + 5 * MIN]);
    expect(closedWindows(T0, T0 + 15 * MIN + 59 * SEC)).toEqual([T0, T0 + 5 * MIN]);
    expect(closedWindows(T0, T0 + 16 * MIN)).toEqual([T0, T0 + 5 * MIN, T0 + 10 * MIN]);
  });

  it("a janela em andamento e a que acabou de terminar ficam para depois", () => {
    expect(closedWindows(T0, T0)).toEqual([]);
    expect(closedWindows(T0, T0 + 5 * MIN + 59 * SEC)).toEqual([]);
    expect(closedWindows(T0, T0 + 6 * MIN)).toEqual([T0]);
  });

  it("o início é alinhado ao começo da janela", () => {
    expect(closedWindows(T0 + 2 * MIN + 7 * SEC, T0 + 11 * MIN)).toEqual([T0, T0 + 5 * MIN]);
  });

  it("no máximo 24 janelas por passada, das mais antigas para as mais novas", () => {
    expect(MAX_ROLLUP_WINDOWS).toBe(24);
    const windows = closedWindows(T0, T0 + 10 * HOUR);
    expect(windows).toHaveLength(24);
    expect(windows[0]).toBe(T0);
    expect(windows[23]).toBe(T0 + 23 * BUCKET_MS);
    // A passada seguinte continua de onde parou.
    const next = closedWindows(rollupStart({ lastRolled: windows[23], newestRollup: null, oldestCheck: null }, T0 + 10 * HOUR)!, T0 + 10 * HOUR);
    expect(next[0]).toBe(T0 + 24 * BUCKET_MS);
    expect(closedWindows(T0, T0 + 10 * HOUR, 3)).toHaveLength(3);
  });

  it("começa na janela seguinte à última resumida em memória", () => {
    expect(rollupStart({ lastRolled: T0, newestRollup: T0 - HOUR, oldestCheck: T0 - 2 * HOUR }, T0 + HOUR)).toBe(T0 + 5 * MIN);
  });

  it("sem memória (servidor acabou de subir), começa na janela seguinte à mais nova gravada no banco", () => {
    expect(rollupStart({ lastRolled: null, newestRollup: T0 - HOUR, oldestCheck: T0 - 2 * HOUR }, T0)).toBe(T0 - HOUR + 5 * MIN);
  });

  it("sem nenhuma janela gravada, começa na janela da medição mais antiga", () => {
    expect(rollupStart({ lastRolled: null, newestRollup: null, oldestCheck: T0 - 17 * MIN - 3 * SEC }, T0)).toBe(T0 - 20 * MIN);
  });

  it("nunca volta mais que 48 h", () => {
    const floor = bucketStart(T0 - CHECK_RETENTION_MS);
    expect(rollupStart({ lastRolled: null, newestRollup: T0 - 5 * 24 * HOUR, oldestCheck: null }, T0)).toBe(floor);
    expect(rollupStart({ lastRolled: null, newestRollup: null, oldestCheck: T0 - 72 * HOUR }, T0)).toBe(floor);
    expect(rollupStart({ lastRolled: T0 - 72 * HOUR, newestRollup: null, oldestCheck: null }, T0)).toBe(floor);
    expect(floor).toBe(T0 - 48 * HOUR);
  });

  it("nunca começa depois da janela em andamento: se o relógio voltou, o ponto de partida volta com ele", () => {
    const now = T0 + 2 * MIN;
    expect(rollupStart({ lastRolled: T0 + HOUR, newestRollup: null, oldestCheck: null }, now)).toBe(T0);
    expect(rollupStart({ lastRolled: null, newestRollup: T0 + HOUR, oldestCheck: null }, now)).toBe(T0);
  });

  it("uma passada diz as janelas a resumir e a última resumida a guardar", () => {
    // Em dia: nada fechou desde a última passada, e o que se guarda é a própria última resumida.
    expect(planRollup({ lastRolled: T0 - 5 * MIN, newestRollup: null, oldestCheck: null }, T0 + 3 * MIN)).toEqual({ windows: [], lastRolled: T0 - 5 * MIN });
    // A janela das 12:00 fecha às 12:06.
    expect(planRollup({ lastRolled: T0 - 5 * MIN, newestRollup: null, oldestCheck: null }, T0 + 6 * MIN)).toEqual({ windows: [T0], lastRolled: T0 });
    // Servidor acabou de subir: o ponto de partida do banco fica guardado, sem consultar de novo a cada minuto.
    expect(planRollup({ lastRolled: null, newestRollup: T0 - 10 * MIN, oldestCheck: null }, T0 + 2 * MIN)).toEqual({ windows: [T0 - 5 * MIN], lastRolled: T0 - 5 * MIN });
    expect(planRollup({ lastRolled: null, newestRollup: null, oldestCheck: T0 + 90 * SEC }, T0 + 2 * MIN)).toEqual({ windows: [], lastRolled: T0 - 5 * MIN });
    expect(planRollup({ lastRolled: null, newestRollup: null, oldestCheck: null }, T0)).toBeNull();
  });

  it("depois de o relógio voltar, as janelas revividas são resumidas de novo assim que fecham", () => {
    // A última resumida ficou uma hora no futuro; agora são 12:02.
    let lastRolled = T0 + HOUR;
    const rolled: number[] = [];
    for (let now = T0 + 2 * MIN; now <= T0 + 17 * MIN; now += MIN) {
      const plan = planRollup({ lastRolled, newestRollup: null, oldestCheck: null }, now)!;
      rolled.push(...plan.windows);
      lastRolled = plan.lastRolled;
    }
    // Sem guardar o ponto de partida nada seria resumido até o relógio alcançar a hora antiga.
    expect(rolled).toEqual([T0, T0 + 5 * MIN, T0 + 10 * MIN]);
  });

  it("sem medições não há o que resumir", () => {
    expect(rollupStart({ lastRolled: null, newestRollup: null, oldestCheck: null }, T0)).toBeNull();
  });

  it("resume cada janela por alvo: uma linha por alvo com amostras, só das janelas pedidas", () => {
    const sample = (targetId: string, offsetMs: number, ok: boolean, latencyMs: number | null, lossPct: number | null = null) => ({ targetId, at: new Date(T0 + offsetMs), ok, latencyMs, lossPct });
    const rows = buildRollups(
      [
        sample("a", 0, true, 10),
        sample("a", 2 * MIN, true, 30),
        sample("a", 4 * MIN + 59 * SEC, false, null),
        sample("b", 3 * MIN, true, 50, 20),
        sample("a", 5 * MIN, true, 70), // janela seguinte
        sample("a", 10 * MIN, true, 999), // janela ainda aberta: não foi pedida
        sample("a", -SEC, true, 999), // janela anterior: não foi pedida
      ],
      [T0, T0 + 5 * MIN],
    );
    expect(rows).toEqual([
      { targetId: "a", vantage: "server", bucket: new Date(T0), samples: 3, failures: 1, p50Ms: 20, p95Ms: 29, maxMs: 30, lossPct: null },
      { targetId: "b", vantage: "server", bucket: new Date(T0), samples: 1, failures: 0, p50Ms: 50, p95Ms: 50, maxMs: 50, lossPct: 20 },
      { targetId: "a", vantage: "server", bucket: new Date(T0 + 5 * MIN), samples: 1, failures: 0, p50Ms: 70, p95Ms: 70, maxMs: 70, lossPct: null },
    ]);
    expect(buildRollups([], [T0])).toEqual([]);
  });

  it("janela só com falhas tem amostras e nenhuma latência", () => {
    const rows = buildRollups([{ targetId: "a", at: new Date(T0 + SEC), ok: false, latencyMs: null, lossPct: 100 }], [T0]);
    expect(rows).toEqual([{ targetId: "a", vantage: "server", bucket: new Date(T0), samples: 1, failures: 1, p50Ms: null, p95Ms: null, maxMs: null, lossPct: 100 }]);
  });
});

describe("manutenção do fim do passo", () => {
  it("resume as janelas no máximo uma vez por minuto e limpa o histórico uma vez por hora", () => {
    expect(maintenanceDue({ rollupAt: 0, cleanupAt: 0 }, T0)).toEqual({ rollup: true, cleanup: true });
    expect(maintenanceDue({ rollupAt: T0, cleanupAt: T0 }, T0 + 59 * SEC)).toEqual({ rollup: false, cleanup: false });
    expect(maintenanceDue({ rollupAt: T0, cleanupAt: T0 }, T0 + 60 * SEC)).toEqual({ rollup: true, cleanup: false });
    expect(maintenanceDue({ rollupAt: T0 + 59 * MIN, cleanupAt: T0 }, T0 + HOUR)).toEqual({ rollup: true, cleanup: true });
  });

  it("medições cruas ficam 48 h e janelas de 5 min ficam 30 dias", () => {
    expect(cleanupCutoffs(T0)).toEqual({ checksBefore: new Date("2026-11-12T12:00:00.000Z"), rollupsBefore: new Date("2026-10-15T12:00:00.000Z") });
    expect(ROLLUP_RETENTION_MS).toBe(30 * 24 * HOUR);
  });

  it("a linha de base de um alvo são as medianas das suas janelas, sem as janelas só de falhas", () => {
    const baselines = groupBaseline([{ targetId: "a", p50Ms: 20 }, { targetId: "b", p50Ms: 9 }, { targetId: "a", p50Ms: null }, { targetId: "a", p50Ms: 22 }, { targetId: "c", p50Ms: null }]);
    expect(Array.from(baselines)).toEqual([["a", [20, 22]], ["b", [9]]]);
  });
});

// ---------------------------------------------------------------- medições desligadas e catálogo

describe("medições desligadas", () => {
  const now = new Date(T0);

  it("o serviço perde o que as medições deixaram e volta a valer só pelo status oficial", () => {
    // O medido estava fora do ar e o oficial ok: sem as medições, o card não pode ficar vermelho para sempre.
    expect(clearedServiceData({ officialState: "OK", status: "DOWN" }, now)).toEqual({ measuredStatus: null, measuredReason: null, latencyMs: null, status: "OK", lastChangeAt: now });
    // O status já era o oficial: nada muda além de limpar.
    expect(clearedServiceData({ officialState: "DEGRADED", status: "DEGRADED" }, now)).toEqual({ measuredStatus: null, measuredReason: null, latencyMs: null, status: "DEGRADED" });
    expect(clearedServiceData({ officialState: "MAINTENANCE", status: "DOWN" }, now)).toMatchObject({ status: "MAINTENANCE", lastChangeAt: now });
    // Sem fonte oficial (ou fonte sem dados) não sobra nada a mostrar.
    expect(clearedServiceData({ officialState: null, status: "DOWN" }, now)).toMatchObject({ status: "UNKNOWN", lastChangeAt: now });
    expect(clearedServiceData({ officialState: "UNKNOWN", status: "UNKNOWN" }, now)).not.toHaveProperty("lastChangeAt");
  });

  it("o alvo fica sem estado nenhum", () => {
    expect(CLEARED_TARGET_DATA).toEqual({ status: "UNKNOWN", statusReason: null, lastLatencyMs: null, lastError: null });
  });

  describe("o que a página recebe das medições de um serviço", () => {
    const row = { officialState: "OK", measuredStatus: "DOWN", measuredReason: "HTTP: 3 falhas seguidas", latencyMs: 41.5, status: "DOWN" };

    it("com as medições ligadas: o que está gravado, e a pausa reconhecida pela frase", () => {
      expect(servedMeasure(row, true)).toEqual({ status: "DOWN", measuredStatus: "DOWN", measuredReason: "HTTP: 3 falhas seguidas", measurementPaused: false, latencyMs: 41.5 });
      expect(servedMeasure({ officialState: "OK", measuredStatus: "UNKNOWN", measuredReason: pausedReason("offline"), latencyMs: null, status: "OK" }, true)).toEqual({
        status: "OK",
        measuredStatus: "UNKNOWN",
        measuredReason: pausedReason("offline"),
        measurementPaused: true,
        latencyMs: null,
      });
      // Antes da primeira medição.
      expect(servedMeasure({ officialState: null, measuredStatus: null, measuredReason: null, latencyMs: null, status: "UNKNOWN" }, true)).toEqual({ status: "UNKNOWN", measuredStatus: null, measuredReason: null, measurementPaused: false, latencyMs: null });
    });

    it("com as medições desligadas: nada do que elas gravaram, e o status é só o oficial, mesmo antes de a limpeza rodar", () => {
      expect(servedMeasure(row, false)).toEqual({ status: "OK", measuredStatus: null, measuredReason: null, measurementPaused: false, latencyMs: null });
      // Uma pausa que ficou gravada também não vai.
      expect(servedMeasure({ officialState: "DEGRADED", measuredStatus: "UNKNOWN", measuredReason: pausedReason("dns"), latencyMs: null, status: "DEGRADED" }, false)).toEqual({
        status: "DEGRADED",
        measuredStatus: null,
        measuredReason: null,
        measurementPaused: false,
        latencyMs: null,
      });
      expect(servedMeasure({ ...row, officialState: null }, false).status).toBe("UNKNOWN");
      expect(servedMeasure({ ...row, officialState: "MAINTENANCE" }, false).status).toBe("MAINTENANCE");
    });

    it("um valor gravado que não é um status conhecido não chega à página", () => {
      expect(servedMeasure({ ...row, status: "lixo", measuredStatus: "lixo" }, true)).toMatchObject({ status: "UNKNOWN", measuredStatus: null });
    });
  });
});

describe("mudanças do catálogo", () => {
  const endpoint = { kind: "TCP", host: "github.com", url: null, port: 443 };

  it("trocar tipo, host, URL ou porta de um alvo é trocar de endereço", () => {
    expect(endpointChanged(endpoint, { ...endpoint })).toBe(false);
    expect(endpointChanged(endpoint, { ...endpoint, host: "api.github.com" })).toBe(true);
    expect(endpointChanged(endpoint, { ...endpoint, port: 8443 })).toBe(true);
    expect(endpointChanged(endpoint, { ...endpoint, kind: "TLS" })).toBe(true);
    expect(endpointChanged({ ...endpoint, kind: "HTTP", url: "https://github.com/" }, { ...endpoint, kind: "HTTP", url: "https://github.com/status" })).toBe(true);
  });

  it("o que não muda o que é medido não conta: o intervalo e um campo vazio escrito de outro jeito", () => {
    expect(endpointChanged({ ...endpoint, intervalSec: 30 } as typeof endpoint, { ...endpoint, intervalSec: 60 } as typeof endpoint)).toBe(false);
    expect(endpointChanged({ kind: "ICMP", host: "1.1.1.1", url: null, port: null }, { kind: "ICMP", host: "1.1.1.1", url: undefined as never, port: undefined as never })).toBe(false);
  });

  it("um serviço que deixou de ter fonte oficial perde o que ela declarou e passa a valer pelo medido", () => {
    const now = new Date(T0);
    // A fonte antiga dizia degradado e as medições dizem ok: o card volta a ok.
    expect(unsourcedServiceData({ measuredStatus: "OK", status: "DEGRADED" }, now)).toEqual({ officialState: null, officialStatus: null, sourceVersion: null, lastError: null, status: "OK", lastChangeAt: now });
    expect(unsourcedServiceData({ measuredStatus: "DOWN", status: "DOWN" }, now)).toEqual({ officialState: null, officialStatus: null, sourceVersion: null, lastError: null, status: "DOWN" });
    // Sem medição ainda: Sem dados.
    expect(unsourcedServiceData({ measuredStatus: null, status: "OK" }, now)).toMatchObject({ status: "UNKNOWN", lastChangeAt: now });
  });
});
