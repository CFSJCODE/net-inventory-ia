/** Menor prefixo aceito no scan: /20 = 4.096 endereços, 4.094 hosts utilizáveis. */
export const MIN_SCAN_PREFIX = 20;
/** Teto de hosts por scan; /20 é o maior bloco que cabe nele. */
export const MAX_SCAN_HOSTS = 2 ** (32 - MIN_SCAN_PREFIX) - 2;

const CIDR_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export interface CidrInfo {
  /** Endereço de rede (bits de host zerados), ex: 192.168.1.0. */
  network: string;
  prefix: number;
  /** Máscara em notação decimal, ex: 255.255.255.0. */
  mask: string;
  /** Broadcast direcionado; null em /31 e /32, que não têm broadcast (RFC 3021). */
  broadcast: string | null;
  /** Endereços no bloco: 2^(32 - prefixo). */
  totalAddresses: number;
  /** Hosts escaneados: 2^(32 - prefixo) - 2 até /30; 2 em /31 (RFC 3021); 1 em /32. */
  hostCount: number;
  firstHost: string;
  lastHost: string;
  /** true quando o IP digitado não é o endereço de rede (ex: 192.168.1.10/24). */
  baseAdjusted: boolean;
}

export function intToIp(int: number): string {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join(".");
}

/**
 * Interpreta um bloco IPv4 em notação CIDR (RFC 4632) e calcula rede, máscara, broadcast
 * e a faixa de hosts. Não aplica o limite de tamanho do scan; veja `parseScanCidr`.
 */
export function parseCidr(cidr: string): CidrInfo {
  const match = cidr.trim().match(CIDR_PATTERN);
  if (!match) throw new Error(`CIDR inválido: ${cidr}. Use o formato 192.168.1.0/24`);

  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) throw new Error(`IP inválido: ${match.slice(1, 5).join(".")}`);
  const prefix = Number(match[5]);
  if (prefix > 32) throw new Error(`Prefixo inválido: /${prefix}. Use de /0 a /32.`);

  const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const totalAddresses = 2 ** (32 - prefix);
  // Calculado com aritmética comum: em JS, `x << 32` é `x << 0`, o que quebraria o /0.
  const maskInt = (2 ** 32 - totalAddresses) >>> 0;
  const networkInt = (baseInt & maskInt) >>> 0;
  const broadcastInt = (networkInt + totalAddresses - 1) >>> 0;

  let first = networkInt;
  let last = broadcastInt;
  let hostCount = totalAddresses;
  // Até /30 o primeiro endereço é a rede e o último o broadcast, nenhum é host (RFC 950/1812).
  // /31 é enlace ponto a ponto com os dois endereços utilizáveis (RFC 3021); /32 é um host único.
  if (prefix <= 30) {
    first = networkInt + 1;
    last = broadcastInt - 1;
    hostCount = totalAddresses - 2;
  }

  return {
    network: intToIp(networkInt),
    prefix,
    mask: intToIp(maskInt),
    broadcast: prefix <= 30 ? intToIp(broadcastInt) : null,
    totalAddresses,
    hostCount,
    firstHost: intToIp(first),
    lastHost: intToIp(last),
    baseAdjusted: baseInt !== networkInt,
  };
}

/** Como `parseCidr`, mas recusa blocos maiores que o scan suporta (/20, 4.094 hosts). */
export function parseScanCidr(cidr: string): CidrInfo {
  const info = parseCidr(cidr);
  if (info.prefix < MIN_SCAN_PREFIX) {
    throw new Error(
      `/${info.prefix} tem ${info.hostCount.toLocaleString("pt-BR")} hosts. Use um prefixo de /${MIN_SCAN_PREFIX} a /32 (até ${MAX_SCAN_HOSTS.toLocaleString("pt-BR")} hosts).`,
    );
  }
  return info;
}

/** Expande um CIDR (ex: "192.168.1.0/24") na lista de IPs de host que o scan sonda. */
export function listHostsInCidr(cidr: string): string[] {
  const info = parseScanCidr(cidr);
  const firstInt = info.firstHost.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const hosts: string[] = [];
  for (let i = 0; i < info.hostCount; i++) hosts.push(intToIp(firstInt + i));
  return hosts;
}
