import os from "node:os";
import type { DeviceStatus, DeviceType, LinkStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { displayName } from "@/lib/device-name";
import { readRouteTable } from "./tools/route-table";
import { snmpQuery } from "./tools/snmp";
import { mapWithConcurrency } from "./concurrency";

export type TopologyRole = "internet" | "gateway" | "infra" | "device";

export interface TopologyNode {
  id: string;
  role: TopologyRole;
  label: string;
  ip: string | null;
  mac: string | null;
  vendor: string | null;
  type: DeviceType | null;
  status: DeviceStatus | null;
  isSelf: boolean;
  /** Id do dispositivo no inventário (para linkar para a página de detalhes). */
  deviceId: string | null;
}

export interface TopologyEdge {
  from: string;
  to: string;
  /**
   * confirmed: ligação lida da tabela de MACs de um switch via SNMP (BRIDGE-MIB).
   * inferred: sem essa informação, assumimos ligação direta ao gateway.
   * manual: ligação cadastrada pelo usuário, monitorada periodicamente (tem status).
   */
  kind: "wan" | "confirmed" | "inferred" | "manual";
  label?: string;
  /** false = ligação extra (ex: segundo caminho); desenhada, mas não define a posição na árvore. */
  tree: boolean;
  linkId?: string;
  status?: LinkStatus;
  statusSince?: string | null;
  downReason?: string | null;
}

export interface SnmpProbeResult {
  ip: string;
  label: string;
  ok: boolean;
  macsLearned: number;
  error?: string;
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  gatewayIp: string | null;
  snmp: SnmpProbeResult[] | null;
}

// A tabela de rotas (PowerShell, ~1-3s) muda raramente; o mapa é recarregado com frequência.
let routesCache: { at: number; routes: Awaited<ReturnType<typeof readRouteTable>> } | null = null;
async function readRoutesCached() {
  if (!routesCache || Date.now() - routesCache.at > 60_000) {
    routesCache = { at: Date.now(), routes: await readRouteTable().catch(() => []) };
  }
  return routesCache.routes;
}

const INFRA_TYPES: DeviceType[] = ["ROUTER", "SWITCH"];
const INTERNET_ID = "internet";

// BRIDGE-MIB dot1dTpFdbPort e Q-BRIDGE-MIB dot1qTpFdbPort: MAC aprendido -> porta da bridge.
// O MAC vem codificado nos 6 últimos componentes do OID (em decimal), o valor é o número da porta.
const FDB_OIDS = ["1.3.6.1.2.1.17.4.3.1.2", "1.3.6.1.2.1.17.7.1.2.2.1.2"];

function macFromOidSuffix(oid: string): string {
  return oid
    .split(".")
    .slice(-6)
    .map((n) => Number(n).toString(16).padStart(2, "0").toUpperCase())
    .join(":");
}

function localIps(): Set<string> {
  const ips = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) ips.add(a.address);
  }
  return ips;
}

async function readSwitchFdb(ip: string, community: string): Promise<{ mac: string; port: string }[]> {
  const target = { host: ip, community, version: "2c" as const };
  for (const oid of FDB_OIDS) {
    const table = await snmpQuery(target, "walk", oid);
    if (table.rows.length) return table.rows.map(([rowOid, port]) => ({ mac: macFromOidSuffix(rowOid), port }));
  }
  return [];
}

/**
 * Monta a topologia a partir do inventário. Sem SNMP, só dá para afirmar quem é o gateway
 * (tabela de rotas) — o resto fica ligado a ele como "inferido". Com SNMP, lê a tabela de MACs
 * de cada roteador/switch e posiciona cada dispositivo na porta onde o MAC foi aprendido.
 */
