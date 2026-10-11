/** Envio pela API HTTP do Resend (https://resend.com/docs/api-reference/emails/send-email), sem SDK. */

export interface OutgoingEmail {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}

const ENDPOINT = "https://api.resend.com/emails";

export async function sendResendEmail(apiKey: string, email: OutgoingEmail): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(email),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Não foi possível falar com o Resend (sem internet?): ${cause}`);
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!res.ok) {
    const msg = body.message || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      // O caso mais comum: remetente onboarding@resend.dev para um e-mail que não é o dono da conta.
      throw new Error(`O Resend recusou o envio: ${msg}`);
    }
    throw new Error(`Falha no Resend: ${msg}`);
  }
  return body.id ?? "";
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Corpo HTML simples (tabela de detalhes), legível em qualquer cliente de e-mail. */
export function renderEmail(opts: { title: string; color: string; lines: [string, string][]; footer?: string }): { html: string; text: string } {
  const rows = opts.lines
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`)
    .join("");
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
<h2 style="margin:0 0 12px;color:${opts.color}">${esc(opts.title)}</h2>
<table style="border-collapse:collapse">${rows}</table>
<p style="margin-top:16px;color:#888;font-size:12px">${esc(opts.footer ?? "Enviado pelo NetInventory.")}</p>
</div>`;
  const text = [opts.title, "", ...opts.lines.map(([k, v]) => `${k}: ${v}`), "", opts.footer ?? "Enviado pelo NetInventory."].join("\n");
  return { html, text };
}
