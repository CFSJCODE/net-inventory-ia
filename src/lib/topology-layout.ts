import type { Topology, TopologyNode } from "@/lib/network/topology";

export interface PositionedNode extends TopologyNode {
  x: number;
  y: number;
}

export interface TopologyLayout {
  nodes: PositionedNode[];
  width: number;
  height: number;
}

const MIN_ARC_PER_LEAF = 88; // espaço horizontal mínimo (px) por nó folha no anel
const MIN_FIRST_RING = 190;
const RING_GAP = 170;
const INTERNET_OFFSET = 110;
/** Fatia livre no topo do círculo, por onde passa a ligação gateway -> Internet. */
const TOP_GAP = Math.PI / 5;
const PADDING = 90;

const ROLE_ORDER = { gateway: 0, infra: 1, device: 2, internet: 3 } as const;

function compareNodes(a: TopologyNode, b: TopologyNode): number {
  return (
    ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
    (a.type ?? "").localeCompare(b.type ?? "") ||
    a.label.localeCompare(b.label, "pt-BR", { numeric: true })
  );
}

/**
 * Layout em árvore radial com o gateway no centro: cada subárvore recebe uma fatia do círculo
 * proporcional ao seu número de folhas, e cada nível de profundidade é um anel mais externo.
 * Filhos são ordenados por papel e tipo para que dispositivos parecidos fiquem agrupados.
 */
export function layoutTopology(topology: Topology, visibleIds: Set<string>): TopologyLayout {
  const byId = new Map(topology.nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  let rootId: string | null = null;

  for (const e of topology.edges) {
    if (!e.tree || !visibleIds.has(e.from) || !visibleIds.has(e.to)) continue;
    if (e.kind === "wan") {
      rootId = e.to;
      continue;
    }
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
  }
  if (!rootId) return { nodes: [], width: 0, height: 0 };

  for (const list of children.values()) list.sort((a, b) => compareNodes(byId.get(a)!, byId.get(b)!));

  const leaves = new Map<string, number>();
  const countLeaves = (id: string): number => {
    const kids = children.get(id) ?? [];
    const total = kids.length ? kids.reduce((sum, k) => sum + countLeaves(k), 0) : 1;
    leaves.set(id, total);
    return total;
  };
  const totalLeaves = countLeaves(rootId);

  const span = 2 * Math.PI - TOP_GAP;
  const firstRing = Math.max(MIN_FIRST_RING, (totalLeaves * MIN_ARC_PER_LEAF) / span);
  const radiusAt = (depth: number) => (depth === 0 ? 0 : firstRing + (depth - 1) * RING_GAP);

  const positions = new Map<string, { x: number; y: number }>();
  let maxRadius = 0;

  const place = (id: string, depth: number, start: number, end: number) => {
    const angle = (start + end) / 2;
    const r = radiusAt(depth);
    maxRadius = Math.max(maxRadius, r);
    positions.set(id, { x: r * Math.cos(angle), y: r * Math.sin(angle) });

    let cursor = start;
    for (const kid of children.get(id) ?? []) {
      const share = ((end - start) * leaves.get(kid)!) / leaves.get(id)!;
      place(kid, depth + 1, cursor, cursor + share);
      cursor += share;
    }
  };
  // Ângulo 0 = direita; -π/2 = topo. A fatia livre fica centrada no topo.
  place(rootId, 0, -Math.PI / 2 + TOP_GAP / 2, -Math.PI / 2 + TOP_GAP / 2 + span);

  const internet = topology.edges.find((e) => e.kind === "wan")?.from;
  if (internet && visibleIds.has(internet)) positions.set(internet, { x: 0, y: -(maxRadius + INTERNET_OFFSET) });

  const half = maxRadius + PADDING;
  const top = maxRadius + INTERNET_OFFSET + PADDING;
  const nodes = Array.from(positions, ([id, p]) => ({ ...byId.get(id)!, x: p.x + half, y: p.y + top }));

  return { nodes, width: half * 2, height: top + half };
}
