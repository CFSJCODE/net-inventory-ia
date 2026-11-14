import { describe, expect, it } from "vitest";
import {
  BUCKET_MS,
  FAILURES_TO_DEGRADED,
  FAILURES_TO_DOWN,
  LOSS_DEGRADED_PCT,
  MIN_BASELINE_POINTS,
  WINDOW_SIZE,
  aggregateChecks,
  bucketStart,
  evaluateTarget,
  jitter,
  latencyLimit,
  mad,
  median,
  percentile,
  uptimePct,
  type RecentCheck,
} from "./stats";

// Os valores esperados foram calculados à mão a partir do que cada comentário promete, não copiados da saída.

describe("median", () => {
  it("devolve null sem valores", () => {
    expect(median([])).toBeNull();
  });

  it("com quantidade ímpar é o valor do meio; com par, a média dos dois do meio", () => {
    expect(median([7])).toBe(7);
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
  });

  it("não altera a lista recebida", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it("um pico isolado não desloca a mediana", () => {
    expect(median([20, 21, 19, 20, 5000])).toBe(20);
  });
});

describe("percentile", () => {
  it("devolve null sem valores", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("interpola linearmente entre os dois valores vizinhos", () => {
    // 4 valores: posição = p/100 × 3. p50 → 1,5 (entre 20 e 30); p95 → 2,85 (entre 30 e 40).
    expect(percentile([40, 10, 30, 20], 50)).toBe(25);
    expect(percentile([10, 20, 30, 40], 95)).toBeCloseTo(38.5, 10);
    expect(percentile([10, 20, 30, 40], 25)).toBeCloseTo(17.5, 10);
  });

  it("p0 é o menor e p100 é o maior; fora de 0 a 100 fica na ponta", () => {
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 100)).toBe(40);
    expect(percentile([10, 20, 30, 40], -5)).toBe(10);
    expect(percentile([10, 20, 30, 40], 150)).toBe(40);
  });

  it("com um valor só, qualquer percentil é ele", () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });
});

describe("mad", () => {
  it("devolve null sem valores", () => {
    expect(mad([])).toBeNull();
  });

  it("é a mediana das distâncias até a mediana", () => {
    // Mediana 3; distâncias 2, 1, 0, 1, 97; mediana delas = 1.
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    expect(mad([20, 20, 20, 20])).toBe(0);
  });
});

describe("jitter", () => {
  it("precisa de pelo menos duas amostras", () => {
    expect(jitter([])).toBeNull();
    expect(jitter([12])).toBeNull();
  });

  it("é a média das diferenças entre amostras consecutivas", () => {
    // |12−10| + |9−12| + |9−9| = 5, em 3 intervalos.
    expect(jitter([10, 12, 9, 9])).toBeCloseTo(5 / 3, 10);
    expect(jitter([5, 5, 5])).toBe(0);
  });
});

describe("uptimePct", () => {
  it("devolve null sem amostras", () => {
    expect(uptimePct(0, 0)).toBeNull();
    expect(uptimePct(-3, 0)).toBeNull();
  });

  it("é 1 − falhas ÷ amostras, em %", () => {
    expect(uptimePct(100, 1)).toBe(99);
    expect(uptimePct(10, 0)).toBe(100);
    expect(uptimePct(10, 10)).toBe(0);
    expect(uptimePct(2880, 3)).toBeCloseTo(99.8958, 4);
  });

  it("fica entre 0 e 100 mesmo com contagens incoerentes", () => {
    expect(uptimePct(10, 15)).toBe(0);
    expect(uptimePct(10, -2)).toBe(100);
  });
});

describe("bucketStart", () => {
  it("a janela tem 5 minutos", () => {
    expect(BUCKET_MS).toBe(300_000);
  });

  it("devolve o início da janela de 5 min que contém o instante", () => {
    const start = Date.UTC(2026, 10, 14, 8, 25, 0);
    expect(bucketStart(start)).toBe(start);
    expect(bucketStart(start + 1)).toBe(start);
    expect(bucketStart(start + BUCKET_MS - 1)).toBe(start);
    expect(bucketStart(start + BUCKET_MS)).toBe(start + BUCKET_MS);
    expect(new Date(bucketStart(Date.UTC(2026, 10, 14, 8, 29, 59, 999))).toISOString()).toBe("2026-11-14T08:25:00.000Z");
  });
});

