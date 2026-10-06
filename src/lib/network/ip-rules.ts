import { prisma } from "@/lib/prisma";
import type { DeviceType } from "@prisma/client";

export interface IpClassificationRule {
  id: string;
  name?: string;
  /**
   * Padrão de IP:
   * - IP único: "192.168.0.50"
   * - Faixa: "192.168.0.100-192.168.0.150"
   * - CIDR: "192.168.0.0/28"
   * - Curinga: "192.168.0.*"
   */
  pattern: string;
  type: DeviceType;
  /** Se true, marca typeLocked = true para não ser sobrescrito por scans futuros */
  lock: boolean;
  enabled: boolean;
}

const SETTING_KEY = "network.ipRules";

export function ipToNumber(ip: string): number {
  const parts = ip.trim().split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isValidIp(ip: string): boolean {
  return ipToNumber(ip) !== -1;
}

/**
 * Valida e verifica se um IP corresponde a um padrão de regra:
 * 1. IP único: "192.168.1.10"
 * 2. Faixa: "192.168.1.10-192.168.1.50" ou "192.168.1.10 - 192.168.1.50"
 * 3. CIDR: "192.168.1.0/24"
 * 4. Curinga: "192.168.1.*"
 */
export function matchesIpPattern(ip: string, pattern: string): boolean {
  const cleanIp = ip.trim();
  const cleanPattern = pattern.trim();
  const targetNum = ipToNumber(cleanIp);
  if (targetNum === -1) return false;

  // 1. Faixa com hífen (ex: 192.168.0.10 - 192.168.0.20)
  if (cleanPattern.includes("-")) {
    const [startStr, endStr] = cleanPattern.split("-").map((s) => s.trim());
    const startNum = ipToNumber(startStr);
    const endNum = ipToNumber(endStr);
    if (startNum === -1 || endNum === -1) return false;
    const min = Math.min(startNum, endNum);
    const max = Math.max(startNum, endNum);
    return targetNum >= min && targetNum <= max;
  }

  // 2. CIDR (ex: 192.168.0.0/28)
  if (cleanPattern.includes("/")) {
    const [baseIp, maskStr] = cleanPattern.split("/").map((s) => s.trim());
    const baseNum = ipToNumber(baseIp);
    const prefix = Number(maskStr);
    if (baseNum === -1 || isNaN(prefix) || prefix < 0 || prefix > 32) return false;
    if (prefix === 0) return true;
    const mask = ((0xffffffff << (32 - prefix)) >>> 0);
    return (targetNum & mask) === (baseNum & mask);
  }

  // 3. Curinga com asterisco (ex: 192.168.0.*)
  if (cleanPattern.includes("*")) {
    const prefix = cleanPattern.replace(/\*+$/, "");
    return cleanIp.startsWith(prefix);
  }

  // 4. IP individual exato
  const patNum = ipToNumber(cleanPattern);
  return patNum !== -1 && targetNum === patNum;
}

/**
 * Encontra a primeira regra ativa que corresponda ao IP informado.
 */
export function findMatchingRule(
  ip: string,
  rules: IpClassificationRule[],
): IpClassificationRule | null {
  for (const rule of rules) {
    if (rule.enabled && matchesIpPattern(ip, rule.pattern)) {
      return rule;
    }
  }
  return null;
}

/**
 * Lê as regras de classificação salvas no banco.
 */
export async function getIpRules(): Promise<IpClassificationRule[]> {
  const setting = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!setting?.value) return [];
  try {
    const parsed = JSON.parse(setting.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Salva as regras no banco de dados.
 */
export async function saveIpRules(rules: IpClassificationRule[]): Promise<void> {
  const serialized = JSON.stringify(rules);
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: serialized },
    update: { key: SETTING_KEY, value: serialized },
  });
}

/**
 * Aplica todas as regras ativas aos dispositivos existentes no banco de dados.
 */
export async function applyIpRulesToExistingDevices(): Promise<{ matchedCount: number; updatedCount: number }> {
  const rules = await getIpRules();
  const activeRules = rules.filter((r) => r.enabled);
  if (!activeRules.length) return { matchedCount: 0, updatedCount: 0 };

  const devices = await prisma.device.findMany({ select: { id: true, ip: true, type: true, typeLocked: true } });
  let matchedCount = 0;
  let updatedCount = 0;

  for (const device of devices) {
    const match = findMatchingRule(device.ip, activeRules);
    if (match) {
      matchedCount++;
      const needsTypeUpdate = device.type !== match.type;
      const needsLockUpdate = match.lock && !device.typeLocked;
      if (needsTypeUpdate || needsLockUpdate) {
        await prisma.device.update({
          where: { id: device.id },
          data: {
            type: match.type,
            ...(match.lock ? { typeLocked: true } : {}),
          },
        });
        updatedCount++;
      }
    }
  }

  return { matchedCount, updatedCount };
}
