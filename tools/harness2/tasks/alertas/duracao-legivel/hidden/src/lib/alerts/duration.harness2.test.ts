import { describe, expect, it } from "vitest";
import { formatDuration } from "./rules";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

describe("formatDuration sem partes zeradas", () => {
  it("mantém minutos e menos de 1 minuto", () => {
    expect(formatDuration(10_000)).toBe("menos de 1 min");
    expect(formatDuration(5 * MIN)).toBe("5 min");
    expect(formatDuration(59 * MIN)).toBe("59 min");
  });
  it("omite minutos zerados", () => {
    expect(formatDuration(H)).toBe("1h");
    expect(formatDuration(3 * H)).toBe("3h");
  });
  it("mantém horas com minutos", () => {
    expect(formatDuration(H + 5 * MIN)).toBe("1h 5min");
    expect(formatDuration(23 * H + 59 * MIN)).toBe("23h 59min");
  });
  it("omite horas zeradas", () => {
    expect(formatDuration(2 * D)).toBe("2d");
    expect(formatDuration(D + 3 * H)).toBe("1d 3h");
  });
  it("arredonda para o minuto mais próximo", () => {
    expect(formatDuration(H - 20_000)).toBe("1h");
  });
});
