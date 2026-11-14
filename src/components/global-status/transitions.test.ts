import { describe, expect, it } from "vitest";
import type { LocalConnectivity, ServiceStatus } from "@/lib/global-status/types";
import { INTERNET_CATEGORY, rememberSeen, serviceNotice, transitionNotices, type Notice, type SeenStatus } from "./transitions";

type View = Parameters<typeof transitionNotices>[1];
type ServiceView = View["services"][number];

const NAMES: Record<string, string> = { whatsapp: "WhatsApp", github: "GitHub", netflix: "Netflix", gateway: "Gateway" };

const service = (slug: string, status: ServiceStatus, extra: Partial<ServiceView> = {}): ServiceView => ({
  slug,
  name: NAMES[slug] ?? slug,
  category: "SOCIAL",
  status,
  measuredReason: null,
  officialStatus: null,
  measurementPaused: false,
  ...extra,
});

/** Um serviço como ele vem enquanto as medições dele estão paradas: sem estado medido, com a frase da pausa. */
const paused = (slug: string, status: ServiceStatus = "UNKNOWN"): ServiceView =>
  service(slug, status, { measurementPaused: true, measuredReason: "Medições pausadas: sem Internet neste servidor" });

const view = (state: LocalConnectivity["state"], services: ServiceView[], reason: string | null = null): View => ({ services, connectivity: { state, reason } });

/** Passa as consultas pela página, uma a uma, como o painel faz, e devolve os avisos de cada uma. */
function replay(views: View[]): Notice[][] {
  let seen: SeenStatus | null = null;
  return views.map((data) => {
    const notices = seen ? transitionNotices(seen, data) : [];
    seen = rememberSeen(seen, data);
    return notices;
  });
}

const titles = (rounds: Notice[][]) => rounds.map((notices) => notices.map((notice) => notice.title));

describe("serviceNotice", () => {
  it("queda: aviso de erro, longo, com o motivo medido (ou a frase do provedor)", () => {
    expect(serviceNotice(service("github", "DOWN", { measuredReason: "HTTP: 3 falhas seguidas" }), "OK")).toEqual({ tone: "error", title: "GitHub: fora do ar", description: "HTTP: 3 falhas seguidas", long: true });
    expect(serviceNotice(service("github", "DOWN", { officialStatus: "Major outage" }), "DEGRADED")).toEqual({ tone: "error", title: "GitHub: fora do ar", description: "Major outage", long: true });
    expect(serviceNotice(service("github", "DOWN"), "OK")?.description).toBeUndefined();
  });

  it("degradação só é notícia a partir do normal", () => {
    expect(serviceNotice(service("github", "DEGRADED", { measuredReason: "latência 4× a habitual" }), "OK")).toEqual({ tone: "warning", title: "GitHub: degradado", description: "latência 4× a habitual" });
    // De fora do ar para degradado é melhora parcial, e de manutenção para degradado não é queda: nenhum aviso.
    expect(serviceNotice(service("github", "DEGRADED"), "DOWN")).toBeNull();
    expect(serviceNotice(service("github", "DEGRADED"), "MAINTENANCE")).toBeNull();
  });

  it("volta ao normal: aviso de sucesso, sem descrição", () => {
    for (const was of ["DOWN", "DEGRADED", "MAINTENANCE"] as const) {
      expect(serviceNotice(service("github", "OK", { measuredReason: "sobra de antes" }), was)).toEqual({ tone: "success", title: "GitHub: normalizado" });
    }
  });

  it("primeira vez que o serviço aparece, estado igual e \"Sem dados\" não são notícia", () => {
    expect(serviceNotice(service("github", "DOWN"), undefined)).toBeNull();
    expect(serviceNotice(service("github", "DOWN"), "DOWN")).toBeNull();
    expect(serviceNotice(service("github", "UNKNOWN"), "OK")).toBeNull();
    expect(serviceNotice(service("github", "DOWN"), "UNKNOWN")).toBeNull();
    expect(serviceNotice(service("github", "MAINTENANCE"), "OK")).toBeNull();
  });
});

