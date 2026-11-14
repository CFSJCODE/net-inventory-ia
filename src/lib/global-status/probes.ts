import type { ProbeResult, ProbeSpec } from "./types";

/**
 * Sondas de medição própria: HTTP(S) com os tempos de cada etapa, handshake TCP, ping ICMP, DNS e
 * certificado TLS. Nenhuma função rejeita: falha vira `{ ok: false, error }`.
 *
 * ESQUELETO: as assinaturas abaixo são o contrato usado pelo agendador; a implementação entra nesta fase.
 */

/** Tempo máximo de uma medição HTTP/TLS (plano aprovado: 10 s). */
export const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeOptions {
  timeoutMs?: number;
}

export interface PingStats {
  /** Respostas recebidas. */
  received: number;
  /** RTT de cada resposta, em ms, na ordem. */
  rtts: number[];
  lossPct: number;
  avgMs: number | null;
  jitterMs: number | null;
}

const todo = (name: string): never => {
  throw new Error(`${name}: não implementado`);
};

/** GET sem seguir redirecionamento; mede DNS, TCP, TLS e espera do servidor. "No ar" = qualquer resposta HTTP abaixo de 500. */
export function probeHttp(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  void url; void options;
  return todo("probeHttp");
}

/** Tempo do handshake TCP (um round-trip): a melhor estimativa da latência de rede onde ICMP é bloqueado. */
export function probeTcp(host: string, port: number, options: ProbeOptions = {}): Promise<ProbeResult> {
  void host; void port; void options;
  return todo("probeTcp");
}

/** Handshake TLS e validade do certificado (dias restantes e cadeia válida). */
export function probeTls(host: string, port = 443, options: ProbeOptions = {}): Promise<ProbeResult> {
  void host; void port; void options;
  return todo("probeTls");
}

/** Tempo de resolução de `name` (registro A) em `server` ("auto:system" = resolvedores do sistema). */
export function probeDns(server: string, name: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  void server; void name; void options;
  return todo("probeDns");
}

/** Ping do sistema (5 pacotes por padrão): RTT médio, perda e jitter. Sem binário de ping devolve `unsupported`. */
export function probeIcmp(host: string, options: ProbeOptions & { count?: number } = {}): Promise<ProbeResult> {
  void host; void options;
  return todo("probeIcmp");
}

/** Interpreta a saída do ping do Linux ou do Windows, em qualquer idioma; `sent` = pacotes enviados. */
export function parsePingOutput(stdout: string, sent: number): PingStats {
  void stdout; void sent;
  return todo("parsePingOutput");
}

/** IP do gateway padrão (cache de 5 min); null quando não dá para descobrir. */
export function defaultGateway(): Promise<string | null> {
  return todo("defaultGateway");
}

/** Executa a sonda do tipo do alvo, resolvendo "auto:gateway"/"auto:system". Nunca rejeita. */
export function runProbe(spec: ProbeSpec): Promise<ProbeResult> {
  void spec;
  return todo("runProbe");
}
