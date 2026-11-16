import type { LocalConnectivity, ServiceStatus } from "./types";

/**
 * Diagnóstico do painel "Status global": em vez de N cards amarelos soltos, agrupa os serviços fora do
 * normal pela causa provável e diz onde ela está (na sua rede, no acesso à Internet, fora da sua rede,
 * no próprio provedor ou só naquele serviço), quantos serviços ela explica e se dá para fazer algo.
 *
 * As regras, na ordem em que um serviço é atribuído (o primeiro grupo que o explica fica com ele):
 * 1. Sem conexão (faixa "Sua Internet" fora): tudo é efeito da queda local.
 * 2. Rede local degradada (gateway ou DNS do sistema): o que só a medição daqui viu vai para a rede local.
 * 3. O provedor publicou incidente ou estado degradado: problema dele, confirmado.
 * 4. A rota até o serviço mudou (incidente de rota aberto): a lentidão vem do caminho novo, não do serviço.
 * 5. Muitos serviços medidos fora do normal ao mesmo tempo, espalhados por vários lugares, com a rede
 *    local normal: o gargalo está entre o roteador e a Internet (link cheio ou operadora).
 * 6. Dois ou mais atendidos pela mesma saída internacional ou pelo mesmo PoP de CDN: problema nesse lugar.
 * 7. O resto: só aquele serviço.
 *
 * Pura: o painel chama com o que já tem na tela.
 */

export type CauseScope = "LOCAL" | "ACCESS" | "UPSTREAM" | "PROVIDER" | "SERVICE";

export interface DiagnosisService {
  slug: string;
  name: string;
  category: string;
  status: ServiceStatus;
  officialState: ServiceStatus | null;
  measuredStatus: ServiceStatus | null;
  measuredReason: string | null;
  measurementPaused?: boolean;
}

export interface DiagnosisIncident {
  origin: string;
  serviceSlug: string;
  title: string;
}

export interface DiagnosisPlace {
  label: string;
  kind: string;
  services: { slug: string }[];
}

export interface CauseGroup {
  scope: CauseScope;
  /** Título curto da causa ("Saída Embratel → Miami", "Rota mudou"). */
  label: string;
  /** Por que estes serviços estão juntos. */
  detail: string;
  /** O que fazer; null quando não há nada ao alcance de quem olha o painel. */
  action: string | null;
  services: { slug: string; name: string; status: ServiceStatus }[];
}

export interface Diagnosis {
  /** Serviços (provedores) fora do normal agora. */
  affected: number;
  /** Frase do topo; null com tudo normal. */
  headline: string | null;
  /** Onde está a causa principal (a do grupo mais abrangente na ordem LOCAL > ACCESS > UPSTREAM > PROVIDER > SERVICE). */
  scope: CauseScope | null;
  groups: CauseGroup[];
}

/** Serviços medidos fora do normal juntos, no mínimo, para apontar o acesso à Internet. */
export const ACCESS_MIN_SERVICES = 5;
/** Fração mínima dos serviços medidos que precisam estar fora do normal para apontar o acesso. */
export const ACCESS_MIN_SHARE = 0.4;
/** Lugares diferentes (saídas, PoPs) entre os afetados para não ser culpa de um lugar só. */
export const ACCESS_MIN_PLACES = 3;

export const SCOPE_LABEL: Record<CauseScope, string> = {
  LOCAL: "Na sua rede",
  ACCESS: "No acesso à Internet",
  UPSTREAM: "Fora da sua rede",
  PROVIDER: "No provedor",
  SERVICE: "Só no serviço",
};