describe("aggregateChecks", () => {
  it("janela vazia: nenhuma amostra e nenhuma estatística", () => {
    expect(aggregateChecks([])).toEqual({ samples: 0, failures: 0, p50Ms: null, p95Ms: null, maxMs: null, lossPct: null });
  });

  it("as latências contam só as medições que deram certo; a perda é a média das que informam perda", () => {
    const stats = aggregateChecks([
      { ok: true, latencyMs: 10, lossPct: 0 },
      { ok: true, latencyMs: 20, lossPct: 20 },
      { ok: false, latencyMs: null, lossPct: 100 },
      { ok: true, latencyMs: 30, lossPct: null },
    ]);
    expect(stats.samples).toBe(4);
    expect(stats.failures).toBe(1);
    expect(stats.p50Ms).toBe(20);
    // 3 latências: posição 0,95 × 2 = 1,9, entre 20 e 30.
    expect(stats.p95Ms).toBeCloseTo(29, 10);
    expect(stats.maxMs).toBe(30);
    expect(stats.lossPct).toBe(40);
  });

  it("uma falha não entra na latência, mesmo que traga um número", () => {
    const stats = aggregateChecks([
      { ok: true, latencyMs: 10, lossPct: null },
      { ok: false, latencyMs: 9000, lossPct: null },
    ]);
    expect(stats).toEqual({ samples: 2, failures: 1, p50Ms: 10, p95Ms: 10, maxMs: 10, lossPct: null });
  });

  it("janela só com falhas: conta as amostras e não inventa latência", () => {
    const stats = aggregateChecks([
      { ok: false, latencyMs: null, lossPct: null },
      { ok: false, latencyMs: null, lossPct: null },
    ]);
    expect(stats).toEqual({ samples: 2, failures: 2, p50Ms: null, p95Ms: null, maxMs: null, lossPct: null });
  });
});

describe("latencyLimit", () => {
  const flat = (value: number, points = MIN_BASELINE_POINTS) => Array.from({ length: points }, () => value);

  it("não julga com menos de 12 janelas (1 h) de linha de base", () => {
    expect(MIN_BASELINE_POINTS).toBe(12);
    expect(latencyLimit([])).toBeNull();
    expect(latencyLimit(flat(20, 11))).toBeNull();
    expect(latencyLimit(flat(20, 12))).not.toBeNull();
  });

  it("alvo estável e rápido: vale a folga mínima de 20 ms", () => {
    // Mediana 10, MAD 0: 10 + 0 = 10; 10 × 1,5 = 15; 10 + 20 = 30.
    expect(latencyLimit(flat(10))).toEqual({ median: 10, limit: 30 });
  });

  it("alvo estável e lento: vale a folga de 50%", () => {
    // Mediana 100, MAD 0: 100; 150; 120.
    expect(latencyLimit(flat(100))).toEqual({ median: 100, limit: 150 });
  });

  it("alvo que oscila: vale mediana + 3·MAD", () => {
    // Seis janelas a 100 e seis a 200: mediana 150, todas a 50 da mediana (MAD 50): 300; 225; 170.
    expect(latencyLimit([...flat(100, 6), ...flat(200, 6)])).toEqual({ median: 150, limit: 300 });
  });
});

