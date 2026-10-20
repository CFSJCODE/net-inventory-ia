import type { NestDetails, NestField, NestGroup } from "./nest-monitoring";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const invalidKey = /secret|token|password|credential|authorization|cookie|session|api.?key/i;
function uptime(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const remainder = total % 60;
  return `${hours} ${hours === 1 ? "hora" : "horas"}, ${minutes} ${minutes === 1 ? "minuto" : "minutos"} e ${remainder} ${remainder === 1 ? "segundo" : "segundos"} (${seconds.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} s)`;
}
/** Seleção explícita: não envia o JSON bruto nem campos de autorização ao navegador. */
export function extractNestTelemetry(payload: unknown, url: string): NestDetails | null {
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return null; }
  if (!/^\/setup\/eureka_info\/?$/.test(pathname) || payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const root = object(payload);
  const field = (name: string): NestField => {
    let value: unknown = root;
    for (const part of name.split(".")) value = object(value)[part];
    let formatted: string | null = null;
    if (name === "uptime") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) formatted = uptime(value);
    } else if (typeof value === "boolean") formatted = value ? "Sim (true)" : "Não (false)";
    else if (typeof value === "number" && Number.isFinite(value)) formatted = String(value);
    else if (typeof value === "string" && value.trim()) formatted = value.slice(0, 512);
    return { name, value: formatted ?? "Não informado", present: formatted !== null };
  };
  const group = (title: string, description: string, names: string[]): NestGroup => ({ title, description, fields: names.map(field) });
  const dynamic = (prefix: string, value: unknown, expected: "boolean" | "number"): string[] => Object.entries(object(value))
    .filter(([key, item]) => /^[a-zA-Z0-9_]{1,80}$/.test(key) && !invalidKey.test(key) && typeof item === expected && (expected !== "number" || Number.isFinite(item)))
    .map(([key]) => `${prefix}.${key}`).sort().slice(0, 64);
  const capabilities = dynamic("device_info.capabilities", object(root.device_info).capabilities, "boolean");
  const counters = dynamic("setup_stats", root.setup_stats, "number");
  return { title: "Informações do Nest", groups: [
    group("Conexão", "Estado de conexão, uso de Ethernet e endereço IP informados pelo Nest.", ["connected", "ethernet_connected", "ip_address"]),
    group("Rede Wi-Fi", "Rede, ponto de acesso, MAC do aparelho e códigos internos de configuração Wi-Fi.", ["ssid", "bssid", "mac_address", "wpa_configured", "wpa_state", "wpa_id"]),
    group("Firmware", "Compilação, versão Cast, canal de distribuição e sinalização local de atualização.", ["build_version", "cast_build_revision", "release_track", "has_update"]),
    group("Tempo de funcionamento", "Tempo de atividade em segundos informado pelo aparelho nesta consulta.", ["uptime"]),
    group("Identificação do aparelho", "Nome e identificadores técnicos do aparelho, da descoberta e da configuração.", ["name", "ssdp_udn", "uma_client_id", "hotspot_bssid"]),
    group("Idioma e horário", "Idioma/região e código interno de formato de horário.", ["locale", "time_format"]),
    group("Recursos suportados", "Capacidades declaradas pelo firmware. Áudio em grupos corresponde a multizone_supported.", capabilities),
    group("Diagnósticos e estatísticas", "Participação em relatórios de falhas e estatísticas. São preferências, não alertas ativos.", ["opt_in.crash", "opt_in.stats"]),
    group("Configuração inicial", "Estado interno e contadores do processo de configuração.", ["setup_state", ...counters]),
    group("Outros indicadores", "Aceitação dos termos e indicador interno de versão.", ["tos_accepted", "version"]),
  ] };
}
