import net from "node:net";
import type { Device, DeviceType } from "@prisma/client";
import { isRandomizedMac } from "@/lib/mac";
import { displayName } from "@/lib/device-name";

/**
 * Mascaramento do que vai para a OpenAI. IPs, MACs, hostnames e apelidos são trocados por tokens
 * ("dispositivo-3", "ip-7", "mac-2") com um mapa que vive só durante a requisição; a resposta da IA
 * é "desmascarada" localmente antes de ser exibida. Fabricante, tipo e portas vão como estão.
 */

export interface MaskedDevice {
  ref: string;
  ip: string;
  mac: string | null;
  macAleatorio: boolean;
  fabricante: string | null;
  tipo: DeviceType;
  status: string;
  portasAbertas: number[];
  temIpv6: boolean;
  temApelido: boolean;
  /** Dicas genéricas tiradas do hostname/apelido localmente (o texto em si não é enviado). */
  dicasDoNome: string[];
}

const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const MAC_RE = /\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/g;
// Candidatos a IPv6 (2+ dois-pontos); cada um é confirmado com net.isIPv6, o que descarta horários
// como 12:30:45 e cobre a forma comprimida (2001:db8::1), que uma regex pura erra com facilidade.
const IPV6_CANDIDATE_RE = /(?<![\w:])[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}(?:%\w+)?(?![\w:])/g;
const TOKEN_RE = /\b(dispositivo|ip|mac|host)-(\d+)\b/g;

const NAME_HINTS: [RegExp, string][] = [
  [/^(desktop|laptop|win)-/i, "padrão de nome do Windows"],
  [/android/i, "Android"],
  [/iphone|ipad/i, "iPhone/iPad"],
  [/macbook|imac|mac-?mini/i, "Mac"],
  [/galaxy|samsung/i, "Samsung"],
  [/redmi|xiaomi|poco/i, "Xiaomi"],
  [/moto|motorola/i, "Motorola"],
  [/print|epson|brother|hp-?[a-z]*jet|canon/i, "impressora"],
  [/\btv\b|bravia|roku|chromecast|fire-?tv|smart-?tv|webos/i, "TV/streaming"],
  [/cam|ipc|dvr|nvr/i, "câmera/gravador"],
  [/router|roteador|tp-?link|archer|deco|menuvivo|vivo|claro|net-?virtua/i, "roteador"],
  [/switch/i, "switch"],
  [/nas|synology|qnap|server|srv/i, "servidor/NAS"],
  [/echo|alexa|google-?home|nest/i, "assistente de voz"],
  [/ps[45]|playstation|xbox|nintendo|switch-?console/i, "videogame"],
];

export function nameHints(...names: (string | null | undefined)[]): string[] {
  const text = names.filter(Boolean).join(" ");
  return Array.from(new Set(NAME_HINTS.filter(([re]) => re.test(text)).map(([, hint]) => hint)));
}

export class Redactor {
  private forward = new Map<string, string>();
  private back = new Map<string, string>();
  private counters = { dispositivo: 0, ip: 0, mac: 0, host: 0 };
  /** Nomes conhecidos (hostname/apelido) -> token, para mascarar texto livre como mensagens de eventos. */
  private names = new Map<string, string>();

  private token(kind: keyof Redactor["counters"], real: string, display = real): string {
    const key = `${kind}:${real.toLowerCase()}`;
    const existing = this.forward.get(key);
    if (existing) return existing;
    const token = `${kind}-${++this.counters[kind]}`;
    this.forward.set(key, token);
    this.back.set(token, display);
    return token;
  }

  device(d: Device): MaskedDevice {
    // Volta só como o nome: o IP, quando citado, tem o próprio token (evita "nome (IP) (IP)").
    const ref = this.token("dispositivo", d.id, displayName(d, d.ip));
    for (const name of [d.alias, d.hostname]) if (name?.trim()) this.names.set(name.trim(), ref);
    return {
      ref,
      ip: this.token("ip", d.ip),
      mac: d.mac ? this.token("mac", d.mac) : null,
      macAleatorio: isRandomizedMac(d.mac),
      fabricante: d.vendor,
      tipo: d.type,
      status: d.status,
      portasAbertas: (d.openPorts ?? "").split(",").filter(Boolean).map(Number),
      temIpv6: !!d.ipv6,
      temApelido: !!d.alias,
      dicasDoNome: nameHints(d.hostname, d.alias),
    };
  }

  /** Mascara texto livre (mensagens de eventos): nomes conhecidos, MACs, IPv6 e IPv4. */
  text(input: string): string {
    let out = input;
    // Nomes mais longos primeiro, para "TV da sala" não ser mascarado só como "TV".
    for (const name of Array.from(this.names.keys()).sort((a, b) => b.length - a.length)) {
      out = out.split(name).join(this.names.get(name)!);
    }
    out = out.replace(MAC_RE, (m) => this.token("mac", m.toUpperCase().replace(/-/g, ":")));
    out = out.replace(IPV6_CANDIDATE_RE, (m) => (net.isIPv6(m.replace(/%\w+$/, "")) ? this.token("ip", m) : m));
    out = out.replace(IPV4_RE, (m) => this.token("ip", m));
    return out;
  }

  /** Troca os tokens da resposta da IA pelos valores reais (só localmente). */
  unmask(input: string): string {
    return input.replace(TOKEN_RE, (token) => this.back.get(token) ?? token);
  }

  /** Desmascara recursivamente todas as strings de um objeto (respostas estruturadas). */
  unmaskDeep<T>(value: T): T {
    if (typeof value === "string") return this.unmask(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.unmaskDeep(v)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.unmaskDeep(v)])) as T;
    }
    return value;
  }
}
