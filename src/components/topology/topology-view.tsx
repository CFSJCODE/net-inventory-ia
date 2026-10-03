"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Loader2, Minus, Plus, Scan } from "lucide-react";
import { EarthIcon } from "@/components/ui/earth";
import { toast } from "sonner";
import { getTopology } from "@/app/actions/topology-actions";
import { useCan } from "@/components/auth/user-provider";
import type { LinkStatusRow } from "@/app/actions/link-actions";
import { getMapPositions, resetMapPositions, saveMapPosition, type MapPositions } from "@/app/actions/map-actions";
import { formatRelativeTime } from "@/lib/format-time";
import { useLinks, useLinkTransitionToasts } from "./links-panel";
import { cancelNavigationProgress } from "@/components/top-loading-bar";
import type { Topology, TopologyEdge } from "@/lib/network/topology";
import { layoutTopology, type PositionedNode } from "@/lib/topology-layout";
import { DeviceTypeIcon, DEVICE_TYPE_LABELS } from "@/components/device-type-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

async function fetchTopology(community: string | null): Promise<Topology> {
  const result = await getTopology(community);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** Oculta dispositivos finais offline; quem tem dispositivos ligados abaixo de si sempre aparece. */
function visibleNodeIds(topology: Topology, showOffline: boolean): Set<string> {
  const parents = new Set(topology.edges.filter((e) => e.tree).map((e) => e.from));
  return new Set(
    topology.nodes
      .filter((n) => showOffline || n.role !== "device" || n.status !== "OFFLINE" || parents.has(n.id))
      .map((n) => n.id),
  );
}

/** Sobrepõe nas arestas o status mais recente das ligações (consultado com mais frequência que o mapa). */
function withLiveStatus(topology: Topology, links: LinkStatusRow[] | undefined): Topology {
  if (!links) return topology;
  const byId = new Map(links.map((l) => [l.id, l]));
  return {
    ...topology,
    edges: topology.edges.map((e) => {
      const live = e.linkId ? byId.get(e.linkId) : undefined;
      return live ? { ...e, status: live.status, statusSince: live.statusSince, downReason: live.downReason } : e;
    }),
  };
}

function nodeTooltip(n: PositionedNode): string {
  return [
    n.label,
    n.type ? DEVICE_TYPE_LABELS[n.type] : null,
    n.ip && `IP: ${n.ip}`,
    n.mac && `MAC: ${n.mac}`,
    n.vendor && `Fabricante: ${n.vendor}`,
    n.status && (n.status === "ONLINE" ? "Online" : "Offline"),
  ]
    .filter(Boolean)
    .join("\n");
}

interface DragHandlers {
  onPointerDown: (e: ReactPointerEvent, node: PositionedNode) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  /** true quando o gesto que terminou foi um arrasto — o clique não deve abrir o dispositivo. */
  consumeDragClick: (nodeId: string) => boolean;
}

function TopologyNodeView({ node, dragging, handlers }: { node: PositionedNode; dragging: boolean; handlers: DragHandlers }) {
  const isHub = node.role === "gateway" || node.role === "internet";
  const size = isHub ? 56 : node.role === "infra" ? 48 : 40;
  const offline = node.status === "OFFLINE";

  const bubble = (
    <div
      className={cn(
        "flex items-center justify-center rounded-full border-2 bg-card shadow-sm transition-transform",
        dragging ? "scale-110 shadow-lg" : "group-hover:scale-110",
        node.role === "internet" && "border-sky-500 text-sky-500",
        node.role === "gateway" && "border-primary bg-primary text-primary-foreground",
        node.role === "infra" && "border-amber-500 text-amber-500",
        node.role === "device" && (offline ? "border-zinc-600 text-zinc-500" : "border-emerald-500 text-foreground"),
        node.isSelf && "ring-2 ring-sky-400 ring-offset-2 ring-offset-background",
      )}
      style={{ width: size, height: size }}
    >
      {node.role === "internet" ? <EarthIcon size={26} /> : node.type && <DeviceTypeIcon type={node.type} size={isHub ? 26 : 18} />}
    </div>
  );

  const content = (
    <>
      {bubble}
      {/* Fundo nos rótulos para as linhas das ligações não passarem por cima do texto. */}
      <span className="mt-1 flex flex-col items-center rounded bg-background/85 px-1">
        <span className="max-w-[130px] truncate text-center text-xs font-medium leading-tight">{node.label}</span>
        {node.ip && node.label !== node.ip && <span className="font-mono text-[10px] leading-tight text-muted-foreground">{node.ip}</span>}
        {node.isSelf && <span className="text-[10px] font-medium leading-tight text-sky-400">esta máquina</span>}
      </span>
    </>
  );

  const common = {
    title: dragging ? undefined : nodeTooltip(node),
    className: cn(
      "group absolute flex -translate-x-1/2 touch-none select-none flex-col items-center",
      dragging ? "z-10 cursor-grabbing" : "cursor-grab",
      offline && "opacity-50",
    ),
    // Centraliza a bolha (não o bloco com o texto) exatamente sobre a coordenada do nó.
    style: { left: node.x, top: node.y - size / 2 },
    onPointerDown: (e: ReactPointerEvent) => handlers.onPointerDown(e, node),
    onPointerMove: handlers.onPointerMove,
    onPointerUp: handlers.onPointerUp,
    onPointerCancel: handlers.onPointerUp,
    // Impede o arrasto nativo de link do navegador, que competiria com o nosso.
    draggable: false,
    onDragStart: (e: React.DragEvent) => e.preventDefault(),
  };

  return node.deviceId ? (
    <Link
      href={`/devices/${node.deviceId}`}
      {...common}
      onClick={(e) => {
        if (handlers.consumeDragClick(node.id)) {
          e.preventDefault();
          cancelNavigationProgress(); // foi o fim de um arrasto, não uma navegação
        }
      }}
    >
      {content}
    </Link>
  ) : (
    <div {...common}>{content}</div>
  );
}

function edgeCaption(edge: TopologyEdge): string | undefined {
  if (edge.kind !== "manual") return edge.label;
  const parts = [edge.label];
  if (edge.status === "DOWN") parts.push(edge.statusSince ? `caiu ${formatRelativeTime(edge.statusSince)}` : "fora do ar");
  if (edge.status === "UNKNOWN") parts.push("verificando…");
  return parts.filter(Boolean).join(" · ") || undefined;
}

function EdgeView({ edge, from, to }: { edge: TopologyEdge; from: PositionedNode; to: PositionedNode }) {
  const caption = edgeCaption(edge);
  const isManual = edge.kind === "manual";
  const down = isManual && edge.status === "DOWN";
  const dashed = edge.kind === "inferred" || (isManual && edge.status === "UNKNOWN");

  return (
    <g>
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        className={cn(
          edge.kind === "confirmed" && "stroke-violet-400",
          edge.kind === "wan" && "stroke-sky-500",
          edge.kind === "inferred" && "stroke-muted-foreground/40",
          isManual && edge.status === "UP" && "stroke-emerald-500",
          isManual && edge.status === "UNKNOWN" && "stroke-amber-500",
          down && "animate-pulse stroke-red-500",
        )}
        strokeWidth={edge.kind === "inferred" ? 1.25 : isManual ? 3 : 2}
        strokeDasharray={dashed ? "5 5" : undefined}
      >
        {down && edge.downReason && <title>{edge.downReason}</title>}
      </line>
      {caption && (
        <text
          x={(from.x + to.x) / 2}
          y={(from.y + to.y) / 2 - 6}
          textAnchor="middle"
          paintOrder="stroke"
          strokeWidth={4}
          className={cn("stroke-background text-[11px] font-medium", down ? "fill-red-400" : "fill-muted-foreground")}
        >
          {caption}
        </text>
      )}
    </g>
  );
}

function Legend() {
  const item = (swatch: React.ReactNode, text: string) => (
    <span className="flex items-center gap-1.5">
      {swatch}
      {text}
    </span>
  );
  const line = (cls: string, dashed = false) => (
    <svg width="28" height="6">
      <line x1="0" y1="3" x2="28" y2="3" className={cls} strokeWidth="2" strokeDasharray={dashed ? "4 4" : undefined} />
    </svg>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {item(line("stroke-emerald-500"), "Ligação monitorada: no ar")}
      {item(line("stroke-red-500"), "Ligação monitorada: caiu")}
      {item(line("stroke-violet-400"), "Ligação confirmada (SNMP)")}
      {item(line("stroke-muted-foreground/60", true), "Ligação presumida")}
      {item(<span className="h-3 w-3 rounded-full border-2 border-amber-500" />, "Equipamento de rede")}
      {item(<span className="h-3 w-3 rounded-full border-2 border-emerald-500" />, "Online")}
      {item(<span className="h-3 w-3 rounded-full border-2 border-zinc-600 opacity-50" />, "Offline")}
      {item(<span className="h-3 w-3 rounded-full ring-2 ring-sky-400" />, "Esta máquina")}
    </div>
  );
}

const ZOOM_STEPS = [0.4, 0.5, 0.65, 0.8, 1, 1.25, 1.5];

// Margens do quadro do mapa em volta dos nós (o rótulo fica abaixo da bolha, por isso embaixo é maior).
const FRAME_PAD_X = 90;
const FRAME_PAD_TOP = 50;
const FRAME_PAD_BOTTOM = 70;
const DRAG_THRESHOLD_PX = 4;

type Point = { x: number; y: number };

interface Frame {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

function frameAround(points: Point[]): Frame {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs) - FRAME_PAD_X;
  const minY = Math.min(...ys) - FRAME_PAD_TOP;
  return { minX, minY, width: Math.max(...xs) + FRAME_PAD_X - minX, height: Math.max(...ys) + FRAME_PAD_BOTTOM - minY };
}

interface DragState {
  nodeId: string;
  pointerId: number;
  startClient: Point;
  startPos: Point;
  pos: Point;
  moved: boolean;
  /** Quadro congelado no início do arrasto, para o mapa não se redimensionar sob o cursor. */
  frame: Frame;
}

export function TopologyView() {
  const queryClient = useQueryClient();
  const [community, setCommunity] = useState("public");
  const [snmpCommunity, setSnmpCommunity] = useState<string | null>(null);
  const [showOffline, setShowOffline] = useState(true);
  const [zoom, setZoom] = useState<number | null>(null); // null = ajustar à largura
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data, error, isFetching, isLoading, refetch } = useQuery({
    queryKey: ["topology", snmpCommunity],
    queryFn: () => fetchTopology(snmpCommunity),
    placeholderData: (previous) => previous,
  });
  const { data: savedPositions, isLoading: positionsLoading } = useQuery({ queryKey: ["map-positions"], queryFn: () => getMapPositions() });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { data: links } = useLinks();
  useLinkTransitionToasts(links);
  const topology = useMemo(() => (data ? withLiveStatus(data, links) : undefined), [data, links]);
  const layout = useMemo(
    () => (topology ? layoutTopology(topology, visibleNodeIds(topology, showOffline)) : null),
    [topology, showOffline],
  );

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const justDragged = useRef<string | null>(null);

  // Posição de cada nó relativa ao gateway: a automática do layout, sobrescrita pela salva e pela do
  // arrasto em curso. Relativa ao gateway para continuar válida quando o mapa cresce com novos nós.
  const relative = useMemo(() => {
    const map = new Map<string, Point>();
    if (!layout?.nodes.length) return map;
    const gw = layout.nodes.find((n) => n.role === "gateway") ?? layout.nodes[0];
    for (const n of layout.nodes) map.set(n.id, savedPositions?.[n.id] ?? { x: n.x - gw.x, y: n.y - gw.y });
    if (drag) map.set(drag.nodeId, drag.pos);
    return map;
  }, [layout, savedPositions, drag]);

  const frame = useMemo(
    () => drag?.frame ?? (relative.size ? frameAround(Array.from(relative.values())) : null),
    [drag?.frame, relative],
  );

  const positioned = useMemo(() => {
    if (!layout || !frame) return [];
    return layout.nodes.map((n) => {
      const p = relative.get(n.id)!;
      return { ...n, x: p.x - frame.minX, y: p.y - frame.minY };
    });
  }, [layout, frame, relative]);
  const byId = useMemo(() => new Map(positioned.map((n) => [n.id, n])), [positioned]);

  const fitScale = frame && containerWidth ? Math.min(1, containerWidth / frame.width) : 1;
  const scale = zoom ?? fitScale;
  const stepZoom = (dir: 1 | -1) => {
    const next = dir === 1 ? ZOOM_STEPS.find((z) => z > scale + 0.01) : [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.01);
    if (next) setZoom(next);
  };

  const canEdit = useCan("inventory.edit");
  const canOperate = useCan("network.operate");

  const dragHandlers: DragHandlers = {
    onPointerDown(e, node) {
      // Sem permissão de editar, o mapa não arrasta (a posição é salva no servidor); o clique continua abrindo o dispositivo.
      if (e.button !== 0 || !frame || !canEdit) return;
      // Nem todo arrasto termina em "click" (toque, soltar fora do nó); sem limpar aqui, a marca do
      // arrasto anterior engoliria o próximo clique de verdade.
      justDragged.current = null;
      e.currentTarget.setPointerCapture(e.pointerId);
      const start = relative.get(node.id)!;
      dragRef.current = {
        nodeId: node.id,
        pointerId: e.pointerId,
        startClient: { x: e.clientX, y: e.clientY },
        startPos: start,
        pos: start,
        moved: false,
        frame,
      };
    },
    onPointerMove(e) {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const dx = e.clientX - d.startClient.x;
      const dy = e.clientY - d.startClient.y;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      // Deslocamento na tela dividido pelo zoom = deslocamento nas coordenadas do mapa.
      const next = { ...d, moved: true, pos: { x: d.startPos.x + dx / scale, y: d.startPos.y + dy / scale } };
      dragRef.current = next;
      setDrag(next);
    },
    onPointerUp(e) {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      dragRef.current = null;
      if (!d.moved) return; // foi um clique: deixa o link abrir o dispositivo
      justDragged.current = d.nodeId;
      // Atualiza o cache antes de encerrar o arrasto, para o nó não "voltar" até o servidor responder.
      queryClient.setQueryData<MapPositions>(["map-positions"], (old) => ({ ...old, [d.nodeId]: d.pos }));
      setDrag(null);
      saveMapPosition(d.nodeId, d.pos.x, d.pos.y).catch(() => {
        toast.error("Não foi possível salvar a posição no mapa");
        queryClient.invalidateQueries({ queryKey: ["map-positions"] });
      });
    },
    consumeDragClick(nodeId) {
      const dragged = justDragged.current === nodeId;
      justDragged.current = null;
      return dragged;
    },
  };

  const hasCustomLayout = !!savedPositions && Object.keys(savedPositions).length > 0;
  async function handleResetLayout() {
    await resetMapPositions();
    queryClient.setQueryData<MapPositions>(["map-positions"], {});
    toast.success("Mapa reorganizado automaticamente");
  }

  const infraCount = data?.nodes.filter((n) => n.role === "infra").length ?? 0;
  const confirmed = data?.edges.filter((e) => e.kind === "confirmed").length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            {canOperate && (
            <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="topo-community" className="text-xs text-muted-foreground">
                Community SNMP dos switches
              </Label>
              <Input id="topo-community" value={community} onChange={(e) => setCommunity(e.target.value)} className="sm:w-40" />
            </div>
            <Button
              onClick={() => (community === snmpCommunity ? refetch() : setSnmpCommunity(community))}
              disabled={isFetching || !community}
            >
              {isFetching && snmpCommunity ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scan className="h-3.5 w-3.5" />}
              Descobrir ligações via SNMP
            </Button>
            </>
            )}
            <Label className="flex items-center gap-2 text-sm font-normal sm:ml-auto">
              <input type="checkbox" checked={showOffline} onChange={(e) => setShowOffline(e.target.checked)} />
              Mostrar dispositivos offline
            </Label>
            {canEdit && (
              <Button variant="outline" onClick={handleResetLayout} disabled={!hasCustomLayout} title="Descarta as posições arrastadas">
                <LayoutGrid className="h-3.5 w-3.5" />
                Reorganizar automaticamente
              </Button>
            )}
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" onClick={() => stepZoom(-1)} aria-label="Diminuir zoom">
                <Minus className="h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={() => setZoom(null)} className="w-20 tabular-nums">
                {zoom === null ? "Ajustar" : `${Math.round(scale * 100)}%`}
              </Button>
              <Button variant="outline" size="icon" onClick={() => stepZoom(1)} aria-label="Aumentar zoom">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {data?.snmp && (
            <ul className="flex flex-col gap-1 text-xs">
              {data.snmp.length === 0 && <li className="text-muted-foreground">Nenhum roteador ou switch no inventário para consultar.</li>}
              {data.snmp.map((s) => (
                <li key={s.ip} className={s.ok && s.macsLearned ? "text-emerald-500" : "text-muted-foreground"}>
                  <span className="font-mono">{s.ip}</span> ({s.label}):{" "}
                  {s.ok
                    ? s.macsLearned
                      ? `${s.macsLearned} MAC(s) na tabela de encaminhamento`
                      : "respondeu, mas não expõe a tabela de MACs (BRIDGE-MIB)"
                    : "sem resposta SNMP"}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            {confirmed > 0
              ? `${confirmed} ligação(ões) confirmada(s) pela tabela de MACs dos switches.`
              : `Sem dados de switches gerenciáveis, os dispositivos aparecem ligados direto ao gateway — a porta/switch real de cada um só pode ser lida via SNMP${infraCount ? ` (${infraCount} equipamento(s) de rede no inventário)` : ""}.`}
          </p>
          <p className="text-xs text-muted-foreground">
            Para acompanhar se uma ligação cai (ex: roteador principal → secundário), cadastre-a em{" "}
            <Link href="/topology/links" className="text-foreground underline underline-offset-2">
              Ligações monitoradas
            </Link>
            . Arraste os dispositivos para organizar o mapa — a posição fica salva; clique para abrir os detalhes.
          </p>
          <Legend />
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">Não foi possível montar a topologia: {error.message}</p>}

      <div ref={containerRef} className="relative overflow-auto rounded-md border bg-card/30" style={{ maxHeight: "75vh" }}>
        {(isLoading || positionsLoading) && <Skeleton className="h-[480px] w-full" />}
        {layout && layout.nodes.length === 0 && (
          <p className="p-10 text-center text-sm text-muted-foreground">Nenhum dispositivo no inventário. Rode um scan primeiro.</p>
        )}
        {/* Espera as posições salvas: sem isso o mapa aparece no layout automático e os nós "pulam" em seguida. */}
        {!positionsLoading && frame && positioned.length > 0 && (
          <div style={{ width: frame.width * scale, height: frame.height * scale }} className="mx-auto">
            <div
              className="relative origin-top-left"
              style={{ width: frame.width, height: frame.height, transform: `scale(${scale})` }}
            >
              <svg width={frame.width} height={frame.height} className="absolute inset-0 overflow-visible">
                {topology!.edges.map((e) => {
                  const from = byId.get(e.from);
                  const to = byId.get(e.to);
                  return from && to ? <EdgeView key={e.linkId ?? `${e.from}-${e.to}`} edge={e} from={from} to={to} /> : null;
                })}
              </svg>
              {positioned.map((n) => (
                <TopologyNodeView key={n.id} node={n} dragging={drag?.nodeId === n.id} handlers={dragHandlers} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
