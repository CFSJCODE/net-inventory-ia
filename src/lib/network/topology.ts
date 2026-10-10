import os from "node:os";
import type { DeviceStatus, DeviceType, LinkStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { displayName } from "@/lib/device-name";
import { readRouteTable } from "./tools/route-table";
import { mapWithConcurrency } from "./concurrency";
import { decrypt, encrypt } from "@/lib/ai/settings";
import { placeByFdb, readSwitchFdb, type FdbEntry, type Placement } from "./switch-fdb";

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
   * uplink: "conectado a" informado pelo usuário na página do dispositivo (sem monitoramento).
   * manual: ligação cadastrada pelo usuário, monitorada periodicamente (tem status).
   */
  kind: "wan" | "confirmed" | "inferred" | "uplink" | "manual";
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
  /** true enquanto a primeira leitura SNMP roda em segundo plano: o cliente deve recarregar em seguida. */
  snmpPending: boolean;
  /** Community usada na descoberta automática (só enviada a quem pode operar a rede). */
  snmpCommunity?: string;
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

const SETTING_COMMUNITY = "topology.snmpCommunity";
const SETTING_MEMORY = "topology.fdbMemory";
const DEFAULT_COMMUNITY = "public";
const FDB_TTL_MS = 5 * 60_000;
const MEMORY_MAX_AGE_MS = 30 * 86_400_000;

/** Community usada na descoberta automática: a última informada no mapa, ou "public". */
export async function storedCommunity(): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTING_COMMUNITY } }).catch(() => null);
  // A community é uma credencial: fica criptografada como as demais (null se o AUTH_SECRET mudou).
  return (row && decrypt(row.value)) || DEFAULT_COMMUNITY;
}

async function saveCommunity(plain: string) {
  const value = encrypt(plain);
  await prisma.appSetting.upsert({ where: { key: SETTING_COMMUNITY }, create: { key: SETTING_COMMUNITY, value }, update: { value } });
}

interface FdbSnapshot {
  community: string;
  at: number;
  results: { swId: string; ip: string; label: string; entries: FdbEntry[]; error?: string }[];
}

let fdbSnapshot: FdbSnapshot | null = null;
let fdbRefresh: { community: string; promise: Promise<FdbSnapshot> } | null = null;

function refreshFdb(infra: TopologyNode[], community: string): Promise<FdbSnapshot> {
  if (fdbRefresh?.community === community) return fdbRefresh.promise;
  const promise = mapWithConcurrency(infra, 4, async (sw) => {
    try {
      return { swId: sw.id, ip: sw.ip!, label: sw.label, entries: await readSwitchFdb(sw.ip!, community) };
    } catch (err) {
      return { swId: sw.id, ip: sw.ip!, label: sw.label, entries: [], error: err instanceof Error ? err.message : String(err) };
    }
  }).then((results) => {
    const snap = { community, at: Date.now(), results };
    fdbSnapshot = snap;
    return snap;
  });
  const current = { community, promise };
  fdbRefresh = current;
  promise.finally(() => {
    if (fdbRefresh === current) fdbRefresh = null;
  }).catch(() => {});
  return promise;
}

type Memory = Map<string, Placement & { at: number }>;
let memoryCache: Memory | null = null;
let memorizedAt = 0;

/** Junta as posições lidas agora com as guardadas (MAC -> equipamento/porta) e grava quando há leitura nova. */
async function rememberPlacements(current: Map<string, Placement>, readAt: number): Promise<Memory> {
  if (!memoryCache) {
    memoryCache = new Map();
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_MEMORY } }).catch(() => null);
    try {
      for (const [mac, v] of Object.entries(JSON.parse(row?.value ?? "{}") as Record<string, Placement & { at: number }>)) {
        memoryCache.set(mac, v);
      }
    } catch {
      // valor corrompido: recomeça do zero
    }
  }
  // readAt > 0 só quando a leitura teve ao menos um equipamento respondendo: aí também expira o que é velho,
  // mesmo que nenhuma posição nova tenha sido encontrada.
  if (readAt > memorizedAt) {
    memorizedAt = readAt;
    for (const [mac, p] of current) memoryCache.set(mac, { ...p, at: readAt });
    for (const [mac, v] of memoryCache) if (readAt - v.at > MEMORY_MAX_AGE_MS) memoryCache.delete(mac);
    const value = JSON.stringify(Object.fromEntries(memoryCache));
    await prisma.appSetting
      .upsert({ where: { key: SETTING_MEMORY }, create: { key: SETTING_MEMORY, value }, update: { value } })
      .catch(() => {});
  }
  return memoryCache;
}

function localIps(): Set<string> {
  const ips = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) ips.add(a.address);
  }
  return ips;
}

/**
 * Retorna todos os MACs (normalizados para XX:XX:XX:XX:XX:XX em maiúsculas) das
 * interfaces físicas desta máquina, excluindo o endereço nulo 00:00:00:00:00:00.
 */
function localMacs(): Set<string> {
  const macs = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.mac && a.mac !== "00:00:00:00:00:00") {
        macs.add(a.mac.toUpperCase().replace(/-/g, ":"));
      }
    }
  }
  return macs;
}

