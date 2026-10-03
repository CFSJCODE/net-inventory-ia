export type DeviceTypeGuess =
  | "COMPUTER"
  | "NOTEBOOK"
  | "MOBILE"
  | "PRINTER"
  | "CAMERA"
  | "NVR"
  | "SWITCH"
  | "ROUTER"
  | "SERVER"
  | "UNKNOWN";

export interface DiscoveredHost {
  ip: string;
  mac: string | null;
  /** Endereços IPv6 (global primeiro); vazio se o dispositivo não respondeu via IPv6. */
  ipv6: string[];
  hostname: string | null;
  vendor: string | null;
  openPorts: number[];
  type: DeviceTypeGuess;
}
