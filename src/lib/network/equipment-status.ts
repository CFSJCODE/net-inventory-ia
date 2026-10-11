import { snmpQuery, type SnmpVersion } from "./tools/snmp";
import { shortPortName } from "./switch-fdb";

// HH3C-ENTITY-EXT-MIB — OIDs testados na HP V1910-24G (Comware 5)
const OID_CPU       = "1.3.6.1.4.1.25506.2.6.1.1.1.1.6.8";
const OID_MEM       = "1.3.6.1.4.1.25506.2.6.1.1.1.1.8.8";
const OID_TEMP      = "1.3.6.1.4.1.25506.2.6.1.1.1.1.12.8";
const OID_TEMP_TH   = "1.3.6.1.4.1.25506.2.6.1.1.1.1.13.8";

// HH3C Device Fan/PSU MIB
const OID_FAN_ROOT  = "1.3.6.1.4.1.25506.8.35.9.1.1.1";
const OID_PSU_ROOT  = "1.3.6.1.4.1.25506.8.35.9.1.2.1";

// RFC standard MIBs
const OID_UPTIME    = "1.3.6.1.2.1.1.3.0";
const OID_SYSNAME   = "1.3.6.1.2.1.1.5.0";
const OID_IF_NAME   = "1.3.6.1.2.1.31.1.1.1.1";
const OID_IF_STAT   = "1.3.6.1.2.1.2.2.1.8";
const OID_IF_SPEED  = "1.3.6.1.2.1.31.1.1.1.15";
const OID_IF_ALIAS  = "1.3.6.1.2.1.31.1.1.1.18";
const OID_LLDP_NAME = "1.0.8802.1.1.2.1.4.1.1.9";

// hh3cEntityExtStateTable: 1=notSupported, 2=normal, 3=prefailure, 4=failure, 5=powerOff, 6=present, 7=absent
const ENTITY_STATE: Record<string, string> = {
  "1": "—", "2": "Normal", "3": "Pré-falha", "4": "Falha", "5": "Desligado", "6": "Presente", "7": "Ausente",
};

const IF_OPSTATUS: Record<string, string> = {
  "1": "up", "2": "down", "3": "testing", "5": "dormant", "7": "lowerLayerDown",
};

// Portas físicas: GE, XGE, FE, Eth — exclui Vlan-interface, NULL, InLoopBack, MGE, M-GE
const RE_PHYSICAL = /^(GigabitEthernet|Ten-?GigabitEthernet|FastEthernet|Ethernet)\d/i;

export interface FanStatus { id: string; status: string; ok: boolean }
export interface PsuStatus { id: string; status: string; ok: boolean }
export interface PortStatus {
  name: string;
  shortName: string;
  operStatus: string;
  speedMbps: number | null;
  description: string;
  neighbor: string | null;
}
export interface EquipmentStatus {
  sysName: string;
  uptime: string;
  cpuPct: number | null;
  memPct: number | null;
  tempC: number | null;
  tempThresholdC: number | null;
  fans: FanStatus[];
  psus: PsuStatus[];
  ports: PortStatus[];
  readAt: string;
}

function scalarVal(rows: string[][]): string | null {
  const v = rows[0]?.[1];
  return v && !["noSuchName", "noSuchObject", "noSuchInstance"].includes(v) ? v : null;
}

function walkToMap(rows: string[][], root: string): Map<string, string> {
  const map = new Map<string, string>();
  const prefix = root.replace(/^\./, "") + ".";
  for (const [oid, val] of rows) {
    const suffix = oid.startsWith(prefix) ? oid.slice(prefix.length) : oid;
    map.set(suffix, val);
  }
  return map;
}

export async function readEquipmentStatus(ip: string, community: string): Promise<EquipmentStatus> {
  const target = { host: ip, community, version: "2c" as SnmpVersion };
  const g = (oid: string) => snmpQuery(target, "get", oid).catch(() => ({ columns: [] as string[], rows: [] as string[][] }));
  const w = (oid: string) => snmpQuery(target, "walk", oid).catch(() => ({ columns: [] as string[], rows: [] as string[][] }));

  const [
    cpuR, memR, tempR, tempThR, uptimeR, nameR,
    fanR, psuR,
    ifNameR, ifStatR, ifSpeedR, ifAliasR, lldpR,
  ] = await Promise.all([
    g(OID_CPU), g(OID_MEM), g(OID_TEMP), g(OID_TEMP_TH), g(OID_UPTIME), g(OID_SYSNAME),
    w(OID_FAN_ROOT), w(OID_PSU_ROOT),
    w(OID_IF_NAME), w(OID_IF_STAT), w(OID_IF_SPEED), w(OID_IF_ALIAS), w(OID_LLDP_NAME),
  ]);

  // Fans
  const fans: FanStatus[] = Array.from(walkToMap(fanR.rows, OID_FAN_ROOT)).map(([id, v]) => ({
    id, status: ENTITY_STATE[v] ?? v, ok: v === "2",
  }));

  // PSUs
  const psus: PsuStatus[] = Array.from(walkToMap(psuR.rows, OID_PSU_ROOT)).map(([id, v]) => ({
    id, status: ENTITY_STATE[v] ?? v, ok: v === "2",
  }));

  // Mapa LLDP: localPortNum -> nome do vizinho (sufixo = timemark.portNum.remIdx)
  const lldpByPort = new Map<string, string>();
  for (const [oid, val] of lldpR.rows) {
    if (!val) continue;
    const suffix = oid.startsWith(OID_LLDP_NAME.replace(/^\./, "") + ".") ? oid.slice(OID_LLDP_NAME.length + 1) : oid;
    const parts = suffix.split(".");
    if (parts.length >= 3 && !lldpByPort.has(parts[1])) lldpByPort.set(parts[1], val);
  }

  // Tabela de interfaces — ordenada por índice numérico, apenas portas físicas
  const nameMap  = walkToMap(ifNameR.rows, OID_IF_NAME);
  const statMap  = walkToMap(ifStatR.rows, OID_IF_STAT);
  const speedMap = walkToMap(ifSpeedR.rows, OID_IF_SPEED);
  const aliasMap = walkToMap(ifAliasR.rows, OID_IF_ALIAS);

  const ports: PortStatus[] = Array.from(nameMap.entries())
    .filter(([, name]) => RE_PHYSICAL.test(name))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([idx, name]) => {
      const stat = statMap.get(idx) ?? "";
      const spd = speedMap.get(idx);
      return {
        name,
        shortName: shortPortName(name),
        operStatus: IF_OPSTATUS[stat] ?? stat,
        speedMbps: spd ? Number(spd) || null : null,
        description: aliasMap.get(idx) ?? "",
        neighbor: lldpByPort.get(idx) ?? null,
      };
    });

  const cpu = scalarVal(cpuR.rows);
  const mem = scalarVal(memR.rows);
  const tmp = scalarVal(tempR.rows);
  const tth = scalarVal(tempThR.rows);

  return {
    sysName: scalarVal(nameR.rows) ?? "—",
    uptime: scalarVal(uptimeR.rows) ?? "—",
    cpuPct: cpu !== null ? Number(cpu) : null,
    memPct: mem !== null ? Number(mem) : null,
    tempC: tmp !== null ? Number(tmp) : null,
    tempThresholdC: tth !== null ? Number(tth) : null,
    fans,
    psus,
    ports,
    readAt: new Date().toISOString(),
  };
}