describe("transitionNotices e rememberSeen: a página de consulta em consulta", () => {
  it("a primeira consulta nunca avisa, nem com serviço fora do ar ou sem Internet", () => {
    expect(titles(replay([view("ok", [service("github", "DOWN")])]))).toEqual([[]]);
    expect(titles(replay([view("offline", [paused("github")], "O gateway 192.168.0.1 não responde.")]))).toEqual([[]]);
  });

  it("queda e volta de um serviço com a conexão boa: um aviso de cada", () => {
    const rounds = replay([
      view("ok", [service("whatsapp", "OK")]),
      view("ok", [service("whatsapp", "DOWN", { measuredReason: "TCP 443: 3 falhas seguidas" })]),
      view("ok", [service("whatsapp", "DOWN", { measuredReason: "TCP 443: 3 falhas seguidas" })]),
      view("ok", [service("whatsapp", "OK")]),
      view("ok", [service("whatsapp", "OK")]),
    ]);
    expect(titles(rounds)).toEqual([[], ["WhatsApp: fora do ar"], [], ["WhatsApp: normalizado"], []]);
    expect(rounds[1][0]).toEqual({ tone: "error", title: "WhatsApp: fora do ar", description: "TCP 443: 3 falhas seguidas", long: true });
  });

  it("a conexão cai e volta: só os avisos da conexão; os serviços pausados não viram notícia", () => {
    const rounds = replay([
      view("ok", [service("whatsapp", "OK"), service("github", "OK")]),
      view("offline", [paused("whatsapp"), paused("github")], "O gateway 192.168.0.1 não responde."),
      view("offline", [paused("whatsapp"), paused("github")], "O gateway 192.168.0.1 não responde."),
      // Voltou, mas nenhum serviço foi medido de novo ainda.
      view("ok", [paused("whatsapp"), paused("github")]),
      view("ok", [service("whatsapp", "OK"), service("github", "OK")]),
    ]);
    expect(titles(rounds)).toEqual([[], ["Sua Internet está fora"], [], ["Sua Internet voltou"], []]);
    expect(rounds[1][0]).toEqual({ tone: "error", title: "Sua Internet está fora", description: "O gateway 192.168.0.1 não responde.", long: true });
    expect(rounds[3][0]).toEqual({ tone: "success", title: "Sua Internet voltou" });
  });

  it("uma queda que começou durante a falta de Internet é anunciada quando o serviço é medido de novo", () => {
    const rounds = replay([
      view("ok", [service("whatsapp", "OK")]),
      view("offline", [paused("whatsapp")]),
      view("ok", [paused("whatsapp")]),
      view("ok", [paused("whatsapp")]),
      view("ok", [service("whatsapp", "DOWN", { measuredReason: "TCP 443: 3 falhas seguidas" })]),
      view("ok", [service("whatsapp", "DOWN", { measuredReason: "TCP 443: 3 falhas seguidas" })]),
    ]);
    expect(titles(rounds)).toEqual([[], ["Sua Internet está fora"], ["Sua Internet voltou"], [], ["WhatsApp: fora do ar"], []]);
  });

  it("uma queda já anunciada antes da falta de Internet não é anunciada de novo depois", () => {
    const rounds = replay([
      view("ok", [service("github", "OK")]),
      view("ok", [service("github", "DOWN")]),
      view("offline", [paused("github")]),
      view("ok", [paused("github")]),
      view("ok", [service("github", "DOWN")]),
    ]);
    expect(titles(rounds)).toEqual([[], ["GitHub: fora do ar"], ["Sua Internet está fora"], ["Sua Internet voltou"], []]);
  });

  it("um serviço que estava fora antes da queda da conexão e volta bom depois: \"normalizado\" uma vez", () => {
    const rounds = replay([
      view("ok", [service("github", "DOWN")]),
      view("offline", [paused("github")]),
      view("ok", [paused("github")]),
      view("ok", [service("github", "OK")]),
      view("ok", [service("github", "OK")]),
    ]);
    expect(titles(rounds)).toEqual([[], ["Sua Internet está fora"], ["Sua Internet voltou"], ["GitHub: normalizado"], []]);
  });

  it("com fonte oficial, o card pausado mostra o status do provedor: isso não vira aviso nem muda o que a página lembra", () => {
    const rounds = replay([
      // Medido fora do ar, provedor dizendo que está normal: o card está "fora do ar".
      view("ok", [service("github", "DOWN", { measuredReason: "HTTP: 3 falhas seguidas", officialStatus: "All Systems Operational" })]),
      // Sem Internet o estado medido some e sobra o oficial: o card passa a "OK" sem que nada tenha melhorado.
      view("offline", [paused("github", "OK")]),
      view("ok", [paused("github", "OK")]),
      // Medido de novo, continua fora: não é queda nova.
      view("ok", [service("github", "DOWN", { measuredReason: "HTTP: 3 falhas seguidas" })]),
    ]);
    expect(titles(rounds)).toEqual([[], ["Sua Internet está fora"], ["Sua Internet voltou"], []]);
  });

  it("cada serviço é comparado quando ele mesmo volta a ser medido", () => {
    const rounds = replay([
      view("ok", [service("whatsapp", "OK"), service("netflix", "OK")]),
      view("offline", [paused("whatsapp"), paused("netflix")]),
      // O WhatsApp já foi medido de novo (e caiu); a Netflix ainda está parada.
      view("ok", [service("whatsapp", "DOWN"), paused("netflix")]),
      view("ok", [service("whatsapp", "DOWN"), service("netflix", "DEGRADED", { measuredReason: "latência 5× a habitual" })]),
    ]);
    expect(titles(rounds)).toEqual([[], ["Sua Internet está fora"], ["Sua Internet voltou", "WhatsApp: fora do ar"], ["Netflix: degradado"]]);
  });

  it("página aberta durante a falta de Internet: avisa a volta e não inventa queda de serviço", () => {
    const rounds = replay([
      view("offline", [paused("whatsapp"), paused("github", "DEGRADED")]),
      view("ok", [paused("whatsapp"), paused("github", "DEGRADED")]),
      // Primeiro julgamento que a página vê de cada um: não há estado anterior para comparar.
      view("ok", [service("whatsapp", "DOWN"), service("github", "OK")]),
      view("ok", [service("whatsapp", "OK"), service("github", "OK")]),
    ]);
    expect(titles(rounds)).toEqual([[], ["Sua Internet voltou"], [], ["WhatsApp: normalizado"]]);
  });

  it("o DNS do servidor fora conta como conexão fora: o aviso sai uma vez, mesmo trocando de motivo", () => {
    const rounds = replay([
      view("ok", [service("whatsapp", "OK")]),
      view("dns", [paused("whatsapp")], "O DNS deste servidor não está resolvendo nomes."),
      view("offline", [paused("whatsapp")], "O gateway 192.168.0.1 não responde."),
      view("ok", [service("whatsapp", "OK")]),
    ]);
    expect(titles(rounds)).toEqual([[], ["Sua Internet está fora"], [], ["Sua Internet voltou"]]);
    expect(rounds[1][0].description).toBe("O DNS deste servidor não está resolvendo nomes.");
  });

  it("sem motivo informado, o aviso da conexão sai sem descrição", () => {
    const [, [notice]] = replay([view("ok", []), view("offline", [])]);
    expect(notice).toEqual({ tone: "error", title: "Sua Internet está fora", description: undefined, long: true });
  });

  it("os serviços da faixa \"Sua Internet\" nunca viram aviso de serviço", () => {
    const internet = (status: ServiceStatus) => service("gateway", status, { category: INTERNET_CATEGORY });
    const rounds = replay([view("ok", [internet("OK")]), view("ok", [internet("DOWN")]), view("ok", [internet("OK")])]);
    expect(titles(rounds)).toEqual([[], [], []]);
  });

  it("um serviço que entra na lista depois não avisa na primeira vez que aparece", () => {
    const rounds = replay([view("ok", [service("github", "OK")]), view("ok", [service("github", "OK"), service("netflix", "DOWN")]), view("ok", [service("github", "OK"), service("netflix", "OK")])]);
    expect(titles(rounds)).toEqual([[], [], ["Netflix: normalizado"]]);
  });

  it("\"Sem dados\" no meio do caminho não é notícia nem apaga o que a página lembra", () => {
    // Uma consulta sem veredito nenhum (nem oficial, nem medido) entre o normal e a queda.
    const fell = replay([view("ok", [service("github", "OK")]), view("ok", [service("github", "UNKNOWN")]), view("ok", [service("github", "DOWN")])]);
    expect(titles(fell)).toEqual([[], [], ["GitHub: fora do ar"]]);

    const stillDown = replay([view("ok", [service("github", "OK")]), view("ok", [service("github", "DOWN")]), view("ok", [service("github", "UNKNOWN")]), view("ok", [service("github", "DOWN")])]);
    expect(titles(stillDown)).toEqual([[], ["GitHub: fora do ar"], [], []]);

    const recovered = replay([view("ok", [service("github", "DOWN")]), view("ok", [service("github", "UNKNOWN")]), view("ok", [service("github", "UNKNOWN")]), view("ok", [service("github", "OK")])]);
    expect(titles(recovered)).toEqual([[], [], [], ["GitHub: normalizado"]]);
  });

  it("página aberta com tudo ainda \"Verificando\": o primeiro estado de cada serviço não é notícia", () => {
    const rounds = replay([view("ok", [service("github", "UNKNOWN"), service("netflix", "UNKNOWN")]), view("ok", [service("github", "DOWN"), service("netflix", "OK")]), view("ok", [service("github", "OK"), service("netflix", "OK")])]);
    expect(titles(rounds)).toEqual([[], [], ["GitHub: normalizado"]]);
  });
});

