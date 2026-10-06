import dgram from "node:dgram";
import type { DeviceType } from "@prisma/client";

export interface MdnsDeviceHint {
  ip: string;
  hostname?: string;
  suggestedType?: DeviceType;
  services: string[];
  rawInfo?: string;
}

/**
 * Monta pacote de consulta mDNS (PTR query para serviços conhecidos).
 */
function buildMdnsQuery(serviceName: string): Buffer {
  const parts = serviceName.split(".");
  const qname: number[] = [];
  for (const part of parts) {
    qname.push(part.length);
    for (let i = 0; i < part.length; i++) qname.push(part.charCodeAt(i));
  }
  qname.push(0);

  const header = Buffer.from([
    0x00, 0x00, // ID
    0x00, 0x00, // Flags
    0x00, 0x01, // Questions: 1
    0x00, 0x00, // Answer RRs: 0
    0x00, 0x00, // Authority RRs: 0
    0x00, 0x00, // Additional RRs: 0
  ]);

  const question = Buffer.concat([
    Buffer.from(qname),
    Buffer.from([0x00, 0x0c, 0x00, 0x01]), // PTR, IN
  ]);

  return Buffer.concat([header, question]);
}

/**
 * Extrai nomes e serviços legíveis do pacote mDNS.
 */
function parseMdnsPayload(buffer: Buffer): { services: string[]; hostname?: string } {
  const text = buffer.toString("utf8");
  const services: string[] = [];
  let hostname: string | undefined;

  // Procura por serviços conhecidos na mensagem
  const servicePatterns = [
    "_ipp",
    "_printer",
    "_pdl-datastream",
    "_scanner",
    "_googlecast",
    "_airplay",
    "_raop",
    "_spotify-connect",
    "_media-remotetv",
    "_http",
    "_https",
    "_smb",
    "_dhnap",
  ];

  for (const s of servicePatterns) {
    if (text.includes(s)) {
      services.push(s);
    }
  }

  // Extrai hostname do padrão *.local
  const localMatch = text.match(/([a-zA-Z0-9_\-\s]{2,40})\.local/);
  if (localMatch && !localMatch[1].startsWith("_")) {
    const rawName = localMatch[1].trim();
    if (rawName && !rawName.includes("\0") && rawName.length > 2) {
      hostname = rawName;
    }
  }

  return { services, hostname };
}

/**
 * Infere o tipo de dispositivo a partir dos serviços mDNS e SSDP descobertos.
 */
export function inferTypeFromServices(services: string[], textInfo: string): DeviceType | undefined {
  const lower = textInfo.toLowerCase();

  // Impressoras
  if (
    services.some((s) => ["_ipp", "_printer", "_pdl-datastream", "_scanner"].includes(s)) ||
    lower.includes("printer") ||
    lower.includes("deskjet") ||
    lower.includes("laserjet") ||
    lower.includes("epson") ||
    lower.includes("brother")
  ) {
    return "PRINTER";
  }

  // Câmeras / NVR
  if (lower.includes("camera") || lower.includes("ipc") || lower.includes("dvr") || lower.includes("nvr") || lower.includes("hikvision") || lower.includes("dahua")) {
    return lower.includes("nvr") || lower.includes("dvr") ? "NVR" : "CAMERA";
  }

  // Roteadores e gateways domésticos
  if (services.includes("_dhnap") || lower.includes("router") || lower.includes("gateway") || lower.includes("wireless ap")) {
    return "ROUTER";
  }

  // Smart TVs e Aparelhos de Streaming
  if (
    services.includes("_googlecast") ||
    services.includes("_media-remotetv") ||
    lower.includes("smart tv") ||
    lower.includes("smart-tv") ||
    lower.includes("chromecast") ||
    lower.includes("bravia") ||
    lower.includes("roku") ||
    lower.includes("firetv") ||
    lower.includes("webos") ||
    lower.includes("tizen") ||
    lower.includes("apple tv") ||
    lower.includes("mibox") ||
    (lower.includes("tv") && !lower.includes("tvr"))
  ) {
    return "SMART_TV";
  }

  // Dispositivos IoT / Automação / Sensores / Lâmpadas / Tomadas / Assistentes de voz
  if (
    services.includes("_hap") ||
    services.includes("_matter") ||
    services.includes("_esphomelib") ||
    services.includes("_alexa") ||
    lower.includes("esp32") ||
    lower.includes("esp8266") ||
    lower.includes("tasmota") ||
    lower.includes("shelly") ||
    lower.includes("sonoff") ||
    lower.includes("tuya") ||
    lower.includes("smart-plug") ||
    lower.includes("smart-bulb") ||
    lower.includes("echo dot") ||
    lower.includes("nest mini") ||
    lower.includes("homepod") ||
    lower.includes("home assistant")
  ) {
    return "IOT";
  }

  // Celulares e streaming de áudio
  if (services.includes("_airplay") || services.includes("_spotify-connect")) {
    return "MOBILE";
  }

  return undefined;
}

