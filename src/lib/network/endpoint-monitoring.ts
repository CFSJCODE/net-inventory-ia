/** Shared equipment categories and transport rules; no credentials or raw response data. */
export const EQUIPMENT_KINDS = [
  "auto", "printer", "network", "COMPUTER", "NOTEBOOK", "MOBILE", "PRINTER",
  "CAMERA", "NVR", "SWITCH", "ROUTER", "SERVER", "SMART_TV", "IOT", "UNKNOWN",
] as const;
export const MONITOR_MODES = ["snmp", "http", "both", "none"] as const;
export function normalizeEquipmentKind(value: unknown): string {
  return EQUIPMENT_KINDS.includes(value as typeof EQUIPMENT_KINDS[number]) ? String(value) : "auto";
}
export function normalizeMonitorMode(value: unknown): string {
  return MONITOR_MODES.includes(value as typeof MONITOR_MODES[number]) ? String(value) : "snmp";
}
export function usesSnmp(mode: unknown): boolean { return mode === "snmp" || mode === "both"; }
export function usesHttp(mode: unknown): boolean { return mode === "http" || mode === "both"; }
export function snmpEquipmentKind(kind: unknown): "auto" | "printer" | "network" {
  if (kind === "printer" || kind === "PRINTER") return "printer";
  if (kind === "network" || kind === "SWITCH" || kind === "ROUTER") return "network";
  return "auto";
}
export function validateEndpointFormat(format: unknown, purpose: unknown): "json" | "http" {
  const resolved = format ?? "json";
  if (resolved !== "json" && resolved !== "http") throw new Error("Formato de endpoint inválido.");
  if (resolved === "http" && purpose !== "availability") throw new Error("HTTP simples usa a finalidade Disponibilidade.");
  return resolved;
}
export function parseEndpointJson(text: string, purpose: string, parse: (text: string) => unknown): unknown {
  let value: unknown;
  try { value = parse(text); } catch { throw new Error("Resposta inválida: esperado JSON ou JSON5."); }
  if (purpose !== "availability" && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("Resposta inválida: esperado um objeto JSON ou JSON5.");
  }
  return value;
}
