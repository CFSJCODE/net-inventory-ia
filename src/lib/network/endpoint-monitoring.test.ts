import { describe, expect, it } from "vitest";
import { EQUIPMENT_KINDS, normalizeEquipmentKind, normalizeMonitorMode, parseEndpointJson, snmpEquipmentKind, usesHttp, usesSnmp, validateEndpointFormat } from "./endpoint-monitoring";

describe("equipment endpoint monitoring", () => {
  it("preserves inventory categories and legacy equipment kinds", () => {
    for (const kind of EQUIPMENT_KINDS) expect(normalizeEquipmentKind(kind)).toBe(kind);
    expect(normalizeEquipmentKind("invalid")).toBe("auto");
  });
  it("does not enable a transport on unmonitored equipment", () => {
    for (const mode of ["snmp", "http", "both", "none"]) expect(normalizeMonitorMode(mode)).toBe(mode);
    expect(usesHttp("none")).toBe(false);
    expect(usesSnmp("none")).toBe(false);
    expect(usesSnmp("http")).toBe(false);
    expect(usesSnmp("both")).toBe(true);
  });
  it("maps inventory categories to the existing SNMP readers without changing the saved category", () => {
    expect(snmpEquipmentKind("PRINTER")).toBe("printer");
    expect(snmpEquipmentKind("printer")).toBe("printer");
    expect(snmpEquipmentKind("SWITCH")).toBe("network");
    expect(snmpEquipmentKind("IOT")).toBe("auto");
    expect(normalizeEquipmentKind("PRINTER")).toBe("PRINTER");
  });
  it("defaults old endpoints to JSON and restricts plain HTTP to availability", () => {
    expect(validateEndpointFormat(undefined, "status")).toBe("json");
    expect(validateEndpointFormat("http", "availability")).toBe("http");
    expect(() => validateEndpointFormat("http", "alerts")).toThrow();
    expect(() => validateEndpointFormat("xml", "availability")).toThrow();
  });
  it("accepts any valid JSON for availability while keeping printer parsers strict", () => {
    expect(parseEndpointJson("[1,2]", "availability", JSON.parse)).toEqual([1, 2]);
    expect(parseEndpointJson("false", "availability", JSON.parse)).toBe(false);
    expect(parseEndpointJson("null", "availability", JSON.parse)).toBeNull();
    expect(() => parseEndpointJson("bad", "availability", JSON.parse)).toThrow();
    expect(() => parseEndpointJson("[]", "status", JSON.parse)).toThrow();
  });
});
