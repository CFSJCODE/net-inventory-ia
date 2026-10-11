/**
 * Modelo visual dos e-mails do NetInventory (alertas, recuperações e teste). HTML em tabelas com
 * estilos inline, que é o que Gmail, Outlook e os apps de celular renderizam direito, mais uma versão
 * em texto puro para clientes sem HTML. Puro: sem rede nem banco, para ser testado isoladamente.
 */

export type EmailTone = "critical" | "warning" | "ok" | "info";

export interface EmailReading {
  /** "CPU", "Latência média"... */
  label: string;
  /** Valor formatado: "93%", "230 ms". */
  value: string;
  /** Limite formatado: "≥ 90%". */
  limit?: string;
  /** Posição do valor e do limite na barra, de 0 a 1. Sem barra quando ausente. */
  bar?: { value: number; limit: number };
  /** Acima do limite: valor e barra na cor do alerta; senão, verde. */
  bad: boolean;
}

export interface EmailSection {
  title: string;
  /** Medidas com barra (latência, CPU...). */
  readings?: EmailReading[];
  /** Pares rótulo/valor. */
  rows?: [string, string][];
  /** Lista simples. */
  items?: string[];
}

export interface EmailContent {
  tone: EmailTone;
  /** Etiqueta no cabeçalho: "ALERTA", "RECUPERADO", "TESTE". */
  label: string;
  title: string;
  subtitle?: string;
  /** Frase principal, em linguagem simples (também vira o resumo que o Gmail mostra na lista). */
  summary: string;
  sections: EmailSection[];
  /** Parágrafos finais (aviso de e-mail atrasado, intervalo mínimo...). */
  notes?: string[];
}

export interface RenderedEmail {
  html: string;
  text: string;
}

const TONES: Record<EmailTone, { color: string; soft: string }> = {
  critical: { color: "#dc2626", soft: "#fef2f2" },
  warning: { color: "#ea580c", soft: "#fff7ed" },
  ok: { color: "#16a34a", soft: "#f0fdf4" },
  info: { color: "#2563eb", soft: "#eff6ff" },
};

const OK_COLOR = "#16a34a";
const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FOOTER = "Enviado automaticamente pelo NetInventory. Para mudar o destinatário, os limites ou desligar os alertas, abra Configurações → Alertas por e-mail.";

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Barra de 100 colunas: trecho preenchido até o valor e um marcador escuro na posição do limite. */
function renderBar(bar: { value: number; limit: number }, fill: string): string {
  // 100 colunas: 99 no máximo para valor e limite, para sobrar a do marcador.
  const v = Math.min(99, Math.round(clamp01(bar.value) * 100));
  const l = Math.min(99, Math.round(clamp01(bar.limit) * 100));
  const gray = "#e5e7eb";
  const marker = "#374151";
  const segments: [number, string][] =
    v < l ? [[v, fill], [l - v, gray], [1, marker], [99 - l, gray]] : [[l, fill], [1, marker], [v - l, fill], [99 - v, gray]];
  const cells = segments
    .filter(([w]) => w > 0)
    .map(([w, color]) => `<td width="${w}%" style="background:${color};height:8px;line-height:8px;font-size:1px">&nbsp;</td>`)
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>${cells}</tr></table>`;
}

function renderReading(r: EmailReading, toneColor: string): string {
  const color = r.bad ? toneColor : OK_COLOR;
  const limit = r.limit ? `<div style="${FONT};font-size:11px;color:#6b7280;margin-top:2px">limite ${escapeHtml(r.limit)}</div>` : "";
  return `<tr>
<td style="padding:9px 0;border-top:1px solid #f3f4f6;vertical-align:middle;width:40%"><div style="${FONT};font-size:13px;color:#374151">${escapeHtml(r.label)}</div>${limit}</td>
<td style="padding:9px 8px;border-top:1px solid #f3f4f6;vertical-align:middle;white-space:nowrap;${FONT};font-size:18px;font-weight:700;color:${color};width:22%">${escapeHtml(r.value)}</td>
<td style="padding:9px 0;border-top:1px solid #f3f4f6;vertical-align:middle">${r.bar ? renderBar(r.bar, color) : ""}</td>
</tr>`;
}

function renderRow([k, v]: [string, string]): string {
  return `<tr>
<td style="padding:7px 12px 7px 0;border-top:1px solid #f3f4f6;vertical-align:top;width:40%;${FONT};font-size:13px;color:#6b7280">${escapeHtml(k)}</td>
<td style="padding:7px 0;border-top:1px solid #f3f4f6;vertical-align:top;${FONT};font-size:14px;font-weight:600;color:#111827">${escapeHtml(v)}</td>
</tr>`;
}

function renderItem(item: string): string {
  return `<tr>
<td style="padding:4px 8px 4px 0;vertical-align:top;${FONT};font-size:14px;color:#6b7280;width:12px">&#8226;</td>
<td style="padding:4px 0;vertical-align:top;${FONT};font-size:14px;line-height:1.45;color:#111827">${escapeHtml(item)}</td>
</tr>`;
}

function renderSection(s: EmailSection, toneColor: string): string {
  const table = (body: string) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${body}</table>`;
  const parts = [
    s.readings?.length ? table(s.readings.map((r) => renderReading(r, toneColor)).join("")) : "",
    s.rows?.length ? table(s.rows.map(renderRow).join("")) : "",
    s.items?.length ? table(s.items.map(renderItem).join("")) : "",
  ];
  return `<tr><td style="padding:18px 24px 0">
<div style="${FONT};font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#6b7280;padding-bottom:6px;border-bottom:2px solid #e5e7eb">${escapeHtml(s.title)}</div>
${parts.join("")}
</td></tr>`;
}

