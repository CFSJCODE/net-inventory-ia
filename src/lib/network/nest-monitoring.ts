/** Contrato dos campos já selecionados pela leitura de /setup/eureka_info. */
export interface NestField { name: string; value: string; present: boolean }
export interface NestGroup { title: string; description: string; fields: NestField[] }
export interface NestDetails { title: string; groups: NestGroup[] }
export interface NestEndpoint {
  id: string;
  name: string;
  url: string;
  readAt: string;
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
  details: NestDetails | null;
}
export interface NestSample {
  readAt: string;
  ok: boolean;
  httpStatus: number | null;
  durationMs: number | null;
  connected: boolean | null;
  uptime: number | null;
  firmware: string | null;
}

export const NEST_HISTORY_LIMIT = 60;
export function nestField(details: NestDetails | null, name: string): NestField | undefined {
  return details?.groups.flatMap(group => group.fields).find(field => field.name === name && field.present);
}
export function nestValue(details: NestDetails | null, name: string): string {
  return nestField(details, name)?.value ?? "Não informado";
}
export function nestBoolean(details: NestDetails | null, name: string): boolean | null {
  const value = nestField(details, name)?.value;
  if (value === "Sim (true)" || value === "true") return true;
  if (value === "Não (false)" || value === "false") return false;
  return null;
}
export function nestUptime(details: NestDetails | null): number | null {
  const value = nestField(details, "uptime")?.value;
  // O extrator mantém os segundos originais entre parênteses, em pt-BR.
  const match = value?.match(/\(([\d.,]+) s\)$/);
  if (!match) return null;
  const seconds = Number(match[1].replaceAll(".", "").replace(",", "."));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
export function nestConnection(details: NestDetails | null): string {
  const connected = nestBoolean(details, "connected");
  const ethernet = nestBoolean(details, "ethernet_connected");
  if (ethernet === true) return "Ethernet";
  if (connected === true && ethernet === false) return "Wi-Fi";
  if (connected === false) return "Sem conexão informada";
  return "Não informado";
}
export function nestSample(endpoint: NestEndpoint): NestSample {
  const details = endpoint.ok ? endpoint.details : null;
  return {
    readAt: endpoint.readAt, ok: endpoint.ok, httpStatus: endpoint.httpStatus,
    durationMs: Number.isFinite(endpoint.durationMs) && endpoint.durationMs >= 0 ? endpoint.durationMs : null,
    connected: nestBoolean(details, "connected"), uptime: nestUptime(details),
    firmware: nestField(details, "build_version")?.value ?? null,
  };
}
/** Uma amostra por consulta, com tamanho limitado; não é histórico persistente. */
export function appendNestSample(samples: NestSample[], sample: NestSample): NestSample[] {
  if (samples.some(item => item.readAt === sample.readAt)) return samples;
  return [...samples, sample].slice(-NEST_HISTORY_LIMIT);
}
export function nestHistoryStats(samples: NestSample[]) {
  const successful = samples.filter(sample => sample.ok);
  const durations = successful.flatMap(sample => sample.durationMs === null ? [] : [sample.durationMs]);
  return {
    count: samples.length, successful: successful.length,
    availablePct: samples.length ? Math.round(successful.length / samples.length * 100) : null,
    averageMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    minMs: durations.length ? Math.min(...durations) : null,
    maxMs: durations.length ? Math.max(...durations) : null,
    errors: samples.length - successful.length,
  };
}
export function nestChanges(samples: NestSample[]): string[] {
  const changes: string[] = [];
  const successful = samples.filter(sample => sample.ok);
  const current = successful.at(-1);
  const previous = successful.at(-2);
  if (!previous || !current) return changes;
  if (previous.uptime !== null && current.uptime !== null && current.uptime + 5 < previous.uptime) {
    changes.push("O tempo de funcionamento diminuiu entre as duas últimas leituras válidas.");
  }
  if (previous.firmware && current.firmware && previous.firmware !== current.firmware) {
    changes.push("A compilação do firmware mudou entre as duas últimas leituras válidas.");
  }
  if (previous.connected !== null && current.connected !== null && previous.connected !== current.connected) {
    changes.push(current.connected ? "O Nest passou a informar conexão ativa." : "O Nest passou a informar ausência de conexão.");
  }
  return changes;
}
export const NEST_FIELD_LABELS: Record<string, string> = {
  connected: "Conexão informada", ethernet_connected: "Ethernet", ip_address: "Endereço IP",
  ssid: "Rede Wi-Fi", bssid: "Ponto de acesso (BSSID)", mac_address: "MAC do aparelho",
  wpa_configured: "Wi-Fi configurado", wpa_state: "Estado WPA (código)", wpa_id: "ID WPA",
  build_version: "Compilação", cast_build_revision: "Versão Cast", release_track: "Canal",
  has_update: "Atualização sinalizada", uptime: "Tempo de funcionamento", name: "Nome do aparelho",
  ssdp_udn: "Identificador de descoberta (SSDP)", uma_client_id: "Identificador do cliente UMA",
  hotspot_bssid: "BSSID de configuração", locale: "Idioma e região", time_format: "Formato de horário (código)",
  "opt_in.crash": "Relatórios de falhas", "opt_in.stats": "Estatísticas de uso",
  setup_state: "Estado de configuração (código)", tos_accepted: "Termos aceitos", version: "Versão interna",
  "device_info.capabilities.multizone_supported": "Áudio em grupos",
  "device_info.capabilities.bluetooth_supported": "Bluetooth",
  "setup_stats.num_connect_wifi": "Conexões ao Wi-Fi",
  "setup_stats.num_obtain_ip": "Obtenções de endereço IP",
  "setup_stats.num_check_connectivity": "Verificações de conectividade",
};
