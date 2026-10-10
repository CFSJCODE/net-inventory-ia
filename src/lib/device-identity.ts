/**
 * Identidade de dispositivo: o MAC é a chave. O mesmo MAC nunca vira dois registros no inventário;
 * quando aparece de novo (outro IP, ou depois de ter sido visto sem MAC), o registro mais antigo é
 * mantido e só recebe o IP e a hora em que foi visto, preservando nome, tipo e anotações do usuário.
 *
 * Aqui ficam as regras puras (testáveis sem banco); a fusão no banco está em device-merge.ts.
 */

/** Formato canônico usado no banco: maiúsculas separadas por ":" (igual ao que a leitura do ARP grava). */
export function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 12) return mac.trim().toUpperCase() || null;
  return hex.match(/../g)!.join(":");
}

/**
 * Dois registros só podem ser o mesmo aparelho se os hostnames não se contradizem (um deles vazio,
 * ou iguais). Protege a associação por IP, que é mais fraca que a por MAC: o DHCP pode ter
 * entregado o mesmo IP a outro aparelho.
 */
export function hostnamesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function ipToNumber(ip: string): number {
  return ip.split(".").reduce((acc, part) => acc * 256 + (Number(part) || 0), 0);
}

/**
 * Um scan pode achar o mesmo MAC em vários IPs (máquina com dois IPs na mesma placa, repetidor Wi-Fi
 * que responde ARP pelos clientes). Fica um host por MAC: o que está no IP já conhecido do registro,
 * senão o de menor IP. Sem isso o IP do registro alternaria a cada scan, gerando eventos falsos.
 */
export function dedupeHostsByMac<T extends { ip: string; mac: string | null }>(
  hosts: T[],
  knownIpByMac: Map<string, string>,
): T[] {
  const byMac = new Map<string, T[]>();
  for (const host of hosts) {
    if (!host.mac) continue;
    byMac.set(host.mac, [...(byMac.get(host.mac) ?? []), host]);
  }

  const chosen = new Set<T>();
  for (const [mac, group] of byMac) {
    const known = knownIpByMac.get(mac);
    const pick =
      group.find((h) => h.ip === known) ?? [...group].sort((a, b) => ipToNumber(a.ip) - ipToNumber(b.ip))[0];
    chosen.add(pick);
  }

  return hosts.filter((h) => !h.mac || chosen.has(h));
}

export interface DeviceIdentityRow {
  id: string;
  ip: string;
  mac: string | null;
  hostname: string | null;
  firstSeenAt: Date;
}

export interface MergePlan {
  /** Registro mais antigo, que fica. */
  keepId: string;
  /** Registros que são fundidos nele e apagados. */
  mergeIds: string[];
  /** MAC canônico do grupo (o registro mantido passa a tê-lo). */
  mac: string | null;
}

function byAge(a: DeviceIdentityRow, b: DeviceIdentityRow): number {
  return a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || a.id.localeCompare(b.id);
}

/**
 * Encontra duplicados já gravados:
 * - registros com o mesmo MAC (diferindo só na grafia, ex: minúsculas ou "-");
 * - registros sem MAC no mesmo IP de um único registro com MAC (o aparelho foi visto antes do ARP
 *   responder), desde que os hostnames não se contradigam;
 * - registros sem MAC no mesmo IP entre si, com hostnames compatíveis.
 * Em cada grupo fica o mais antigo (firstSeenAt).
 */
export function planDuplicateMerges(rows: DeviceIdentityRow[]): MergePlan[] {
  const groups: DeviceIdentityRow[][] = [];

  const byMac = new Map<string, DeviceIdentityRow[]>();
  const withoutMac: DeviceIdentityRow[] = [];
  for (const row of rows) {
    const mac = normalizeMac(row.mac);
    if (mac) byMac.set(mac, [...(byMac.get(mac) ?? []), row]);
    else withoutMac.push(row);
  }

  const macGroups = new Map<string, DeviceIdentityRow[]>();
  for (const [mac, group] of byMac) {
    const copy = [...group];
    macGroups.set(mac, copy);
    groups.push(copy);
  }

  const macGroupsByIp = new Map<string, DeviceIdentityRow[][]>();
  for (const group of macGroups.values()) {
    for (const ip of new Set(group.map((r) => r.ip))) {
      macGroupsByIp.set(ip, [...(macGroupsByIp.get(ip) ?? []), group]);
    }
  }

  const orphanGroupsByIp = new Map<string, DeviceIdentityRow[][]>();
  for (const row of [...withoutMac].sort(byAge)) {
    const macCandidates = macGroupsByIp.get(row.ip) ?? [];
    // Mais de um aparelho com MAC já passou por esse IP: não dá para saber qual era.
    if (macCandidates.length === 1 && macCandidates[0].every((r) => hostnamesCompatible(r.hostname, row.hostname))) {
      macCandidates[0].push(row);
      continue;
    }
    if (macCandidates.length > 0) continue;

    const orphanGroups = orphanGroupsByIp.get(row.ip) ?? [];
    const target = orphanGroups.find((g) => g.every((r) => hostnamesCompatible(r.hostname, row.hostname)));
    if (target) {
      target.push(row);
    } else {
      const group = [row];
      orphanGroups.push(group);
      orphanGroupsByIp.set(row.ip, orphanGroups);
      groups.push(group);
    }
  }

  const plans: MergePlan[] = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort(byAge);
    plans.push({
      keepId: keep.id,
      mergeIds: rest.map((r) => r.id),
      mac: group.map((r) => normalizeMac(r.mac)).find((m): m is string => !!m) ?? null,
    });
  }
  return plans;
}
