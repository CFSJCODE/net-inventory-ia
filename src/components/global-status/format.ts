import { STATUS_SEVERITY, type ServiceStatus } from "@/lib/global-status/types";

/** Texto no lugar de um número que ainda não existe (instalação nova, alvo sem amostra). */
export const NO_VALUE = "—";

/** Latência com a unidade: "4,2 ms" abaixo de 10 ms, "42 ms" até 1 s, depois "1,2 s". */
export function formatLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return NO_VALUE;
  // Compara o valor já arredondado, para 9,96 ms não virar "10,0 ms" nem 999,6 ms virar "1.000 ms".
  if (Math.round(ms * 10) / 10 < 10) return `${ms.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ms`;
  if (Math.round(ms) < 1000) return `${Math.round(ms).toLocaleString("pt-BR")} ms`;
  return `${(ms / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

/** Percentual com até `digits` casas: "99,95%". */
export function formatPercent(pct: number | null | undefined, digits = 2): string {
  if (pct == null || !Number.isFinite(pct)) return NO_VALUE;
  return `${pct.toLocaleString("pt-BR", { maximumFractionDigits: digits })}%`;
}

/** Disponibilidade em %: só mostra "100%" quando não houve falha nenhuma (99,996 fica "99,99%"). */
export function formatUptime(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return NO_VALUE;
  const rounded = Math.round(pct * 100) / 100;
  return formatPercent(rounded >= 100 && pct < 100 ? 99.99 : rounded);
}

/**
 * true = a medição daqui está pior do que o provedor declara, com os dois lados conhecidos.
 * Manutenção anunciada não conta: o provedor já avisou.
 */
export function isWorseThanOfficial(official: ServiceStatus | null, measured: ServiceStatus | null): boolean {
  if (!official || !measured || official === "UNKNOWN" || measured === "UNKNOWN" || official === "MAINTENANCE") return false;
  return STATUS_SEVERITY[measured] > STATUS_SEVERITY[official];
}
