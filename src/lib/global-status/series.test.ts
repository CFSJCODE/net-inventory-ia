import { describe, expect, it } from "vitest";
import { LATENCY_KIND_ORDER, buildSeries, latencySummary, mainLatencyTarget, tailPoints, uptimeOf, type RollupPoint, type TailCheck } from "./series";

// Consulta às 10:07 UTC com passos de 15 min: a grade termina às 10:15 e começa 24 h antes.
const END = new Date("2026-11-14T10:07:00Z");
const DAY = { end: END, hours: 24, stepMin: 15 };
const START = Date.parse("2026-11-13T10:15:00Z");

/** Uma janela de 5 min que começa `minutes` depois do início da grade. */
const point = (minutes: number, over: Partial<RollupPoint> = {}): RollupPoint => ({
  bucket: new Date(START + minutes * 60_000),
  samples: 5,
  failures: 0,
  p50Ms: 20,
  p95Ms: 30,
  ...over,
});

const nulls = (n: number) => Array.from({ length: n }, () => null);
const zeros = (n: number) => Array.from({ length: n }, () => 0);

describe("buildSeries: a grade", () => {
  it("sem janelas devolve 96 passos vazios, terminando no próximo múltiplo do passo", () => {
    expect(buildSeries([], DAY)).toEqual({ start: "2026-11-13T10:15:00.000Z", stepMin: 15, p50: nulls(96), p95: nulls(96), fail: zeros(96) });
  });

  it("duas consultas dentro do mesmo passo devolvem a mesma grade (o gráfico não desliza)", () => {
    for (const end of ["2026-11-14T10:00:00.001Z", "2026-11-14T10:07:00Z", "2026-11-14T10:14:59.999Z", "2026-11-14T10:15:00.000Z"]) {
      expect(buildSeries([], { ...DAY, end: new Date(end) }).start, end).toBe("2026-11-13T10:15:00.000Z");
    }
    expect(buildSeries([], { ...DAY, end: new Date("2026-11-14T10:15:00.001Z") }).start).toBe("2026-11-13T10:30:00.000Z");
  });

  it("o número de passos segue as horas e a duração do passo", () => {
    // 1 h em passos de 5 min: 12 passos; a grade termina às 10:10.
    const hour = buildSeries([], { end: END, hours: 1, stepMin: 5 });
    expect(hour.start).toBe("2026-11-14T09:10:00.000Z");
    expect(hour.stepMin).toBe(5);
    expect(hour.p50).toHaveLength(12);
    expect(hour.p95).toHaveLength(12);
    expect(hour.fail).toHaveLength(12);
    // Período vazio: nenhuma janela cabe, e o início coincide com o fim da grade.
    expect(buildSeries([point(0)], { ...DAY, hours: 0 })).toEqual({ start: "2026-11-14T10:15:00.000Z", stepMin: 15, p50: [], p95: [], fail: [] });
  });
});

