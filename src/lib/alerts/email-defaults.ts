/**
 * Tipos e valores padrão dos alertas por e-mail. Sem imports de servidor: é usado também no
 * navegador (tela de Configurações); a leitura/gravação no banco fica em email-settings.ts.
 */

export interface AlertThresholds {
  cpuPct: number;
  memPct: number;
  tempC: number;
  /** Latência média acima disso = desempenho degradado. */
  latencyMs: number;
  /** Latência acima disso é tratada como crítica no modo crítico. */
  criticalLatencyMs: number;
  /** Perda de pacotes a partir disso = desempenho degradado. */
  lossPct: number;
}

export interface EmailAlertSettings {
  enabled: boolean;
  from: string;
  to: string;
  /** IPs (ou nomes) vigiados: fora do ar e desempenho degradado. */
  targets: string[];
  thresholds: AlertThresholds;
  /** Todas as métricas que excedam limites, ou somente problemas críticos. */
  mode: "all" | "critical";
  /** Intervalo mínimo antes de repetir um alerta persistente. */
  cooldownMinutes: number;
}

/** Remetente de testes do Resend: funciona sem domínio próprio, mas só entrega no e-mail do dono da conta Resend. */
export const DEFAULT_FROM = "NetInventory <onboarding@resend.dev>";

export const DEFAULT_SETTINGS: EmailAlertSettings = {
  enabled: false,
  from: DEFAULT_FROM,
  to: "",
  targets: ["192.168.0.1", "192.168.0.2", "192.168.0.3"],
  thresholds: { cpuPct: 90, memPct: 90, tempC: 80, latencyMs: 100, criticalLatencyMs: 500, lossPct: 25 },
  mode: "all",
  cooldownMinutes: 15,
};
