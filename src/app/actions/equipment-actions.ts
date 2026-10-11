"use server";

import net from "node:net";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireSession } from "@/lib/auth/server";
import { decrypt, encrypt } from "@/lib/ai/settings";
import { displayName } from "@/lib/device-name";
import { readEquipmentStatus, type EquipmentStatus } from "@/lib/network/equipment-status";
import { snmpQuery, type SnmpVersion } from "@/lib/network/tools/snmp";
import type { ToolResult } from "./tool-actions";

/** O que vai para o navegador: a community fica no servidor, só se informa se há uma cadastrada. */
export interface EquipmentRow {
  id: string;
  name: string;
  ip: string;
  snmpVersion: SnmpVersion;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EquipmentInput {
  name: string;
  ip: string;
  /** Vazio na edição = manter a community atual. */
  community: string;
  snmpVersion: string;
  notes: string;
}

/** Dispositivo do inventário dono de um MAC aprendido numa porta. */
export interface KnownDevice {
  id: string;
  name: string;
  ip: string;
}

export interface EquipmentDetail extends EquipmentStatus {
  devicesByMac: Record<string, KnownDevice>;
}

export interface ConnectionTest {
  sysName: string | null;
  sysDescr: string | null;
}

const VERSIONS: SnmpVersion[] = ["2c", "1"];
const ROW_FIELDS = { id: true, name: true, ip: true, snmpVersion: true, notes: true, createdAt: true, updatedAt: true } as const;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/;

async function run<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function assertHost(host: string): string {
  const v = host.trim();
  if (net.isIP(v) || HOSTNAME_RE.test(v)) return v;
  throw new Error("Endereço inválido. Use um IP (ex: 192.168.0.3) ou um nome de host.");
}

function assertVersion(v: string): SnmpVersion {
  if (!VERSIONS.includes(v as SnmpVersion)) throw new Error("Versão SNMP não suportada. Use 1 ou 2c.");
  return v as SnmpVersion;
}

function toRow(e: { snmpVersion: string } & Omit<EquipmentRow, "snmpVersion">): EquipmentRow {
  return { ...e, snmpVersion: e.snmpVersion === "1" ? "1" : "2c" };
}

/** Community guardada (criptografada); erro claro quando o AUTH_SECRET mudou e ela não abre mais. */
function openCommunity(stored: string): string {
  const plain = decrypt(stored);
  if (plain === null) throw new Error("Não foi possível ler a community salva (a chave do servidor mudou). Edite o equipamento e informe a community de novo.");
  return plain;
}

function validate(input: EquipmentInput, requireCommunity: boolean) {
  const name = input.name.trim();
  if (!name) throw new Error("Informe um nome para o equipamento.");
  if (name.length > 80) throw new Error("Nome longo demais (máximo 80 caracteres).");
  const community = input.community.trim();
  if (requireCommunity && !community) throw new Error("Informe a community SNMP.");
  const notes = input.notes.trim();
  if (notes.length > 1000) throw new Error("Observações longas demais (máximo 1000 caracteres).");
  return { name, ip: assertHost(input.ip), community, snmpVersion: assertVersion(input.snmpVersion), notes: notes || null };
}

async function assertIpFree(ip: string, exceptId?: string) {
  const other = await prisma.equipment.findUnique({ where: { ip }, select: { id: true, name: true } });
  if (other && other.id !== exceptId) throw new Error(`O endereço ${ip} já está cadastrado como "${other.name}".`);
}

export async function listEquipment(): Promise<ToolResult<EquipmentRow[]>> {
  return run(async () => {
    await requireSession();
    const rows = await prisma.equipment.findMany({ select: ROW_FIELDS, orderBy: { name: "asc" } });
    return rows.map(toRow);
  });
}

export async function createEquipment(input: EquipmentInput): Promise<ToolResult<EquipmentRow>> {
  return run(async () => {
    await requirePermission("inventory.edit");
    const data = validate(input, true);
    await assertIpFree(data.ip);
    const row = await prisma.equipment.create({ data: { ...data, community: encrypt(data.community) }, select: ROW_FIELDS });
    return toRow(row);
  });
}

export async function updateEquipment(id: string, input: EquipmentInput): Promise<ToolResult<EquipmentRow>> {
  return run(async () => {
    await requirePermission("inventory.edit");
    const { community, ...data } = validate(input, false);
    await assertIpFree(data.ip, id);
    const row = await prisma.equipment.update({
      where: { id },
      data: { ...data, ...(community ? { community: encrypt(community) } : {}) },
      select: ROW_FIELDS,
    });
    return toRow(row);
  });
}

export async function deleteEquipment(id: string): Promise<ToolResult<{ id: string }>> {
  return run(async () => {
    await requirePermission("inventory.edit");
    await prisma.equipment.delete({ where: { id } });
    return { id };
  });
}

/**
 * Testa o acesso SNMP antes de salvar. Na edição, community em branco usa a já cadastrada (id).
 * Devolve sysName/sysDescr para o formulário sugerir o nome.
 */
export async function testEquipmentConnection(input: { ip: string; community: string; snmpVersion: string; id?: string }): Promise<ToolResult<ConnectionTest>> {
  return run(async () => {
    await requirePermission("network.operate");
    const host = assertHost(input.ip);
    const version = assertVersion(input.snmpVersion);
    let community = input.community.trim();
    if (!community && input.id) {
      const stored = await prisma.equipment.findUnique({ where: { id: input.id }, select: { community: true } });
      if (stored) community = openCommunity(stored.community);
    }
    if (!community) throw new Error("Informe a community SNMP.");
    const sys = await snmpQuery({ host, community, version }, "system");
    const value = (label: string) => {
      const v = sys.rows.find(([l]) => l.startsWith(label))?.[1];
      return v && v !== "—" ? v : null;
    };
    const sysName = value("Nome");
    const sysDescr = value("Descrição");
    if (!sysName && !sysDescr) throw new Error("O equipamento respondeu, mas sem os dados de identificação (system). Confira a community.");
    return { sysName, sysDescr };
  });
}

/** Leitura completa e ao vivo do equipamento cadastrado, com os MACs das portas cruzados com o inventário. */
export async function readEquipmentDetail(id: string): Promise<ToolResult<EquipmentDetail>> {
  return run(async () => {
    await requirePermission("network.operate");
    const eq = await prisma.equipment.findUnique({ where: { id } });
    if (!eq) throw new Error("Equipamento não encontrado. Ele pode ter sido removido.");
    const status = await readEquipmentStatus(eq.ip, openCommunity(eq.community), eq.snmpVersion === "1" ? "1" : "2c");

    const macs = Array.from(new Set(status.ports.flatMap((p) => p.learnedMacs)));
    const devices = macs.length
      ? await prisma.device.findMany({ where: { mac: { in: macs } }, select: { id: true, mac: true, ip: true, alias: true, hostname: true } })
      : [];
    const devicesByMac: Record<string, KnownDevice> = {};
    for (const d of devices) if (d.mac) devicesByMac[d.mac] = { id: d.id, name: displayName(d, d.ip), ip: d.ip };
    return { ...status, devicesByMac };
  });
}