const SCOPE_ORDER: CauseScope[] = ["LOCAL", "ACCESS", "UPSTREAM", "PROVIDER", "SERVICE"];
const LOCAL_SLUG = "rede-local";
const bad = (s: ServiceStatus | null | undefined) => s === "DEGRADED" || s === "DOWN";
const isProvider = (s: { category: string }) => s.category !== "INTERNET" && s.category !== "REGIONAL";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function diagnose(input: {
  services: readonly DiagnosisService[];
  connectivity: LocalConnectivity;
  incidents?: readonly DiagnosisIncident[];
  places?: readonly DiagnosisPlace[] | null;
}): Diagnosis {
  const providers = input.services.filter(isProvider);
  const affected = providers.filter((s) => bad(s.status));
  if (!affected.length) return { affected: 0, headline: null, scope: null, groups: [] };

  const groups: CauseGroup[] = [];
  const left = new Map(affected.map((s) => [s.slug, s]));
  const take = (pick: (s: DiagnosisService) => boolean) => {
    const out = [...left.values()].filter(pick);
    for (const s of out) left.delete(s.slug);
    return out.map((s) => ({ slug: s.slug, name: s.name, status: s.status }));
  };
  const push = (g: Omit<CauseGroup, "services">, services: CauseGroup["services"]) => {
    if (services.length) groups.push({ ...g, services });
  };

  // 1. Sem conexão: as medições estão paradas e o que aparece é o estado oficial; nada é culpa da rede.
  if (input.connectivity.state !== "ok") {
    const why = input.connectivity.reason ?? (input.connectivity.state === "dns" ? "O DNS deste servidor não resolve nomes." : "Este servidor não alcança a Internet.");
    push({ scope: "LOCAL", label: input.connectivity.state === "dns" ? "DNS deste servidor" : "Conexão deste servidor", detail: why, action: "Confira o roteador, o cabo ou Wi-Fi e o DNS configurado; os serviços abaixo podem estar normais." }, take(() => true));
  }

  // 2. Rede local degradada: o que só foi visto daqui (o provedor não confirma) é efeito dela.
  const local = input.services.find((s) => s.slug === LOCAL_SLUG);
  if (local && bad(local.measuredStatus)) {
    push(
      {
        scope: "LOCAL",
        label: "Rede local",
        detail: `A rede local deste servidor está ${local.measuredStatus === "DOWN" ? "fora" : "degradada"}${local.measuredReason ? ` (${local.measuredReason})` : ""}: a lentidão dos serviços vem daqui.`,
        action: "Verifique o roteador, o switch e o cabo ou Wi-Fi até o servidor.",
      },
      take((s) => !bad(s.officialState)),
    );
  }

  // 3. O provedor confirmou.
  for (const s of [...left.values()].filter((x) => bad(x.officialState))) {
    push({ scope: "PROVIDER", label: s.name, detail: "O próprio provedor publicou problema na página de status.", action: null }, take((x) => x.slug === s.slug));
  }

  // 4. Rota mudou.
  const routed = new Map<string, string>();
  for (const i of input.incidents ?? []) if (i.origin === "ROUTE" && !routed.has(i.serviceSlug)) routed.set(i.serviceSlug, i.title);
  const rerouted = take((s) => routed.has(s.slug));
  if (rerouted.length) {
    const abroad = rerouted.some((s) => /→ fora do Brasil/.test(routed.get(s.slug) ?? ""));
    push(
      {
        scope: "UPSTREAM",
        label: abroad ? "Rota passou a sair do Brasil" : "Rota mudou",
        detail: abroad
          ? "O caminho até estes serviços passou a atravessar um cabo internacional: a latência maior vem da distância, não de falha do serviço."
          : "O caminho até estes serviços mudou há pouco; a diferença de latência acompanha a rota nova.",
        action: null,
      },
      rerouted,
    );
  }

  // 5. Acesso à Internet: muitos lentos ao mesmo tempo, espalhados, com a rede local normal.
  const measured = providers.filter((s) => s.measuredStatus && s.measuredStatus !== "UNKNOWN" && !s.measurementPaused);
  const measuredBad = [...left.values()].filter((s) => bad(s.measuredStatus));
  const placeOf = placeIndex(input.places);
  const spread = new Set(measuredBad.map((s) => placeOf.get(s.slug) ?? `?${s.slug}`)).size;
  if (measuredBad.length >= ACCESS_MIN_SERVICES && measuredBad.length >= measured.length * ACCESS_MIN_SHARE && spread >= ACCESS_MIN_PLACES) {
    const dnsBad = input.services.filter((s) => s.category === "INTERNET" && s.slug !== LOCAL_SLUG && bad(s.measuredStatus)).length;
    push(
      {
        scope: "ACCESS",
        label: "Link ou operadora",
        detail: `${plural(measuredBad.length, "serviço", "serviços")} de ${measured.length} medidos ficaram fora do normal juntos, por caminhos diferentes, com a rede local normal${dnsBad ? " e os DNS públicos também lentos" : ""}: o gargalo está entre o seu roteador e a Internet.`,
        action: "Veja se algum download, backup ou atualização está ocupando o link; se continuar, abra chamado na operadora.",
      },
      take((s) => bad(s.measuredStatus)),
    );
  }

  // 6. Mesmo lugar (saída internacional ou PoP de CDN).
  for (const p of input.places ?? []) {
    if (p.kind !== "EXIT" && p.kind !== "EDGE") continue;
    const slugs = new Set(p.services.map((s) => s.slug));
    if ([...left.values()].filter((s) => slugs.has(s.slug)).length < 2) continue;
    push(
      {
        scope: "UPSTREAM",
        label: p.label,
        detail: p.kind === "EXIT" ? "Estes serviços saem do país pelo mesmo ponto e pioraram juntos." : "Estes serviços são atendidos pela mesma borda do CDN e pioraram juntos.",
        action: null,
      },
      take((s) => slugs.has(s.slug)),
    );
  }

  // 7. Isolados.
  for (const s of [...left.values()]) {
    push({ scope: "SERVICE", label: s.name, detail: s.measuredReason ?? "Fora do normal só neste serviço.", action: null }, take((x) => x.slug === s.slug));
  }

  const scope = SCOPE_ORDER.find((sc) => groups.some((g) => g.scope === sc)) ?? null;
  return { affected: affected.length, headline: headlineOf(affected.length, groups, scope), scope, groups };
}

function placeIndex(places: readonly DiagnosisPlace[] | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of places ?? []) for (const s of p.services) if (!out.has(s.slug)) out.set(s.slug, p.label);
  return out;
}

function headlineOf(affected: number, groups: readonly CauseGroup[], scope: CauseScope | null): string {
  const total = plural(affected, "serviço fora do normal", "serviços fora do normal");
  const main = groups.find((g) => g.scope === scope);
  if (!main || !scope) return total;
  const causes = groups.length;
  const tail = causes === 1 ? "uma causa provável" : `${causes} causas prováveis`;
  if (scope === "LOCAL") return `${total}, ${tail}: o problema está na sua rede (${main.label.toLowerCase()})`;
  if (scope === "ACCESS") return `${total}, ${tail}: a principal está no link ou na operadora, não nos serviços`;
  if (scope === "UPSTREAM") return `${total}, ${tail}: fora da sua rede (${main.label})`;
  if (scope === "PROVIDER") return `${total}, ${tail}: confirmado pelo provedor`;
  return `${total}, cada um por um motivo próprio`;
}