/**
 * Determina se um dispositivo do inventário é esta máquina (o host que executa o serviço).
 *
 * Estratégia em dois estágios, do mais confiável para o menos:
 *  1. MAC (preferencial): se o dispositivo tem MAC registrado, ele deve coincidir com
 *     alguma interface local. Endereços IP não são suficientes porque esta máquina pode
 *     ter múltiplas placas de rede (ex: Ethernet em .92 e Wi-Fi em .250) e o scanner
 *     armazenaria o IP do outro notebook no mesmo endereço.
 *  2. IP (fallback): sem MAC no banco, volta para a comparação por IP — mas apenas se
 *     não existe outro registro com o mesmo IP que já tenha MAC (esse outro registro
 *     seria o verdadeiro dono do endereço).
 */
function isSelfDevice(
  d: { ip: string; mac: string | null },
  selfIps: Set<string>,
  selfMacs: Set<string>,
  devices: { ip: string; mac: string | null }[],
): boolean {
  if (d.mac !== null) {
    // Comparação por MAC: único por hardware — sem ambiguidade mesmo com múltiplas NICs.
    return selfMacs.has(d.mac.toUpperCase().replace(/-/g, ":"));
  }
  // Fallback por IP: só marca se nenhum outro dispositivo com mesmo IP tem MAC cadastrado
  // (caso contrário, aquele com MAC seria o dono real do IP).
  return selfIps.has(d.ip) && !devices.some((o) => o.ip === d.ip && o.mac !== null);
}

/**
 * Monta a topologia a partir do inventário. Sem SNMP, só dá para afirmar quem é o gateway
 * (tabela de rotas) — o resto fica ligado a ele como "inferido". Com SNMP, lê a tabela de MACs
 * de cada roteador/switch e posiciona cada dispositivo na porta onde o MAC foi aprendido.
 */
export async function buildTopology(options: { snmpCommunity?: string; allowProbe?: boolean } = {}): Promise<Topology> {
  const [devices, routes, links] = await Promise.all([
    prisma.device.findMany({ orderBy: { ip: "asc" } }),
    readRoutesCached(),
    prisma.topologyLink.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  const selfIps = localIps();
  const selfMacs = localMacs();

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
      isSelf: isSelfDevice(d, selfIps, selfMacs, devices),
      deviceId: d.id,
    });
  }

  // Parent de cada nó (padrão: gateway, inferido). O SNMP pode sobrescrever com uma ligação confirmada.
  const parent = new Map<string, { to: string; kind: TopologyEdge["kind"]; label?: string; linkId?: string }>();
  for (const n of nodes) {
    if (n.role === "internet" || n.id === gatewayId) continue;
    parent.set(n.id, { to: gatewayId, kind: "inferred" });
  }

  // SNMP automático: a tabela de MACs dos switches é lida em segundo plano e guardada por alguns minutos,
  // para o mapa não esperar equipamentos que não respondem. O botão "Descobrir" força uma leitura na hora.
  const community = options.snmpCommunity ?? (await storedCommunity());
  if (options.snmpCommunity) await saveCommunity(options.snmpCommunity);
  const infra = nodes.filter((n) => (n.role === "infra" || n.role === "gateway") && n.ip);
  let snapshot = fdbSnapshot?.community === community ? fdbSnapshot : null;
  let snmpPending = false;
  // Só quem pode operar a rede dispara leituras; os demais veem a última leitura guardada.
  if (options.snmpCommunity) {
    snapshot = await refreshFdb(infra, community);
  } else if (options.allowProbe && (!snapshot || Date.now() - snapshot.at > FDB_TTL_MS)) {
    refreshFdb(infra, community).catch(() => {});
    snmpPending = true;
  }
  const snmp: SnmpProbeResult[] | null =
    snapshot?.results.map((r) => ({ ip: r.ip, label: r.label, ok: !r.error, macsLearned: r.entries.length, error: r.error })) ?? null;

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const infraByMac = new Map(infra.filter((n) => n.mac).map((n) => [n.mac!, n.id]));
  const placements = snapshot
    ? placeByFdb(
        snapshot.results.filter((r) => !r.error).map((r) => ({ swId: r.swId, entries: r.entries })),
        infraByMac,
        gateway?.mac ?? null,
      )
    : new Map<string, Placement>();
  // Dispositivos parados (impressora em repouso, offline) somem da tabela do switch em poucos minutos;
  // a última porta onde foram vistos fica guardada para o mapa não devolvê-los ao gateway.
  const memory = await rememberPlacements(placements, snapshot?.results.some((r) => !r.error) ? snapshot.at : 0);

  for (const n of nodes) {
    if (!n.mac || !parent.has(n.id)) continue;
    const hit = placements.get(n.mac) ?? memory.get(n.mac);
    if (hit && hit.parentId !== n.id && nodeById.has(hit.parentId)) {
      parent.set(n.id, { to: hit.parentId, kind: "confirmed", label: hit.label });
    }
  }

  // "Conectado a" definido pelo usuário na página do dispositivo: vale mais que o SNMP.
  for (const d of devices) {
    if (d.uplinkId && d.uplinkId !== d.id && parent.has(d.id) && nodeById.has(d.uplinkId)) {
      parent.set(d.id, { to: d.uplinkId, kind: "uplink" });
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

  return { nodes, edges, gatewayIp, snmp, snmpPending, snmpCommunity: community };
}
