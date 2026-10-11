import { describe, expect, it } from "vitest";
import { renderEmail, type EmailContent } from "./email-template";

const base: EmailContent = {
  tone: "critical",
  label: "ALERTA",
  title: "Fora do ar",
  subtitle: "Modem (192.168.0.1)",
  summary: "O modem <não> respondeu.",
  sections: [
    { title: "Leituras atuais", readings: [{ label: "CPU", value: "93%", limit: "≥ 90%", bar: { value: 0.93, limit: 0.9 }, bad: true }], rows: [["Status", "No ar"]] },
    { title: "Vazia" },
    { title: "O que você vai receber", items: ["🔴 Fora do ar"] },
  ],
  notes: ["Você receberá outro e-mail quando o problema passar."],
};

describe("renderEmail", () => {
  it("monta o HTML com cabeçalho, seções e rodapé, escapando o conteúdo", () => {
    const { html } = renderEmail(base);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("NetInventory");
    expect(html).toContain(">ALERTA<");
    expect(html).toContain(">Fora do ar<");
    expect(html).toContain("Modem (192.168.0.1)");
    expect(html).toContain("O modem &lt;não&gt; respondeu.");
    expect(html).not.toContain("<não>");
    expect(html).toContain(">Leituras atuais<");
    expect(html).toContain(">93%<");
    expect(html).toContain("limite ≥ 90%");
    expect(html).toContain("🔴 Fora do ar");
    expect(html).toContain("Configurações → Alertas por e-mail");
    // Seção sem conteúdo não aparece.
    expect(html).not.toContain(">Vazia<");
  });

  it("usa a cor do tom na faixa do título e no valor acima do limite; verde no valor normal", () => {
    const { html } = renderEmail(base);
    expect(html).toContain("border-top:4px solid #dc2626");
    expect(html).toContain("color:#dc2626;width:22%\">93%");
    const ok = renderEmail({ ...base, tone: "ok", sections: [{ title: "L", readings: [{ label: "CPU", value: "40%", bar: { value: 0.4, limit: 0.9 }, bad: false }] }] });
    expect(ok.html).toContain("border-top:4px solid #16a34a");
    expect(ok.html).toContain("color:#16a34a;width:22%\">40%");
  });

  it("desenha a barra com o marcador do limite, dos dois lados do valor", () => {
    const over = renderEmail({ ...base, sections: [{ title: "L", readings: [{ label: "CPU", value: "93%", bar: { value: 0.93, limit: 0.9 }, bad: true }] }] }).html;
    expect(over).toContain('<td width="90%" style="background:#dc2626');
    expect(over).toContain('<td width="1%" style="background:#374151');
    expect(over).toContain('<td width="3%" style="background:#dc2626');
    expect(over).toContain('<td width="6%" style="background:#e5e7eb');
    const under = renderEmail({ ...base, sections: [{ title: "L", readings: [{ label: "CPU", value: "40%", bar: { value: 0.4, limit: 0.9 }, bad: false }] }] }).html;
    expect(under).toContain('<td width="40%" style="background:#16a34a');
    expect(under).toContain('<td width="50%" style="background:#e5e7eb');
    expect(under).toContain('<td width="9%" style="background:#e5e7eb');
    // Valores fora de 0..1 não quebram a barra.
    const clamped = renderEmail({ ...base, sections: [{ title: "L", readings: [{ label: "x", value: "x", bar: { value: 7, limit: -1 }, bad: true }] }] }).html;
    expect(clamped).toContain('<td width="99%" style="background:#dc2626');
    expect(clamped).not.toContain('width="-');
  });

  it("gera a versão em texto com as mesmas seções", () => {
    const { text } = renderEmail(base);
    expect(text).toBe(
      [
        "[NetInventory] ALERTA",
        "Fora do ar",
        "Modem (192.168.0.1)",
        "",
        "O modem <não> respondeu.",
        "",
        "LEITURAS ATUAIS",
        "- CPU: 93% (limite ≥ 90%) [ACIMA DO LIMITE]",
        "- Status: No ar",
        "",
        "O QUE VOCÊ VAI RECEBER",
        "- 🔴 Fora do ar",
        "",
        "Você receberá outro e-mail quando o problema passar.",
        "",
        "--",
        "Enviado automaticamente pelo NetInventory. Para mudar o destinatário, os limites ou desligar os alertas, abra Configurações → Alertas por e-mail.",
      ].join("\n"),
    );
  });
});
