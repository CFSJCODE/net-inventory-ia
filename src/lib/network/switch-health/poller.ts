import type { Equipment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { serialized } from "@/lib/global-status/write-queue";
import { defaultGateway, probeIcmp } from "@/lib/global-status/probes";
import { mapWithConcurrency } from "../concurrency";
import { snmpGetMany, snmpQuery, type SnmpTarget } from "../tools/snmp";
import { shortPortName } from "../switch-fdb";
import { snmpTargetOf } from "../equipment-target";
import { computeRates, totalsOf, type EquipmentTotals, type PortRates, type RawPortReading, type RawSnapshot } from "./counters";
import { getSwitchHealthSettings } from "./settings";

/**
 * Coletor periódico da saúde das switches (Switch Health). A cada rodada (60 s por padrão) lê, por SNMP,
 * os contadores IF-MIB e EtherLike-MIB das portas físicas de cada equipamento cadastrado, calcula as taxas
 * desde a rodada anterior e grava, junto com a latência medida no mesmo instante (ping à switch e ao
 * gateway), para a tela correlacionar erros e latência e para o alerta de erros por minuto.
 *
 * Impressoras e equipamentos sem porta física ficam de fora sozinhos (a lista de portas sai vazia).
 */

export const OID = {
  uptime: "1.3.6.1.2.1.1.3.0",
  ifName: "1.3.6.1.2.1.31.1.1.1.1",
  oper: "1.3.6.1.2.1.2.2.1.8",
  speed: "1.3.6.1.2.1.31.1.1.1.15",
  inDiscards: "1.3.6.1.2.1.2.2.1.13",
  inErrors: "1.3.6.1.2.1.2.2.1.14",
  outDiscards: "1.3.6.1.2.1.2.2.1.19",
  outErrors: "1.3.6.1.2.1.2.2.1.20",
  inOctets: "1.3.6.1.2.1.31.1.1.1.6",
  outOctets: "1.3.6.1.2.1.31.1.1.1.10",
  /** dot3StatsFCSErrors: na HP 1910 é indexado pelo ifIndex. */
  crcErrors: "1.3.6.1.2.1.10.7.2.1.3",
} as const;

const RE_PHYSICAL = /^(GigabitEthernet|Ten-?GigabitEthernet|FastEthernet|Ethernet)\d/i;
/** A lista de portas muda raramente (módulo SFP novo): relida a cada 30 min. */
const PORT_LIST_TTL_MS = 30 * 60_000;
const HEALTH_RETENTION_MS = 7 * 86_400_000;
const PORT_RETENTION_MS = 48 * 3_600_000;
const CLEANUP_EVERY_MS = 3_600_000;
const PINGS = 3;

interface PortListCache {
  at: number;
  ports: { ifIndex: number; name: string }[];
}

export interface LatestHealth extends EquipmentTotals {
  equipmentId: string;
  ip: string;
  at: number;
  latencyMs: number | null;
  gatewayLatencyMs: number | null;
  ports: PortRates[];
  error: string | null;
}

const g = globalThis as typeof globalThis & {
  __switchHealthTimer?: NodeJS.Timeout;
  __switchHealthRun?: Promise<void>;
  __switchHealthSnapshots?: Map<string, RawSnapshot>;
  __switchHealthPorts?: Map<string, PortListCache>;
  __switchHealthLatest?: Map<string, LatestHealth>;
  __switchHealthCleanupAt?: number;
  __switchHealthIntervalSec?: number;
};
const snapshots = () => (g.__switchHealthSnapshots ??= new Map());
const portLists = () => (g.__switchHealthPorts ??= new Map());
const latest = () => (g.__switchHealthLatest ??= new Map());

/** Centésimos de segundo a partir do texto "11d 19h 50m" do cliente SNMP (precisão de minuto basta para detectar reinício). */
function ticksFromText(text: string | undefined): number | null {
  const m = /^(\d+)d (\d+)h (\d+)m$/.exec(text ?? "");
  return m ? ((Number(m[1]) * 1440 + Number(m[2]) * 60 + Number(m[3])) * 60 * 100) : null;
}

async function physicalPorts(equipmentId: string, target: SnmpTarget): Promise<{ ifIndex: number; name: string }[]> {
  const cached = portLists().get(equipmentId);
  if (cached && Date.now() - cached.at < PORT_LIST_TTL_MS) return cached.ports;
  const { rows } = await snmpQuery(target, "walk", OID.ifName);
  const prefix = `${OID.ifName}.`;
  const ports = rows
    .map(([oid, name]) => ({ ifIndex: Number(oid.startsWith(prefix) ? oid.slice(prefix.length) : NaN), name }))
    .filter((p) => Number.isInteger(p.ifIndex) && RE_PHYSICAL.test(p.name))
    .sort((a, b) => a.ifIndex - b.ifIndex);
  portLists().set(equipmentId, { at: Date.now(), ports });
  return ports;
}

const present = (v: string | undefined) => (v === undefined || v === "" || ["noSuchName", "noSuchObject", "noSuchInstance"].includes(v) ? null : v);

/** Uma leitura crua dos contadores de todas as portas físicas. */
export async function readSnapshot(equipmentId: string, target: SnmpTarget): Promise<RawSnapshot> {
  const ports = await physicalPorts(equipmentId, target);
  const columns = ["oper", "speed", "inErrors", "outErrors", "inDiscards", "outDiscards", "crcErrors", "inOctets", "outOctets"] as const;
  const oids = [OID.uptime, ...ports.flatMap((p) => columns.map((c) => `${OID[c]}.${p.ifIndex}`))];
  const values = await snmpGetMany(target, oids);
  const at = Date.now();
  const v = (c: (typeof columns)[number], idx: number) => present(values.get(`${OID[c]}.${idx}`));
  const readings: RawPortReading[] = ports.map((p) => ({
    ifIndex: p.ifIndex,
    name: shortPortName(p.name),
    operUp: v("oper", p.ifIndex) === "1",
    speedMbps: Number(v("speed", p.ifIndex)) || null,
    counters: {
      inErrors: v("inErrors", p.ifIndex),
      outErrors: v("outErrors", p.ifIndex),
      inDiscards: v("inDiscards", p.ifIndex),
      outDiscards: v("outDiscards", p.ifIndex),
      crcErrors: v("crcErrors", p.ifIndex),
      inOctets: v("inOctets", p.ifIndex),
      outOctets: v("outOctets", p.ifIndex),
    },
  }));
  return { at, uptimeTicks: ticksFromText(values.get(OID.uptime)), ports: readings };
}

async function gatewayLatency(): Promise<number | null> {
  const gw = await defaultGateway().catch(() => null);
  if (!gw) return null;
  const r = await probeIcmp(gw, { count: PINGS });
  return r.ok ? r.latencyMs : null;
}

/** Lê uma switch, calcula as taxas e grava a rodada. A primeira rodada de cada equipamento só guarda a base. */
async function pollEquipment(eq: Equipment, gatewayMs: number | null): Promise<void> {
  let target: SnmpTarget;
  try {
    target = snmpTargetOf(eq);
  } catch (err) {
    latest().set(eq.id, { ...emptyLatest(eq), error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const [snap, ping] = await Promise.all([
    readSnapshot(eq.id, target).catch((err: unknown) => err instanceof Error ? err : new Error(String(err))),
    probeIcmp(eq.ip, { count: PINGS }),
  ]);
  if (snap instanceof Error) {
    latest().set(eq.id, { ...emptyLatest(eq), latencyMs: ping.ok ? ping.latencyMs : null, gatewayLatencyMs: gatewayMs, error: snap.message });
    return;
  }
  if (!snap.ports.length) return; // impressora ou roteador sem porta física: não é switch.
  const prev = snapshots().get(eq.id) ?? null;
  snapshots().set(eq.id, snap);
  const rates = computeRates(prev, snap);
  const totals = totalsOf(rates);
  const latencyMs = ping.ok ? ping.latencyMs : null;
  latest().set(eq.id, { ...totals, equipmentId: eq.id, ip: eq.ip, at: snap.at, latencyMs, gatewayLatencyMs: gatewayMs, ports: rates, error: null });
  if (!prev) return;

  const at = new Date(snap.at);
  const intervalSec = Math.round((snap.at - prev.at) / 1000);
  await serialized(() =>
    prisma.$transaction([
      prisma.switchHealthSample.create({
        data: {
          equipmentId: eq.id,
          at,
          intervalSec,
          errorsPerMin: totals.errorsPerMin,
          crcPerMin: totals.crcPerMin,
          discardsPerMin: totals.discardsPerMin,
          inBps: totals.inBps,
          outBps: totals.outBps,
          worstPort: totals.worstPort,
          latencyMs,
          lossPct: ping.lossPct ?? null,
          gatewayLatencyMs: gatewayMs,
        },
      }),
      prisma.switchPortSample.createMany({
        data: rates
          // Porta desligada e sem nada contado não diz nada: fica fora para o banco não crescer à toa.
          .filter((r) => r.operUp || (r.errorsPerMin ?? 0) > 0 || (r.discardsPerMin ?? 0) > 0)
          .map((r) => ({
            equipmentId: eq.id,
            ifIndex: r.ifIndex,
            name: r.name,
            at,
            operUp: r.operUp,
            speedMbps: r.speedMbps,
            inErrors: r.inErrors,
            outErrors: r.outErrors,
            inDiscards: r.inDiscards,
            outDiscards: r.outDiscards,
            crcErrors: r.crcErrors,
            errorsPerMin: r.errorsPerMin,
            discardsPerMin: r.discardsPerMin,
            crcPerMin: r.crcPerMin,
            inBps: r.inBps,
            outBps: r.outBps,
            utilPct: r.utilPct,
          })),
      }),
    ]),
  );
}

function emptyLatest(eq: Equipment): LatestHealth {
  return {
    equipmentId: eq.id, ip: eq.ip, at: Date.now(), latencyMs: null, gatewayLatencyMs: null, ports: [], error: null,
    errorsPerMin: null, discardsPerMin: null, crcPerMin: null, inBps: null, outBps: null, worstPort: null, worstPortErrorsPerMin: null,
  };
}

async function cleanup(): Promise<void> {
  const nowMs = Date.now();
  if (g.__switchHealthCleanupAt && nowMs - g.__switchHealthCleanupAt < CLEANUP_EVERY_MS) return;
  g.__switchHealthCleanupAt = nowMs;
  await serialized(() =>
    prisma.$transaction([
      prisma.switchHealthSample.deleteMany({ where: { at: { lt: new Date(nowMs - HEALTH_RETENTION_MS) } } }),
      prisma.switchPortSample.deleteMany({ where: { at: { lt: new Date(nowMs - PORT_RETENTION_MS) } } }),
    ]),
  );
}

async function runPoll(): Promise<void> {
  const settings = await getSwitchHealthSettings();
  if (!settings.enabled) return;
  const equipment = await prisma.equipment.findMany();
  // Equipamento removido: some da memória.
  for (const id of snapshots().keys()) if (!equipment.some((e) => e.id === id)) { snapshots().delete(id); latest().delete(id); portLists().delete(id); }
  if (!equipment.length) return;
  const gatewayMs = await gatewayLatency();
  await mapWithConcurrency(equipment, 3, (eq) => pollEquipment(eq, gatewayMs).catch((err) => console.error(`[switch-health] ${eq.ip}: ${err instanceof Error ? err.message : err}`)));
  await cleanup().catch((err) => console.error("[switch-health] limpeza falhou:", err));
}

/** Uma rodada agora; nunca duas ao mesmo tempo. */
export function pollSwitchHealthNow(): Promise<void> {
  if (g.__switchHealthRun) return g.__switchHealthRun;
  g.__switchHealthRun = runPoll()
    .catch((err) => console.error("[switch-health] falha na rodada:", err))
    .finally(() => {
      g.__switchHealthRun = undefined;
    });
  return g.__switchHealthRun;
}

function schedule(intervalSec: number): void {
  if (g.__switchHealthTimer) clearInterval(g.__switchHealthTimer);
  g.__switchHealthIntervalSec = intervalSec;
  g.__switchHealthTimer = setInterval(() => {
    void pollSwitchHealthNow().then(async () => {
      // Intervalo mudou na tela: reagenda sem reiniciar o servidor.
      const s = await getSwitchHealthSettings().catch(() => null);
      if (s && s.intervalSec !== g.__switchHealthIntervalSec) schedule(s.intervalSec);
    });
  }, intervalSec * 1000);
}

/** Inicia o coletor (uma vez por processo, via instrumentation). Desligue com SWITCH_HEALTH=off. */
export function startSwitchHealthMonitor(): void {
  if (g.__switchHealthTimer || process.env.SWITCH_HEALTH === "off") return;
  void getSwitchHealthSettings()
    .then((s) => {
      schedule(s.intervalSec);
      // Primeira rodada logo ao subir: é a base das taxas da rodada seguinte.
      void pollSwitchHealthNow();
      console.log(`[switch-health] lendo contadores das switches a cada ${s.intervalSec}s`);
    })
    .catch((err) => console.error("[switch-health] não iniciou:", err));
}

/** Última rodada de um equipamento (por IP), para o alerta por e-mail. */
export function latestHealthByIp(ip: string): LatestHealth | null {
  // Leitura velha (coletor parado, switch sem responder) não deve manter nem disparar alerta.
  const maxAge = 3 * (g.__switchHealthIntervalSec ?? 60) * 1000;
  for (const h of latest().values()) if (h.ip === ip && !h.error && Date.now() - h.at <= maxAge) return h;
  return null;
}

export function latestHealth(equipmentId: string): LatestHealth | null {
  return latest().get(equipmentId) ?? null;
}