describe("buildSeries: as janelas em cada passo", () => {
  it("cada janela cai no passo que a contém", () => {
    // Três janelas de 5 min formam o passo 0; a quarta abre o passo 1; a última da grade é o passo 95.
    const series = buildSeries([point(0, { failures: 1 }), point(5, { failures: 2 }), point(10, { failures: 4 }), point(15, { failures: 8 }), point(1435, { failures: 16 })], DAY);
    expect(series.fail[0]).toBe(7);
    expect(series.fail[1]).toBe(8);
    expect(series.fail[95]).toBe(16);
    expect(series.fail.reduce((a, b) => a + b, 0)).toBe(31);
  });

  it("janela fora da grade é ignorada, antes ou depois", () => {
    const outside = [point(-5, { failures: 1 }), point(1440, { failures: 1 }), point(-100_000, { failures: 1 }), { ...point(0, { failures: 1 }), bucket: new Date(NaN) }];
    expect(buildSeries(outside, DAY)).toEqual(buildSeries([], DAY));
  });

  it("junta as janelas do passo: mediana das medianas, o maior p95 e a soma das falhas", () => {
    const series = buildSeries(
      [
        point(30, { p50Ms: 10, p95Ms: 40, failures: 1 }),
        point(35, { p50Ms: 30, p95Ms: 90, failures: 0 }),
        point(40, { p50Ms: 20, p95Ms: 50, failures: 2 }),
        // Número par de janelas: a mediana é a média das duas do meio.
        point(45, { p50Ms: 10, p95Ms: 15 }),
        point(50, { p50Ms: 13, p95Ms: 14 }),
      ],
      DAY,
    );
    expect([series.p50[2], series.p95[2], series.fail[2]]).toEqual([20, 90, 3]);
    expect([series.p50[3], series.p95[3], series.fail[3]]).toEqual([11.5, 15, 0]);
    // A ordem em que as janelas chegam não muda o resultado.
    const shuffled = buildSeries([point(40, { p50Ms: 20, p95Ms: 50, failures: 2 }), point(30, { p50Ms: 10, p95Ms: 40, failures: 1 }), point(35, { p50Ms: 30, p95Ms: 90, failures: 0 })], DAY);
    expect([shuffled.p50[2], shuffled.p95[2], shuffled.fail[2]]).toEqual([20, 90, 3]);
  });

  it("passo só com falhas fica sem latência e com as falhas; passo sem janela fica vazio", () => {
    const series = buildSeries(
      [
        point(60, { samples: 3, failures: 3, p50Ms: null, p95Ms: null }),
        // Uma janela sem latência ao lado de uma com: vale a que tem.
        point(75, { samples: 2, failures: 2, p50Ms: null, p95Ms: null }),
        point(80, { p50Ms: 50, p95Ms: 70 }),
      ],
      DAY,
    );
    expect([series.p50[4], series.p95[4], series.fail[4]]).toEqual([null, null, 3]);
    expect([series.p50[5], series.p95[5], series.fail[5]]).toEqual([50, 70, 2]);
    expect([series.p50[6], series.p95[6], series.fail[6]]).toEqual([null, null, 0]);
  });

  it("arredonda as latências para uma casa decimal", () => {
    const series = buildSeries([point(90, { p50Ms: 12.34, p95Ms: 56.78 })], DAY);
    expect([series.p50[6], series.p95[6]]).toEqual([12.3, 56.8]);
  });

  it("as três listas têm sempre o mesmo tamanho", () => {
    const series = buildSeries([point(0), point(700, { p50Ms: null, p95Ms: null, failures: 5 })], DAY);
    expect(series.p95).toHaveLength(series.p50.length);
    expect(series.fail).toHaveLength(series.p50.length);
  });
});

describe("uptimeOf", () => {
  it("é 1 − falhas ÷ amostras sobre todas as janelas, não a média das janelas", () => {
    // 2 falhas em 8 medições: 75%. A média das duas janelas (50% e 100%) também daria 75; a terceira desfaz o empate.
    expect(uptimeOf([{ samples: 4, failures: 1 }, { samples: 4, failures: 1 }])).toBe(75);
    // 1 falha em 1 e 0 em 3: 3 de 4 medições certas (75%), e não a média 50%.
    expect(uptimeOf([{ samples: 1, failures: 1 }, { samples: 3, failures: 0 }])).toBe(75);
    expect(uptimeOf([{ samples: 5, failures: 0 }])).toBe(100);
    expect(uptimeOf([{ samples: 3, failures: 3 }])).toBe(0);
  });

  it("sem amostras não há disponibilidade", () => {
    expect(uptimeOf([])).toBeNull();
    expect(uptimeOf([{ samples: 0, failures: 0 }])).toBeNull();
  });

  it("nunca sai de 0 a 100, mesmo com uma contagem incoerente", () => {
    expect(uptimeOf([{ samples: 1, failures: 2 }])).toBe(0);
  });
});

describe("latencySummary", () => {
  it("sem janelas, ou só com janelas sem latência, não há resumo", () => {
    expect(latencySummary([])).toEqual({ p50Ms: null, p95Ms: null });
    expect(latencySummary([{ p50Ms: null, p95Ms: null }])).toEqual({ p50Ms: null, p95Ms: null });
  });

  it("mediana das medianas e percentil 95 dos p95, pulando as janelas sem latência", () => {
    // p95 de [30, 50, 100]: posição 0,95 × 2 = 1,9, entre 50 e 100: 50 + 50 × 0,9 = 95.
    const windows = [{ p50Ms: 40, p95Ms: 100 }, { p50Ms: null, p95Ms: null }, { p50Ms: 10, p95Ms: 30 }, { p50Ms: 20, p95Ms: 50 }];
    expect(latencySummary(windows)).toEqual({ p50Ms: 20, p95Ms: 95 });
  });

  it("arredonda para uma casa decimal", () => {
    expect(latencySummary([{ p50Ms: 12.34, p95Ms: 56.78 }])).toEqual({ p50Ms: 12.3, p95Ms: 56.8 });
  });
});

