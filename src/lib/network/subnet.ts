const MAX_HOSTS = 4096;

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`IP inválido: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(int: number): string {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255,
  ].join(".");
}

/** Expande um CIDR (ex: "192.168.1.0/24") na lista de IPs de host utilizáveis. */
export function listHostsInCidr(cidr: string): string[] {
  const match = cidr.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!match) {
    throw new Error(`CIDR inválido: ${cidr}. Use o formato 192.168.1.0/24`);
  }
  const [, base, prefixStr] = match;
  const prefix = Number(prefixStr);
  // /20 = 4094 hosts, o máximo que cabe em MAX_HOSTS; prefixos menores seriam recusados mais abaixo.
  if (prefix < 20 || prefix > 30) {
    throw new Error("Use um prefixo entre /20 e /30 (até 4.094 endereços) para manter o scan em um tamanho razoável.");
  }

  const baseInt = ipToInt(base);
  const hostBits = 32 - prefix;
  const totalAddresses = 2 ** hostBits;
  const networkInt = baseInt & (~0 << hostBits) >>> 0;

  if (totalAddresses - 2 > MAX_HOSTS) {
    throw new Error(`Faixa muito grande (${totalAddresses - 2} hosts). Limite: ${MAX_HOSTS}.`);
  }

  const hosts: string[] = [];
  for (let i = 1; i < totalAddresses - 1; i++) {
    hosts.push(intToIp(networkInt + i));
  }
  return hosts;
}
