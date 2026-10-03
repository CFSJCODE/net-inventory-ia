import { describe, expect, it } from "vitest";
import type { Topology, TopologyNode } from "@/lib/network/topology";
import { layoutTopology } from "./topology-layout";

const node = (id: string, role: TopologyNode["role"]): TopologyNode => ({
  id,
  role,
  label: id,
  ip: null,
  mac: null,
  vendor: null,
  type: "UNKNOWN",
  status: "ONLINE",
  isSelf: false,
  deviceId: id,
});

describe("layoutTopology", () => {
  it("posiciona todos os nós visíveis sem sobreposição", () => {
    const devices = Array.from({ length: 30 }, (_, i) => node(`d${i}`, "device"));
    const topology: Topology = {
      nodes: [node("internet", "internet"), node("gw", "gateway"), ...devices],
      edges: [
        { from: "internet", to: "gw", kind: "wan", tree: true },
        ...devices.map((d) => ({ from: "gw", to: d.id, kind: "inferred" as const, tree: true })),
      ],
      gatewayIp: null,
      snmp: null,
    };
    const { nodes } = layoutTopology(topology, new Set(topology.nodes.map((n) => n.id)));
    expect(nodes).toHaveLength(32);

    let min = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) min = Math.min(min, Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y));
    }
    expect(min).toBeGreaterThan(60);
  });
});