describe("tailPoints", () => {
  const check = (targetId: string, at: string, latencyMs: number | null, ok = latencyMs !== null): TailCheck => ({ targetId, at: new Date(at), ok, latencyMs, lossPct: null });

  it("sem medições não há pontos", () => {
    expect(tailPoints([]).size).toBe(0);
  });

  it("agrupa por alvo e por janela de 5 min, no formato das janelas gravadas", () => {
    const points = tailPoints([
      // Chegam fora de ordem: a janela mais nova primeiro.
      check("a", "2026-11-14T10:05:00.000Z", 50),
      check("a", "2026-11-14T10:00:10Z", 10),
      check("b", "2026-11-14T10:01:00Z", 7),
      check("a", "2026-11-14T10:02:00Z", 30),
      check("a", "2026-11-14T10:04:59.999Z", null),
    ]);
    expect(Array.from(points.keys())).toEqual(["a", "b"]);

    const a = points.get("a")!;
    expect(a.map((p) => p.bucket.toISOString())).toEqual(["2026-11-14T10:00:00.000Z", "2026-11-14T10:05:00.000Z"]);
    // Janela das 10:00: 3 medições, 1 falha; as latências contam só as que deram certo (10 e 30).
    expect(a[0]).toMatchObject({ samples: 3, failures: 1, p50Ms: 20 });
    expect(a[0].p95Ms).toBeCloseTo(29, 9);
    expect(a[1]).toEqual({ bucket: new Date("2026-11-14T10:05:00.000Z"), samples: 1, failures: 0, p50Ms: 50, p95Ms: 50 });

    expect(points.get("b")).toEqual([{ bucket: new Date("2026-11-14T10:00:00.000Z"), samples: 1, failures: 0, p50Ms: 7, p95Ms: 7 }]);
  });

  it("janela só com falhas tem amostras e nenhuma latência", () => {
    const points = tailPoints([check("a", "2026-11-14T10:00:00Z", null), check("a", "2026-11-14T10:01:00Z", null)]);
    expect(points.get("a")).toEqual([{ bucket: new Date("2026-11-14T10:00:00.000Z"), samples: 2, failures: 2, p50Ms: null, p95Ms: null }]);
  });

  it("os pontos entram em buildSeries como as janelas gravadas", () => {
    const tail = tailPoints([check("a", "2026-11-14T10:01:00Z", 12), check("a", "2026-11-14T10:06:00Z", null)]).get("a")!;
    const series = buildSeries(tail, DAY);
    // 10:00 e 10:05 ficam no último passo da grade (10:00 a 10:15).
    expect([series.p50[95], series.p95[95], series.fail[95]]).toEqual([12, 12, 1]);
  });
});

describe("mainLatencyTarget", () => {
  const kinds = (...list: string[]) => list.map((kind, n) => ({ kind, n }));

  it("escolhe pelo tipo: TCP, ping, TLS, DNS e só então HTTP", () => {
    expect(LATENCY_KIND_ORDER).toEqual(["TCP", "ICMP", "TLS", "DNS", "HTTP"]);
    expect(mainLatencyTarget(kinds("HTTP", "TCP"))).toEqual({ kind: "TCP", n: 1 });
    expect(mainLatencyTarget(kinds("DNS", "ICMP"))).toEqual({ kind: "ICMP", n: 1 });
    expect(mainLatencyTarget(kinds("HTTP", "DNS", "TLS"))).toEqual({ kind: "TLS", n: 2 });
    expect(mainLatencyTarget(kinds("HTTP", "DNS"))).toEqual({ kind: "DNS", n: 1 });
    expect(mainLatencyTarget(kinds("HTTP"))).toEqual({ kind: "HTTP", n: 0 });
  });

  it("entre dois do mesmo tipo vale o primeiro da lista", () => {
    expect(mainLatencyTarget(kinds("HTTP", "TCP", "TCP"))).toEqual({ kind: "TCP", n: 1 });
  });

  it("tipo desconhecido: o primeiro alvo; sem alvos: nenhum", () => {
    expect(mainLatencyTarget(kinds("OUTRO", "MAIS"))).toEqual({ kind: "OUTRO", n: 0 });
    expect(mainLatencyTarget([])).toBeNull();
  });
});
