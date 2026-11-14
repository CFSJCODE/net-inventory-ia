import type { LocalConnectivity } from "./types";

/**
 * Agendador das medições próprias: decide o que medir a cada instante, grava as medições, resume em
 * janelas de 5 min, limpa o histórico e calcula o status medido de cada serviço.
 *
 * ESQUELETO: as assinaturas abaixo são o contrato usado pelo coletor, pelas actions e pelo instrumentation.
 */

/** Intervalo do agendador: a cada passo mede só os alvos que venceram. */
export const PROBE_TICK_MS = 5_000;
/** Sondas simultâneas, no máximo. */
export const PROBE_CONCURRENCY = 8;

/** Inicia o agendador (uma vez por processo, via instrumentation). `GLOBAL_STATUS_PROBES=off` desliga. */
export function startProbeRunner(): void {
  throw new Error("startProbeRunner: não implementado");
}

/** Mede todos os alvos habilitados agora, ignorando a agenda ("Atualizar agora"). */
export function runProbesNow(): Promise<void> {
  throw new Error("runProbesNow: não implementado");
}

/** Estado da conexão do próprio servidor, para a faixa "Sua Internet". */
export function getLocalConnectivity(): LocalConnectivity {
  return { state: "ok", since: null, reason: null };
}
