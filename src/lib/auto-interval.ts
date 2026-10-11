/** Opções de repetição automática, as mesmas no scan da rede (Configurações) e na leitura dos equipamentos. */
export const AUTO_INTERVALS = { off: "Desligado", "5": "A cada 5 minutos", "15": "A cada 15 minutos", "30": "A cada 30 minutos", "60": "A cada 1 hora" };
export type AutoIntervalKey = keyof typeof AUTO_INTERVALS;

/** Intervalos aceitos (minutos); null = desligado. */
export const ALLOWED_INTERVAL_MINUTES = [5, 15, 30, 60];

export function intervalKey(minutes: number | null | undefined): AutoIntervalKey {
  return minutes && ALLOWED_INTERVAL_MINUTES.includes(minutes) ? (String(minutes) as AutoIntervalKey) : "off";
}

export function intervalMinutes(key: AutoIntervalKey): number | null {
  return key === "off" ? null : Number(key);
}