/**
 * Realiza uma varredura mDNS + SSDP na rede local por um curto período (1.5s a 2s).
 * Retorna um mapa indexado por endereço IP com os dados e sugestões encontradas.
 */
export async function discoverMdnsAndSsdp(timeoutMs: number = 2000): Promise<Map<string, MdnsDeviceHint>> {
  const results = new Map<string, MdnsDeviceHint>();

  return new Promise((resolve) => {
    let mdnsSocket: dgram.Socket | null = null;
    let ssdpSocket: dgram.Socket | null = null;
    let timer: NodeJS.Timeout | null = null;
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try {
        mdnsSocket?.close();
      } catch {}
      try {
        ssdpSocket?.close();
      } catch {}
      resolve(results);
    };

    timer = setTimeout(cleanup, timeoutMs);

    // 1. mDNS Socket
    try {
      mdnsSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      mdnsSocket.on("message", (msg, rinfo) => {
        const ip = rinfo.address;
        const { services, hostname } = parseMdnsPayload(msg);
        const existing = results.get(ip) ?? { ip, services: [], rawInfo: "" };

        for (const s of services) {
          if (!existing.services.includes(s)) existing.services.push(s);
        }
        if (hostname && !existing.hostname) existing.hostname = hostname;

        const rawText = msg.toString("utf8");
        const suggested = inferTypeFromServices(existing.services, (existing.hostname ?? "") + " " + rawText);
        if (suggested) existing.suggestedType = suggested;

        results.set(ip, existing);
      });

      mdnsSocket.on("error", () => {
        // Ignora silenciosamente em caso de restrição de porta
      });

      mdnsSocket.bind(0, () => {
        try {
          mdnsSocket?.addMembership("224.0.0.251");
          const query = buildMdnsQuery("_services._dns-sd._udp.local");
          mdnsSocket?.send(query, 5353, "224.0.0.251");
        } catch {}
      });
    } catch {}

    // 2. SSDP Socket (UPnP)
    try {
      ssdpSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      ssdpSocket.on("message", (msg, rinfo) => {
        const ip = rinfo.address;
        const text = msg.toString("utf8");
        const existing = results.get(ip) ?? { ip, services: [], rawInfo: "" };

        const serverMatch = text.match(/SERVER:\s*([^\r\n]+)/i);
        const fnMatch = text.match(/FRIENDLYNAME:\s*([^\r\n]+)/i);
        const modelMatch = text.match(/MODELNAME:\s*([^\r\n]+)/i);

        const info = [serverMatch?.[1], fnMatch?.[1], modelMatch?.[1]].filter(Boolean).join(" ");
        if (info) {
          existing.rawInfo = (existing.rawInfo ? existing.rawInfo + " " : "") + info;
        }

        if (fnMatch?.[1] && !existing.hostname) {
          existing.hostname = fnMatch[1].trim();
        }

        const suggested = inferTypeFromServices(existing.services, (existing.hostname ?? "") + " " + (existing.rawInfo ?? ""));
        if (suggested) existing.suggestedType = suggested;

        results.set(ip, existing);
      });

      ssdpSocket.on("error", () => {});

      const msearch =
        'M-SEARCH * HTTP/1.1\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: ssdp:all\r\n\r\n';

      ssdpSocket.bind(0, () => {
        try {
          ssdpSocket?.send(Buffer.from(msearch), 1900, "239.255.255.250");
        } catch {}
      });
    } catch {}
  });
}
