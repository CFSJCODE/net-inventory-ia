import { describe, expect, it } from "vitest";
import * as rules from "./rules";

const at = (h: number, m: number) => new Date(2026, 9, 23, h, m, 0, 0);
const quiet = (now: Date, start: string, end: string): boolean => {
  const fn = (rules as Record<string, unknown>).isQuietTime;
  if (typeof fn !== "function") throw new Error("isQuietTime não exportada");
  return (fn as (n: Date, s: string, e: string) => boolean)(now, start, end);
};

describe("isQuietTime", () => {
  it("janela no mesmo dia", () => {
    expect(quiet(at(12, 0), "12:00", "13:30")).toBe(true);
    expect(quiet(at(13, 29), "12:00", "13:30")).toBe(true);
    expect(quiet(at(13, 30), "12:00", "13:30")).toBe(false);
    expect(quiet(at(11, 59), "12:00", "13:30")).toBe(false);
  });
  it("janela que atravessa a meia-noite", () => {
    expect(quiet(at(23, 30), "22:00", "06:00")).toBe(true);
    expect(quiet(at(0, 0), "22:00", "06:00")).toBe(true);
    expect(quiet(at(5, 59), "22:00", "06:00")).toBe(true);
    expect(quiet(at(6, 0), "22:00", "06:00")).toBe(false);
    expect(quiet(at(21, 59), "22:00", "06:00")).toBe(false);
    expect(quiet(at(22, 0), "22:00", "06:00")).toBe(true);
  });
  it("início igual ao fim não silencia", () => {
    expect(quiet(at(8, 0), "08:00", "08:00")).toBe(false);
    expect(quiet(at(3, 0), "08:00", "08:00")).toBe(false);
  });
  it("horários inválidos não silenciam nem lançam", () => {
    expect(quiet(at(1, 0), "25:00", "06:00")).toBe(false);
    expect(quiet(at(1, 0), "22:00", "7h")).toBe(false);
    expect(quiet(at(1, 0), "", "06:00")).toBe(false);
    expect(quiet(at(1, 0), "22:60", "06:00")).toBe(false);
  });
});
