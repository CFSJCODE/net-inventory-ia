import { snmpQuery } from "./tools/snmp";

/**
 * Leitura da tabela de encaminhamento (MAC -> porta) de switches/roteadores via SNMP e a decisão de
 * em qual equipamento cada dispositivo está pendurado. A parte de decisão é pura (sem rede) para ser testável.
 */

export interface FdbEntry {
  mac: string;
  /** Número da porta da bridge. */
  port: string;
  /** Nome da interface (ex: "GigabitEthernet1/0/5"), quando o equipamento informa. */
  portName?: string;
}

export interface SwitchFdb {
  /** Id do nó do equipamento no mapa. */
  swId: string;
  entries: FdbEntry[];
}

export interface Placement {
  parentId: string;
  label?: string;
}

// BRIDGE-MIB dot1dTpFdbPort e Q-BRIDGE-MIB dot1qTpFdbPort: MAC aprendido -> porta da bridge.
// O MAC vem codificado nos 6 últimos componentes do OID (em decimal), o valor é o número da porta.
// Switches com VLAN (ex: HP/Comware) costumam expor só a Q-BRIDGE.
const FDB_OIDS = ["1.3.6.1.2.1.17.4.3.1.2", "1.3.6.1.2.1.17.7.1.2.2.1.2"];
const BASE_PORT_IFINDEX = "1.3.6.1.2.1.17.1.4.1.2";
const IF_NAME = "1.3.6.1.2.1.31.1.1.1.1";
const IF_DESCR = "1.3.6.1.2.1.2.2.1.2";

export function macFromOidSuffix(oid: string): string {
  return oid
    .split(".")
    .slice(-6)
    .map((n) => Number(n).toString(16).padStart(2, "0").toUpperCase())
    .join(":");
}

/** "GigabitEthernet1/0/5" -> "GE1/0/5": o nome completo ocupa espaço demais na linha do mapa. */
export function shortPortName(name: string): string {
  return name
    .replace(/^GigabitEthernet/i, "GE")
    .replace(/^Ten-?GigabitEthernet/i, "XGE")
    .replace(/^FastEthernet/i, "FE")
    .replace(/^Ethernet/i, "Eth");
}

const indexOf = (oid: string, root: string) => oid.slice(root.length + 1);

/** Nomes das portas da bridge (porta -> nome da interface). Opcional: sem isso, mostramos o número. */
async function readPortNames(target: { host: string; community: string; version: "2c" }): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const base = await snmpQuery(target, "walk", BASE_PORT_IFINDEX);
    if (!base.rows.length) return names;
    let ifNames = await snmpQuery(target, "walk", IF_NAME);
    let root = IF_NAME;
    if (!ifNames.rows.length) {
      ifNames = await snmpQuery(target, "walk", IF_DESCR);
      root = IF_DESCR;
    }
    const byIfIndex = new Map(ifNames.rows.map(([oid, name]) => [indexOf(oid, root), name]));
    for (const [oid, ifIndex] of base.rows) {
      const name = byIfIndex.get(ifIndex);
      if (name) names.set(indexOf(oid, BASE_PORT_IFINDEX), shortPortName(name));
    }
  } catch {
    // nomes são só um detalhe de exibição
  }
  return names;
}

export async function readSwitchFdb(ip: string, community: string): Promise<FdbEntry[]> {
  const target = { host: ip, community, version: "2c" as const };
  for (const oid of FDB_OIDS) {
    const table = await snmpQuery(target, "walk", oid);
    // Porta 0 = o próprio MAC do equipamento (ou entrada sem porta), não um dispositivo pendurado.
    const rows = table.rows.filter(([, port]) => port && port !== "0");
    if (!rows.length) continue;
    const names = await readPortNames(target);
    const seen = new Set<string>();
    const entries: FdbEntry[] = [];
    for (const [rowOid, port] of rows) {
      const mac = macFromOidSuffix(rowOid);
      // Na Q-BRIDGE o mesmo MAC pode aparecer em mais de uma VLAN.
      if (seen.has(`${mac}|${port}`)) continue;
      seen.add(`${mac}|${port}`);
      entries.push({ mac, port, portName: names.get(port) });
    }
    return entries;
  }
  return [];
}

export function portLabel(e: Pick<FdbEntry, "port" | "portName">): string {
  return e.portName ? `porta ${e.portName}` : `porta ${e.port}`;
}

/**
 * Decide onde cada MAC está pendurado a partir das tabelas de MAC dos switches.
 *
 * - Um MAC aparece em várias portas ao longo do caminho (as portas de uplink aprendem tudo); a porta
 *   "de borda" onde o dispositivo realmente está é a que aprendeu menos MACs.
 * - A porta de um switch por onde ele enxerga o gateway é o uplink: quem só aparece ali está do lado
 *   do gateway (ex: Wi-Fi do modem), não pendurado no switch.
 * - Se a porta de borda também aprendeu o MAC de outro equipamento de rede (ex: um roteador/AP ligado
 *   naquela porta), o dispositivo está atrás desse equipamento.
 */
export function placeByFdb(
  fdbs: SwitchFdb[],
  infraByMac: Map<string, string>,
  gatewayMac: string | null,
): Map<string, Placement> {
  const portKey = (swId: string, port: string) => `${swId}|${port}`;
  const portMacs = new Map<string, string[]>();
  const uplinks = new Set<string>();
  for (const { swId, entries } of fdbs) {
    for (const e of entries) {
      const key = portKey(swId, e.port);
      portMacs.set(key, [...(portMacs.get(key) ?? []), e.mac]);
      if (gatewayMac && e.mac === gatewayMac) uplinks.add(key);
    }
  }

  const best = new Map<string, { swId: string; entry: FdbEntry; size: number }>();
  for (const { swId, entries } of fdbs) {
    for (const e of entries) {
      const key = portKey(swId, e.port);
      if (uplinks.has(key)) continue;
      const size = portMacs.get(key)!.length;
      const current = best.get(e.mac);
      if (!current || size < current.size) best.set(e.mac, { swId, entry: e, size });
    }
  }

  const placements = new Map<string, Placement>();
  for (const [mac, { swId, entry }] of best) {
    const self = infraByMac.get(mac);
    if (self === swId) continue;
    // Equipamento de rede atrás da mesma porta (e que não é o próprio dispositivo nem o switch consultado).
    const behind = portMacs
      .get(portKey(swId, entry.port))!
      .map((m) => infraByMac.get(m))
      .filter((id): id is string => !!id && id !== swId && id !== self);
    const via = [...new Set(behind)];
    if (!self && via.length === 1) placements.set(mac, { parentId: via[0] });
    else placements.set(mac, { parentId: swId, label: portLabel(entry) });
  }
  return placements;
}
