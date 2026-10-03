import { describe, expect, it } from "vitest";
import { findingsForPorts } from "./security-rules";

describe("findingsForPorts", () => {
  it("ordena por severidade e ignora portas sem regra", () => {
    const findings = findingsForPorts([80, 443, 23, 445]);
    expect(findings.map((f) => [f.port, f.severity])).toEqual([
      [23, "alta"],
      [445, "média"],
      [80, "baixa"],
    ]);
  });
});