describe("evaluateTarget", () => {
  const ok = (latencyMs: number | null = 20, extra: Partial<RecentCheck> = {}): RecentCheck => ({ ok: true, latencyMs, lossPct: null, certDays: null, ...extra });
  const fail = (extra: Partial<RecentCheck> = {}): RecentCheck => ({ ok: false, latencyMs: null, lossPct: null, certDays: null, ...extra });
  /** Linha de base estável em 20 ms: limite de 40 ms (folga mínima de 20 ms). */
  const baseline = Array.from({ length: 12 }, () => 20);
  const OK = { status: "OK", reason: null };

  it("as constantes são as do plano: janela de 5, 3 falhas para fora, 2 para degradado, perda acima de 5%", () => {
    expect([WINDOW_SIZE, FAILURES_TO_DOWN, FAILURES_TO_DEGRADED, LOSS_DEGRADED_PCT]).toEqual([5, 3, 2, 5]);
  });

  it("sem medições: sem dados", () => {
    expect(evaluateTarget([], baseline)).toEqual({ status: "UNKNOWN", reason: null });
  });

  it("tudo respondendo dentro do normal: ok", () => {
    expect(evaluateTarget([ok(), ok(), ok(), ok(), ok()], baseline)).toEqual(OK);
    expect(evaluateTarget([ok()], [])).toEqual(OK);
  });

  describe("falhas seguidas, contadas a partir da medição mais nova", () => {
    it("uma falha isolada não muda o estado", () => {
      expect(evaluateTarget([fail(), ok(), ok(), ok(), ok()], baseline)).toEqual(OK);
      // Nem num ping, em que a falha vem com 100% de perda.
      expect(evaluateTarget([fail({ lossPct: 100 }), ok(20, { lossPct: 0 }), ok(20, { lossPct: 0 })], baseline)).toEqual(OK);
    });

    it("2 falhas seguidas: degradado", () => {
      expect(evaluateTarget([fail(), fail(), ok(), ok(), ok()], baseline)).toEqual({ status: "DEGRADED", reason: "2 falhas seguidas" });
    });

    it("3 e 4 falhas seguidas: fora", () => {
      expect(evaluateTarget([fail(), fail(), fail(), ok(), ok()], baseline)).toEqual({ status: "DOWN", reason: "3 falhas seguidas" });
      expect(evaluateTarget([fail(), fail(), fail(), fail(), ok()], baseline)).toEqual({ status: "DOWN", reason: "4 falhas seguidas" });
      // Com só 3 medições na história, as 3 falhando.
      expect(evaluateTarget([fail(), fail(), fail()], baseline)).toEqual({ status: "DOWN", reason: "3 falhas seguidas" });
    });

    it("a janela inteira falhando: sem resposta nas últimas 5 medições", () => {
      expect(evaluateTarget([fail(), fail(), fail(), fail(), fail()], baseline)).toEqual({ status: "DOWN", reason: "sem resposta nas últimas 5 medições" });
    });

    it("só as 5 medições mais novas contam", () => {
      expect(evaluateTarget([fail(), fail(), fail(), fail(), fail(), fail(), fail()], baseline)).toEqual({ status: "DOWN", reason: "sem resposta nas últimas 5 medições" });
      expect(evaluateTarget([ok(), ok(), ok(), ok(), ok(), fail(), fail(), fail()], baseline)).toEqual(OK);
    });

    it("volta ao normal na primeira resposta depois de uma queda", () => {
      expect(evaluateTarget([ok(), fail(), fail(), fail(), fail()], baseline)).toEqual(OK);
      // Também no ping: as falhas antigas, com 100% de perda, não seguram o alvo em "perda de pacotes".
      const down = fail({ lossPct: 100 });
      expect(evaluateTarget([ok(20, { lossPct: 0 }), down, down, down, down], baseline)).toEqual(OK);
    });
  });

  describe("certificado", () => {
    it("vencido: degradado", () => {
      expect(evaluateTarget([ok(20, { certDays: -1 }), ok(), ok()], baseline)).toEqual({ status: "DEGRADED", reason: "certificado vencido" });
      expect(evaluateTarget([ok(20, { certDays: -40 })], baseline)).toEqual({ status: "DEGRADED", reason: "certificado vencido" });
    });

    it("perto de vencer não muda o estado: quem renova é o provedor, às vezes na última semana", () => {
      for (const certDays of [0, 1, 7, 13, 14, 60]) {
        expect(evaluateTarget([ok(20, { certDays })], baseline), `${certDays} dias`).toEqual(OK);
      }
    });

    it("vale o certificado da medição mais nova (o provedor já renovou)", () => {
      expect(evaluateTarget([ok(20, { certDays: 89 }), ok(20, { certDays: -1 })], baseline)).toEqual(OK);
    });
  });

  describe("perda de pacotes", () => {
    const ping = (lossPct: number, latencyMs = 20) => ok(latencyMs, { lossPct });

    it("média acima de 5% entre as medições que responderam: degradado", () => {
      // (20 + 20 + 0 + 0 + 0) ÷ 5 = 8%.
      expect(evaluateTarget([ping(20), ping(20), ping(0), ping(0), ping(0)], baseline)).toEqual({ status: "DEGRADED", reason: "perda de 8% dos pacotes" });
    });

    it("média até 5%: ok", () => {
      // 20 ÷ 5 = 4%; 25 ÷ 5 = 5% (o limite é "acima de").
      expect(evaluateTarget([ping(20), ping(0), ping(0), ping(0), ping(0)], baseline)).toEqual(OK);
      expect(evaluateTarget([ping(25), ping(0), ping(0), ping(0), ping(0)], baseline)).toEqual(OK);
    });

    it("a medição sem resposta nenhuma é falha e não entra na média", () => {
      expect(evaluateTarget([ping(0), fail({ lossPct: 100 }), ping(0), ping(0), ping(0)], baseline)).toEqual(OK);
      // (40 + 0 + 0) ÷ 3 ≈ 13%: a perda parcial das que responderam continua contando.
      expect(evaluateTarget([ping(40), fail({ lossPct: 100 }), ping(0), ping(0)], baseline)).toEqual({ status: "DEGRADED", reason: "perda de 13% dos pacotes" });
    });

    it("alvo que não informa perda (HTTP, TCP, DNS) nunca cai nesta regra", () => {
      expect(evaluateTarget([ok(), ok(), ok()], baseline)).toEqual(OK);
    });
  });

  describe("latência", () => {
    it("sustentada acima do limite (mediana da janela): degradado, com quantas vezes e o valor", () => {
      expect(evaluateTarget([ok(100), ok(100), ok(100), ok(20), ok(20)], baseline)).toEqual({ status: "DEGRADED", reason: "latência 5,0× acima do normal (100 ms)" });
      expect(evaluateTarget([ok(70), ok(70), ok(70), ok(70), ok(70)], baseline)).toEqual({ status: "DEGRADED", reason: "latência 3,5× acima do normal (70 ms)" });
    });

    it("um pico isolado, ou dois, não alarma", () => {
      expect(evaluateTarget([ok(500), ok(20), ok(20), ok(20), ok(20)], baseline)).toEqual(OK);
      expect(evaluateTarget([ok(500), ok(500), ok(20), ok(20), ok(20)], baseline)).toEqual(OK);
    });

    it("no limite exato ainda é normal", () => {
      expect(evaluateTarget([ok(40), ok(40), ok(40), ok(40), ok(40)], baseline)).toEqual(OK);
      expect(evaluateTarget([ok(40.1), ok(40.1), ok(40.1), ok(40.1), ok(40.1)], baseline).status).toBe("DEGRADED");
    });

    it("com menos de 12 janelas na linha de base a latência não é julgada", () => {
      expect(evaluateTarget([ok(900), ok(900), ok(900), ok(900), ok(900)], baseline.slice(0, 11))).toEqual(OK);
      expect(evaluateTarget([ok(900), ok(900), ok(900), ok(900), ok(900)], [])).toEqual(OK);
    });

    it("com menos de 3 medições respondidas na janela a latência não é julgada", () => {
      expect(evaluateTarget([ok(900), ok(900)], baseline)).toEqual(OK);
      expect(evaluateTarget([ok(900), fail(), ok(900), fail(), fail()], baseline)).toEqual(OK);
    });

    it("as falhas da janela não entram na mediana da latência", () => {
      // Três respostas lentas e uma falha isolada no meio: a mediana das respondidas é 100.
      expect(evaluateTarget([ok(100), fail(), ok(100), ok(100), ok(20)], baseline)).toEqual({ status: "DEGRADED", reason: "latência 5,0× acima do normal (100 ms)" });
    });
  });

  describe("ordem das regras: falhas, certificado, perda, latência", () => {
    it("falhas seguidas vêm antes do certificado", () => {
      // Um HTTP 503 é falha e ainda traz o certificado.
      const expired503 = fail({ certDays: -1 });
      expect(evaluateTarget([expired503, expired503, ok()], baseline)).toEqual({ status: "DEGRADED", reason: "2 falhas seguidas" });
      expect(evaluateTarget([expired503, expired503, expired503], baseline)).toEqual({ status: "DOWN", reason: "3 falhas seguidas" });
    });

    it("certificado vencido vem antes da perda e da latência", () => {
      const check = ok(900, { certDays: -1, lossPct: 60 });
      expect(evaluateTarget([check, check, check, check, check], baseline)).toEqual({ status: "DEGRADED", reason: "certificado vencido" });
    });

    it("perda vem antes da latência", () => {
      const check = ok(900, { lossPct: 60 });
      expect(evaluateTarget([check, check, check, check, check], baseline)).toEqual({ status: "DEGRADED", reason: "perda de 60% dos pacotes" });
    });
  });
});
