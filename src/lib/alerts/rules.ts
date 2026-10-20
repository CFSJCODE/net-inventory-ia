/**
 * Máquina de estados de um alerta (equipamento fora do ar, CPU alta...). Pura, sem banco nem rede, para
 * ser testada isoladamente. Permite disparo na primeira leitura anormal, recuperação estabilizada e
 * repetição de problemas persistentes respeitando o intervalo configurado.
 */

export interface CheckState {
  /** Problema confirmado (atingiu as checagens seguidas). */
  active: boolean;
  /** Checagens seguidas com problema / sem problema. */
  bad: number;
  good: number;
  /** O alerta deste problema foi para a fila de e-mail (e então a recuperação também vai). */
  notified: boolean;
  /** Quando o problema foi confirmado. */
  since: number | null;
  /** Último e-mail de alerta desta checagem, para o intervalo mínimo entre alertas. */
  lastAlertAt: number | null;
  /** Último valor lido (latência, %, °C), para o texto do e-mail. */
  value?: number | null;
}

export const EMPTY_STATE: CheckState = { active: false, bad: 0, good: 0, notified: false, since: null, lastAlertAt: null };

export interface RuleOptions {
  /** Checagens seguidas com problema para alertar. */
  badToFire: number;
  /** Checagens seguidas sem problema para considerar recuperado. */
  goodToClear: number;
  /** Intervalo mínimo entre dois alertas da mesma checagem (evita e-mails em série quando o problema oscila). */
  cooldownMs: number;
}

export type RuleEvent = "alert" | "recovery" | null;

export function evaluate(prev: CheckState, isBad: boolean, now: number, opts: RuleOptions): { state: CheckState; event: RuleEvent } {
  const s: CheckState = { ...prev, bad: isBad ? prev.bad + 1 : 0, good: isBad ? 0 : prev.good + 1 };

  if (!s.active && isBad && s.bad >= opts.badToFire) {
    s.active = true;
    s.since = now;
    s.notified = false;
  }

  // Problema confirmado: dispara na primeira leitura anormal e repete somente após o intervalo salvo.
  if (s.active && isBad) {
    const coolingDown = s.lastAlertAt !== null && now - s.lastAlertAt < opts.cooldownMs;
    if (coolingDown) return { state: s, event: null };
    s.notified = true;
    s.lastAlertAt = now;
    return { state: s, event: "alert" };
  }

  if (s.active && !isBad && s.good >= opts.goodToClear) {
    const notified = s.notified;
    s.active = false;
    s.notified = false;
    return { state: s, event: notified ? "recovery" : null };
  }

  return { state: s, event: null };
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}min`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Resultado de uma rodada de ping: respostas recebidas e latência média das respostas. */
export interface PingStats {
  sent: number;
  received: number;
  avgMs: number | null;
}

/**
 * Lê a saída do ping de qualquer idioma (Windows em português, Linux...): uma resposta é a linha com
 * "TTL=" ou com um único tempo ("tempo=3ms", "time=0.4 ms", "tempo<1ms" — o ping IPv6 do Windows não
 * mostra TTL). A linha de estatísticas tem três tempos e por isso não conta.
 */
export function parsePingOutput(stdout: string, sent: number): PingStats {
  const rtts: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const times = Array.from(line.matchAll(/([=<])\s*([\d.,]+)\s*ms/gi));
    if (!/ttl[=:]/i.test(line) && times.length !== 1) continue;
    const m = times[0];
    rtts.push(m ? (m[1] === "<" ? 0 : Number(m[2].replace(",", "."))) : 0);
  }
  const received = Math.min(rtts.length, sent);
  const avgMs = received ? Math.round(rtts.slice(0, received).reduce((a, b) => a + b, 0) / received) : null;
  return { sent, received, avgMs };
}

export const lossPct = (p: PingStats) => (p.sent ? Math.round(((p.sent - p.received) / p.sent) * 100) : 0);
