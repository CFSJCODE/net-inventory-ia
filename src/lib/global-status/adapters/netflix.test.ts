import { describe, expect, it } from "vitest";
import { htmlText, NETFLIX_PAGE_URL, parseNetflixNotifications } from "./netflix";

const now = new Date("2026-11-15T22:00:00Z");

describe("Netflix: leitor dos avisos", () => {
  it("lista vazia é a Netflix funcionando, sem incidentes", () => {
    expect(parseNetflixNotifications([], now)).toEqual({ status: "OK", description: "A Netflix está funcionando", components: null, incidents: [] });
  });

  it("ignora avisos que não são de queda e os alertas da conta", () => {
    const data = [
      { type: "NOTIFICATION", notificationId: 1, downNotification: false, cannedMessage: "<h1>Novidade</h1>" },
      { type: "UMS_ALERT", notificationId: 2, downNotification: true, cannedMessage: "<h1>Atualize o pagamento</h1>" },
    ];
    expect(parseNetflixNotifications(data, now).status).toBe("OK");
  });

  it("aviso de queda com nível de erro deixa fora do ar, com título e texto do HTML", () => {
    const snap = parseNetflixNotifications(
      [{ type: "NOTIFICATION", notificationId: 42, level: "ERROR", downNotification: true, cannedMessage: '<div><h1 class="x">Instabilidade no <b>streaming</b></h1><p>Estamos trabalhando &amp; voltamos logo.</p></div>' }],
      now,
    );
    expect(snap.status).toBe("DOWN");
    expect(snap.description).toBe("Instabilidade no streaming");
    expect(snap.incidents).toEqual([
      { externalId: "42", title: "Instabilidade no streaming", impact: "MAJOR", state: "investigating", url: NETFLIX_PAGE_URL, affected: "Estamos trabalhando & voltamos logo.", startedAt: now, resolvedAt: null },
    ]);
  });

  it("aviso de queda com outro nível deixa degradado", () => {
    const snap = parseNetflixNotifications([{ notificationId: "a", level: "WARNING", downNotification: true, cannedMessage: "Alguns aparelhos com erro" }], now);
    expect(snap.status).toBe("DEGRADED");
    expect(snap.incidents[0]).toMatchObject({ title: "Alguns aparelhos com erro", impact: "MINOR", affected: null });
  });

  it("resposta que não é lista é erro (a fonte fica sem dados)", () => {
    expect(() => parseNetflixNotifications({ error: "x" }, now)).toThrow(/Netflix/);
  });

  it("htmlText tira tags e decodifica entidades", () => {
    expect(htmlText("A&nbsp;<i>B</i><br/>C &#233; &#x41;")).toBe("A B C é A");
  });
});