describe("rememberSeen", () => {
  const seenOf = (seen: SeenStatus) => ({ connection: seen.connection, states: Object.fromEntries(seen.states) });

  it("com a conexão boa lembra o estado de cada serviço medido", () => {
    expect(seenOf(rememberSeen(null, view("ok", [service("github", "OK"), service("netflix", "DOWN")])))).toEqual({ connection: "ok", states: { github: "OK", netflix: "DOWN" } });
  });

  it("com a conexão fora mantém os estados de antes, sem copiar a lista", () => {
    const before = rememberSeen(null, view("ok", [service("github", "DOWN")]));
    const during = rememberSeen(before, view("offline", [paused("github", "OK")]));
    expect(seenOf(during)).toEqual({ connection: "offline", states: { github: "DOWN" } });
    expect(seenOf(rememberSeen(null, view("dns", [paused("github")])))).toEqual({ connection: "dns", states: {} });
  });

  it("depois da volta, o serviço ainda pausado fica com o estado de antes; o já medido, com o novo", () => {
    const before: SeenStatus = { connection: "offline", states: new Map<string, ServiceStatus>([["github", "DOWN"], ["netflix", "OK"]]) };
    const after = rememberSeen(before, view("ok", [paused("github", "OK"), service("netflix", "DEGRADED"), paused("whatsapp")]));
    // O WhatsApp nunca tinha sido visto medido: nada a lembrar dele ainda.
    expect(seenOf(after)).toEqual({ connection: "ok", states: { github: "DOWN", netflix: "DEGRADED" } });
  });

  it("\"Sem dados\" não é um estado a lembrar: fica o último conhecido, ou nada", () => {
    const before = rememberSeen(null, view("ok", [service("github", "DOWN")]));
    expect(seenOf(rememberSeen(before, view("ok", [service("github", "UNKNOWN"), service("netflix", "UNKNOWN")])))).toEqual({ connection: "ok", states: { github: "DOWN" } });
  });

  it("um serviço que saiu da lista é esquecido", () => {
    const before = rememberSeen(null, view("ok", [service("github", "OK"), service("netflix", "OK")]));
    expect(seenOf(rememberSeen(before, view("ok", [service("github", "OK")])))).toEqual({ connection: "ok", states: { github: "OK" } });
  });
});
