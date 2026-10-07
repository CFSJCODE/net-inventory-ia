"use server";

import { requirePermission, requireSession } from "@/lib/auth/server";
import net from "node:net";
import { prisma } from "@/lib/prisma";
import { arpScan, type ArpScanHost } from "@/lib/network/tools/arp-scan";
import { PORT_PRESETS, portScan, type PortScanResult } from "@/lib/network/tools/port-scan";
import { snmpQuery, SNMP_MODES, type SnmpMode, type SnmpTable, type SnmpVersion } from "@/lib/network/tools/snmp";
import { wakeOnLan, type WakeOnLanResult } from "@/lib/network/tools/wake-on-lan";
import { readDhcpLeases, type DhcpLease } from "@/lib/network/tools/dhcp";
import { DNS_RECORD_TYPES, dnsQuery, type DnsQueryResult, type DnsRecordType } from "@/lib/network/tools/dns-query";
import { isUnicastMac, readArpTable, type ArpEntry } from "@/lib/network/tools/arp-table";
import { readRouteTable, type RouteEntry } from "@/lib/network/tools/route-table";
import { resolveVendors } from "@/lib/network/vendor-lookup";
import { parseCidr } from "@/lib/network/subnet";
import { displayName } from "@/lib/device-name";

/**
 * Em produção o Next esconde a mensagem de erros lançados em server actions, então as
 * ferramentas devolvem o erro como dado para a interface conseguir mostrá-lo.
 */
export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/;

function assertHost(host: string): string {
  const value = host.trim();
  if (!net.isIP(value) && !HOSTNAME_RE.test(value)) throw new Error(`Host inválido: "${host}"`);
  return value;
}

async function currentCidr(): Promise<string> {
  const config = await prisma.scanConfig.findFirst();
  return config?.cidr ?? "192.168.1.0/24";
}

/** Endereço de broadcast de um CIDR (ex: 192.168.15.0/24 -> 192.168.15.255); vazio em /31 e /32. */
function broadcastOf(cidr: string): string {
  try {
    return parseCidr(cidr).broadcast ?? "";
  } catch {
    return "";
  }
}

export async function getToolDefaults(): Promise<{ cidr: string; broadcast: string; gateway: string }> {
  await requireSession();
  const cidr = await currentCidr();
  const routes = await readRouteTable().catch(() => []);
  const gateway = routes.find((r) => r.destination === "0.0.0.0/0" && r.nextHop !== "0.0.0.0")?.nextHop ?? "";
  return { cidr, broadcast: broadcastOf(cidr), gateway };
}

export async function runArpScan(cidr: string): Promise<ToolResult<ArpScanHost[]>> {
  await requirePermission("network.operate");
  return run(() => arpScan(cidr.trim()));
}

export async function runPortScan(host: string, ports: string, timeoutMs: number): Promise<ToolResult<PortScanResult>> {
  await requirePermission("network.operate");
  return run(() => {
    const spec = PORT_PRESETS[ports as keyof typeof PORT_PRESETS] ?? ports;
    return portScan(assertHost(host), spec, Math.min(Math.max(timeoutMs || 500, 100), 5000));
  });
}

export async function runSnmpQuery(input: {
  host: string;
  community: string;
  version: SnmpVersion;
  mode: SnmpMode;
  oid?: string;
}): Promise<ToolResult<SnmpTable>> {
  await requirePermission("network.operate");
  return run(() => {
    if (!SNMP_MODES.includes(input.mode)) throw new Error("Tipo de consulta SNMP inválido.");
    if (input.version !== "1" && input.version !== "2c") throw new Error("Versão SNMP inválida.");
    return snmpQuery(
      { host: assertHost(input.host), community: input.community || "public", version: input.version },
      input.mode,
      input.oid?.trim() || undefined,
    );
  });
}

export async function runWakeOnLan(mac: string, broadcast: string): Promise<ToolResult<WakeOnLanResult>> {
  await requirePermission("network.operate");
  return run(() => {
    if (!net.isIPv4(broadcast.trim())) throw new Error("Endereço de broadcast inválido.");
    return wakeOnLan(mac, broadcast.trim());
  });
}

export async function runDhcpQuery(): Promise<ToolResult<DhcpLease[]>> {
  await requirePermission("network.operate");
  return run(readDhcpLeases);
}

export async function runDnsQuery(name: string, type: DnsRecordType, server: string): Promise<ToolResult<DnsQueryResult>> {
  await requirePermission("network.operate");
  return run(() => {
    if (!DNS_RECORD_TYPES.includes(type)) throw new Error("Tipo de registro inválido.");
    return dnsQuery(assertHost(name), type, server.trim() || undefined);
  });
}

export interface ArpTableRow extends ArpEntry {
  vendor: string | null;
  deviceName: string | null;
  deviceId: string | null;
}

/** Tabela ARP do sistema, enriquecida com fabricante e com o dispositivo correspondente do inventário. */
export async function runArpTableQuery(): Promise<ToolResult<ArpTableRow[]>> {
  await requirePermission("network.operate");
  return run(async () => {
    const entries = await readArpTable();
    const macs = Array.from(new Set(entries.flatMap((e) => (e.mac && isUnicastMac(e.mac) ? [e.mac] : []))));
    const [vendors, devices] = await Promise.all([
      resolveVendors(macs),
      prisma.device.findMany({ where: { mac: { in: macs } }, select: { id: true, mac: true, hostname: true, alias: true } }),
    ]);
    const deviceByMac = new Map(devices.map((d) => [d.mac, d]));

    return entries.map((e) => {
      const device = e.mac ? deviceByMac.get(e.mac) : undefined;
      return {
        ...e,
        vendor: e.mac ? vendors.get(e.mac) ?? null : null,
        deviceName: device ? displayName(device, null) : null,
        deviceId: device?.id ?? null,
      };
    });
  });
}

export async function runRouteTableQuery(): Promise<ToolResult<RouteEntry[]>> {
  await requirePermission("network.operate");
  return run(readRouteTable);
}