const hasContent = (s: EmailSection) => !!(s.readings?.length || s.rows?.length || s.items?.length);

function renderHtml(c: EmailContent): string {
  const t = TONES[c.tone];
  const sections = c.sections.filter(hasContent).map((s) => renderSection(s, t.color)).join("");
  const notes = (c.notes ?? [])
    .map((n) => `<tr><td style="padding:14px 24px 0;${FONT};font-size:13px;line-height:1.5;color:#4b5563">${escapeHtml(n)}</td></tr>`)
    .join("");
  const subtitle = c.subtitle ? `<div style="${FONT};font-size:15px;color:#374151;margin-top:4px">${escapeHtml(c.subtitle)}</div>` : "";
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(c.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f3f4f6">${escapeHtml(c.summary)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;border-collapse:separate">
<tr><td style="padding:14px 24px;background:#18181b;border-radius:11px 11px 0 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="${FONT};font-size:15px;font-weight:700;color:#ffffff"><span style="color:#22c55e">&#9679;</span>&nbsp; NetInventory</td>
<td align="right" style="${FONT};font-size:12px;color:#a1a1aa">Alertas de rede</td>
</tr></table>
</td></tr>
<tr><td style="padding:20px 24px 18px;background:${t.soft};border-top:4px solid ${t.color}">
<div style="${FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;color:${t.color}">${escapeHtml(c.label)}</div>
<div style="${FONT};font-size:24px;font-weight:700;line-height:1.2;color:#111827;margin-top:6px">${escapeHtml(c.title)}</div>
${subtitle}
</td></tr>
<tr><td style="padding:20px 24px 2px;${FONT};font-size:15px;line-height:1.55;color:#111827">${escapeHtml(c.summary)}</td></tr>
${sections}
${notes}
<tr><td style="padding:20px 24px 0"></td></tr>
<tr><td style="padding:14px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 11px 11px;${FONT};font-size:12px;line-height:1.5;color:#6b7280">${escapeHtml(FOOTER)}</td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}

function renderText(c: EmailContent): string {
  const out: string[] = [`[NetInventory] ${c.label}`, c.title];
  if (c.subtitle) out.push(c.subtitle);
  out.push("", c.summary);
  for (const s of c.sections.filter(hasContent)) {
    out.push("", s.title.toUpperCase());
    for (const r of s.readings ?? []) out.push(`- ${r.label}: ${r.value}${r.limit ? ` (limite ${r.limit})` : ""}${r.bad ? " [ACIMA DO LIMITE]" : ""}`);
    for (const [k, v] of s.rows ?? []) out.push(`- ${k}: ${v}`);
    for (const item of s.items ?? []) out.push(`- ${item}`);
  }
  for (const n of c.notes ?? []) out.push("", n);
  out.push("", "--", FOOTER);
  return out.join("\n");
}

export function renderEmail(content: EmailContent): RenderedEmail {
  return { html: renderHtml(content), text: renderText(content) };
}
