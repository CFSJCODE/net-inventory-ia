/**
 * Máquina de estados de um alerta (equipamento fora do ar, CPU alta...). Pura, sem banco nem rede, para
 * ser testada isoladamente. Só avisa na transição (OK -> problema e problema -> OK), e só depois de
 * algumas checagens seguidas, para um ping perdido ou um pico de CPU de um segundo não virar e-mail.
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
    // Dentro do intervalo mínimo: o problema fica registrado, mas sem e-mail (nem o de recuperação depois).
    const coolingDown = s.lastAlertAt !== null && now - s.lastAlertAt < opts.cooldownMs;
    s.notified = !coolingDown;
    if (coolingDown) return { state: s, event: null };
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
 * Lê a saída do ping de qualquer idioma (Windows em português, Linux...): cada linha com "TTL=" é uma
 * resposta, e o tempo vem dela ("tempo=3ms", "time=0.4 ms", "tempo<1ms").
 */
export function parsePingOutput(stdout: string, sent: number): PingStats {
  const rtts: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!/ttl[=:]/i.test(line)) continue;
    const m = line.match(/([=<])\s*([\d.,]+)\s*ms/i);
    rtts.push(m ? (m[1] === "<" ? 0 : Number(m[2].replace(",", "."))) : 0);
  }
  const received = Math.min(rtts.length, sent);
  const avgMs = received ? Math.round(rtts.slice(0, received).reduce((a, b) => a + b, 0) / received) : null;
  return { sent, received, avgMs };
}

export const lossPct = (p: PingStats) => (p.sent ? Math.round(((p.sent - p.received) / p.sent) * 100) : 0);
