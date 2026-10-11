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