export async function buildTopology(options: { snmpCommunity?: string } = {}): Promise<Topology> {
  const [devices, routes, links] = await Promise.all([
    prisma.device.findMany({ orderBy: { ip: "asc" } }),
    readRoutesCached(),
    prisma.topologyLink.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  const selfIps = localIps();

  const gatewayIp =
    routes.find((r) => r.destination === "0.0.0.0/0" && r.nextHop !== "0.0.0.0")?.nextHop ??
    devices.find((d) => d.type === "ROUTER" && d.ip.endsWith(".1"))?.ip ??
    null;
  // Um mesmo IP pode ter mais de um registro (ex: histórico antigo sem MAC); o gateway é o online mais recente.
  const gateway = devices
    .filter((d) => d.ip === gatewayIp)
    .sort((a, b) => Number(b.status === "ONLINE") - Number(a.status === "ONLINE") || +b.lastSeenAt - +a.lastSeenAt)[0];

  const nodes: TopologyNode[] = [
    { id: INTERNET_ID, role: "internet", label: "Internet", ip: null, mac: null, vendor: null, type: null, status: null, isSelf: false, deviceId: null },
  ];
  const gatewayId = gateway?.id ?? "gateway";
  if (!gateway) {
    nodes.push({ id: gatewayId, role: "gateway", label: "Gateway", ip: gatewayIp, mac: null, vendor: null, type: "ROUTER", status: null, isSelf: false, deviceId: null });
  }

  for (const d of devices) {
    const role: TopologyRole = d.id === gateway?.id ? "gateway" : INFRA_TYPES.includes(d.type) ? "infra" : "device";
    nodes.push({
      id: d.id,
      role,
      label: displayName(d, d.ip),
      ip: d.ip,
      mac: d.mac,
      vendor: d.vendor,
      type: d.type,
      status: d.status,
      isSelf: selfIps.has(d.ip) && (d.mac !== null || !devices.some((o) => o.ip === d.ip && o.mac)),
      deviceId: d.id,
    });
  }

  // Parent de cada nó (padrão: gateway, inferido). O SNMP pode sobrescrever com uma ligação confirmada.
  const parent = new Map<string, { to: string; kind: TopologyEdge["kind"]; label?: string; linkId?: string }>();
  for (const n of nodes) {
    if (n.role === "internet" || n.id === gatewayId) continue;
    parent.set(n.id, { to: gatewayId, kind: "inferred" });
  }

  let snmp: SnmpProbeResult[] | null = null;
  if (options.snmpCommunity) {
    const infra = nodes.filter((n) => (n.role === "infra" || n.role === "gateway") && n.ip);
    const fdbs = await mapWithConcurrency(infra, 4, async (sw) => {
      try {
        const entries = await readSwitchFdb(sw.ip!, options.snmpCommunity!);
        return { sw, entries, error: undefined };
      } catch (err) {
        return { sw, entries: [], error: err instanceof Error ? err.message : String(err) };
      }
    });
    snmp = fdbs.map(({ sw, entries, error }) => ({ ip: sw.ip!, label: sw.label, ok: !error, macsLearned: entries.length, error }));

    // Um MAC aparece em várias portas ao longo do caminho (as portas de uplink aprendem tudo).
    // A porta "de borda" onde o dispositivo realmente está é a que aprendeu menos MACs.
    const portSize = new Map<string, number>();
    for (const { sw, entries } of fdbs) {
      for (const e of entries) portSize.set(`${sw.id}|${e.port}`, (portSize.get(`${sw.id}|${e.port}`) ?? 0) + 1);
    }
    const best = new Map<string, { swId: string; port: string; size: number }>();
    for (const { sw, entries } of fdbs) {
      for (const e of entries) {
        const size = portSize.get(`${sw.id}|${e.port}`)!;
        const current = best.get(e.mac);
        if (!current || size < current.size) best.set(e.mac, { swId: sw.id, port: e.port, size });
      }
    }

    for (const n of nodes) {
      const hit = n.mac ? best.get(n.mac) : undefined;
      if (hit && hit.swId !== n.id) parent.set(n.id, { to: hit.swId, kind: "confirmed", label: `porta ${hit.port}` });
    }
  }

  // Ligações cadastradas pelo usuário têm prioridade sobre SNMP e inferência. A primeira ligação de
  // cada dispositivo define sua posição na árvore; as demais viram arestas extras.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const manualParent = new Set<string>();
  const oriented = links
    .filter((l) => nodeIds.has(l.fromDeviceId) && nodeIds.has(l.toDeviceId))
    // O gateway é a raiz: se ele foi cadastrado como destino, invertemos o sentido.
    .map((l) => (l.toDeviceId === gatewayId ? { ...l, fromDeviceId: l.toDeviceId, toDeviceId: l.fromDeviceId } : l));
  for (const l of oriented) {
    if (manualParent.has(l.toDeviceId)) continue;
    manualParent.add(l.toDeviceId);
    parent.set(l.toDeviceId, { to: l.fromDeviceId, kind: "manual", linkId: l.id });
  }

  // Dois switches podem se enxergar pelas portas de uplink e apontar um para o outro.
  // Qualquer ciclo é desfeito religando o nó ao gateway como inferido.
  for (const id of parent.keys()) {
    const seen = new Set<string>([id]);
    for (let cur = parent.get(id)?.to; cur && cur !== gatewayId; cur = parent.get(cur)?.to) {
      if (seen.has(cur)) {
        parent.set(id, { to: gatewayId, kind: "inferred" });
        break;
      }
      seen.add(cur);
    }
  }

  const linkById = new Map(links.map((l) => [l.id, l]));
  const manualEdge = (linkId: string, from: string, to: string, tree: boolean): TopologyEdge => {
    const l = linkById.get(linkId)!;
    return { from, to, kind: "manual", tree, linkId, label: l.label ?? undefined, status: l.status, statusSince: l.lastChangeAt?.toISOString() ?? null, downReason: l.downReason };
  };

  const edges: TopologyEdge[] = [{ from: INTERNET_ID, to: gatewayId, kind: "wan", tree: true }];
  const inTree = new Set<string>();
  for (const [id, p] of parent) {
    if (p.linkId) {
      inTree.add(p.linkId);
      edges.push(manualEdge(p.linkId, p.to, id, true));
    } else {
      edges.push({ from: p.to, to: id, kind: p.kind, label: p.label, tree: true });
    }
  }
  for (const l of oriented) if (!inTree.has(l.id)) edges.push(manualEdge(l.id, l.fromDeviceId, l.toDeviceId, false));

  return { nodes, edges, gatewayIp, snmp };
}
