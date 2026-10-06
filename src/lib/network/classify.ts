import { RANDOMIZED_MAC_LABEL } from "./vendor-lookup";
import type { DeviceTypeGuess } from "./types";

const ROUTER_VENDORS = ["tp-link", "d-link", "netgear", "ubiquiti", "mikrotik", "huawei", "asus"];
const SERVER_VENDORS = ["synology", "qnap", "dell", "vmware", "microsoft (hyper-v)", "qemu/kvm"];
const PRINTER_VENDORS = ["brother", "ricoh", "xerox", "epson", "canon"];
const MOBILE_VENDORS = ["xiaomi", "samsung", "motorola", "apple", "oppo", "vivo mobile", "realme", "oneplus", "huawei device", "honor device", "google"];
const CAMERA_VENDORS = ["hikvision", "dahua", "intelbras", "reolink", "foscam", "axis communications", "vivotek", "amcrest"];
const SMART_TV_VENDORS = ["lg electronics", "roku", "tcl", "hisense", "vestel", "vizio"];
const IOT_VENDORS = ["espressif", "tuya", "sonoff", "shelly", "broadlink", "itead", "raspberry pi", "arduino", "wemos", "belkin", "lutron", "wyze"];

interface ClassifyInput {
  ip: string;
  hostname: string | null;
  vendor: string | null;
  openPorts: number[];
}

function isGatewayLikeIp(ip: string): boolean {
  const lastOctet = Number(ip.split(".").pop());
  return lastOctet === 1 || lastOctet === 254;
}

/** Heurística simples de classificação por vendor, hostname e portas abertas. */
export function classifyDevice({ ip, hostname, vendor, openPorts }: ClassifyInput): DeviceTypeGuess {
  const host = hostname?.toLowerCase() ?? "";
  const vend = vendor?.toLowerCase() ?? "";
  const hasPort = (p: number) => openPorts.includes(p);

  if (hasPort(9100) || hasPort(631) || PRINTER_VENDORS.some((v) => vend.includes(v)) || host.includes("print")) {
    return "PRINTER";
  }

  const looksLikeCameraGear =
    hasPort(554) || hasPort(8000) || CAMERA_VENDORS.some((v) => vend.includes(v)) || host.match(/cam|ipc|dvr|nvr/);
  if (looksLikeCameraGear) {
    return host.match(/nvr|dvr/) ? "NVR" : "CAMERA";
  }

  if (
    (isGatewayLikeIp(ip) && (hasPort(80) || hasPort(443))) ||
    // Roteador/AP gerenciável costuma expor painel web e/ou SSH — checado antes da regra de
    // servidor, que também olha a porta 22.
    (ROUTER_VENDORS.some((v) => vend.includes(v)) && (hasPort(80) || hasPort(443) || hasPort(22)))
  ) {
    return "ROUTER";
  }

  if (host.includes("switch") || vend.includes("cisco") || host.match(/procurve|catalyst|aruba/)) {
    return "SWITCH";
  }

  // Smart TVs e Streaming (Chromecast, Roku, Fire TV, Apple TV, WebOS, Tizen)
  const looksLikeSmartTv =
    host.match(/smarttv|smart-tv|webos|tizen|bravia|roku|firetv|firestick|chromecast|appletv|apple-tv|mibox|mi-box|androidtv|android-tv|tv-box|tvbox/) ||
    SMART_TV_VENDORS.some((v) => vend.includes(v)) ||
    (host.includes("tv") && !host.includes("tvr")) ||
    hasPort(8008) ||
    hasPort(8009);
  if (looksLikeSmartTv) {
    return "SMART_TV";
  }

  // IoT / Automação / Sensores / Lâmpadas / Tomadas inteligentes / Espressif ESP32 / Alexa / Google Home
  const looksLikeIot =
    IOT_VENDORS.some((v) => vend.includes(v)) ||
    host.match(/esp_|espressif|tasmota|wled|sonoff|shelly|tuya|smartlife|smart-plug|smart-bulb|homeassistant|home-assistant|echo-dot|echodot|nest-mini|alexa\b/) ||
    hasPort(1883);
  if (looksLikeIot) {
    return "IOT";
  }

  if (
    SERVER_VENDORS.some((v) => vend.includes(v)) ||
    host.match(/srv|server|nas|host\d/) ||
    (hasPort(22) && !hasPort(3389) && !hasPort(445))
  ) {
    return "SERVER";
  }

  if (hasPort(3389) || hasPort(445)) {
    if (host.match(/nb|notebook|laptop|mbp|macbook/)) {
      return "NOTEBOOK";
    }
    return "COMPUTER";
  }

  if (vend.includes("apple") && host.match(/macbook|mbp/)) {
    return "NOTEBOOK";
  }

  const looksLikePhoneName = host.match(/iphone|android|galaxy|redmi|xiaomi|pixel|oneplus|moto\b/);
  // Celulares modernos não abrem portas de servidor e, por padrão, usam MAC aleatório por
  // rede (privacidade) — combinação forte o bastante para diferenciar de um notebook parado.
  const looksLikeRandomizedPhone = vendor === RANDOMIZED_MAC_LABEL && openPorts.length === 0;
  // Fabricante de celular sem nenhuma porta de serviço aberta (ex: Xiaomi com MAC real).
  const looksLikePhoneVendor = MOBILE_VENDORS.some((v) => vend.includes(v)) && openPorts.length === 0;
  if (looksLikePhoneName || looksLikeRandomizedPhone || looksLikePhoneVendor) {
    return "MOBILE";
  }

  return "UNKNOWN";
}
