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

interface DiagnosisInput {
  services: readonly DiagnosisService[];
  connectivity: LocalConnectivity;
  incidents?: readonly DiagnosisIncident[];
  places?: readonly DiagnosisPlace[] | null;
}

/** Os afetados ainda sem causa e os grupos já montados; cada regra tira os seus de `left`. */
class Attribution {
  readonly groups: CauseGroup[] = [];
  readonly left: Map<string, DiagnosisService>;

  constructor(affected: readonly DiagnosisService[]) {
    this.left = new Map(affected.map((s) => [s.slug, s]));
  }

  remaining(): DiagnosisService[] {
    return Array.from(this.left.values());
  }

  /** Tira de `left` os que `pick` escolhe e, havendo algum, monta o grupo com eles. */
  assign(group: Omit<CauseGroup, "services">, pick: (s: DiagnosisService) => boolean): void {
    const chosen = this.remaining().filter(pick);
    for (const s of chosen) this.left.delete(s.slug);
    if (chosen.length) this.groups.push({ ...group, services: chosen.map((s) => ({ slug: s.slug, name: s.name, status: s.status })) });
  }
}

export function diagnose(input: DiagnosisInput): Diagnosis {
  const affected = input.services.filter(isProvider).filter((s) => bad(s.status));
  if (!affected.length) return { affected: 0, headline: null, scope: null, groups: [] };
  const a = new Attribution(affected);
  offlineRule(a, input.connectivity);
  localRule(a, input.services);
  providerRule(a);
  routeRule(a, input.incidents ?? []);
  accessRule(a, input);
  placeRule(a, input.places ?? []);
  for (const s of a.remaining()) a.assign({ scope: "SERVICE", label: s.name, detail: s.measuredReason ?? "Fora do normal só neste serviço.", action: null }, (x) => x.slug === s.slug);
  const scope = SCOPE_ORDER.find((sc) => a.groups.some((g) => g.scope === sc)) ?? null;
  return { affected: affected.length, headline: headlineOf(affected.length, a.groups, scope), scope, groups: a.groups };
}

/** 1. Sem conexão: as medições estão paradas e o que aparece é o estado oficial; nada é culpa dos serviços. */
function offlineRule(a: Attribution, connectivity: LocalConnectivity): void {
  if (connectivity.state === "ok") return;
  const dns = connectivity.state === "dns";
  const why = connectivity.reason ?? (dns ? "O DNS deste servidor não resolve nomes." : "Este servidor não alcança a Internet.");
  a.assign({ scope: "LOCAL", label: dns ? "DNS deste servidor" : "Conexão deste servidor", detail: why, action: "Confira o roteador, o cabo ou Wi-Fi e o DNS configurado; os serviços abaixo podem estar normais." }, () => true);
}

/**
 * "Rede local" só degradada pelo alvo DNS, com o gateway normal. O motivo é o do primeiro alvo (na ordem
 * do catálogo: gateway, depois DNS) no pior estado; com o card DEGRADED, um motivo "DNS:" garante que o
 * gateway não está degradado nem fora (senão o motivo seria o dele, ou o card estaria DOWN). Com o card
 * DOWN não dá para saber, e vale a regra da rede local. O alvo DNS mede o resolvedor configurado
 * (1.1.1.1, o da operadora...), que fica na Internet: um cache frio lá fora não é o roteador, o switch
 * nem o cabo, e não explica o TCP lento de outros serviços.
 */
const dnsOnly = (local: DiagnosisService) => local.measuredStatus === "DEGRADED" && !!local.measuredReason?.startsWith("DNS:");

/** 2. Rede local degradada: o que só foi visto daqui (o provedor não confirma) é efeito dela. */
function localRule(a: Attribution, services: readonly DiagnosisService[]): void {
  const local = services.find((s) => s.slug === LOCAL_SLUG);
  if (!local || !bad(local.measuredStatus) || dnsOnly(local)) return;
  const state = local.measuredStatus === "DOWN" ? "fora" : "degradada";
  const why = local.measuredReason ? ` (${local.measuredReason})` : "";
  a.assign(
    { scope: "LOCAL", label: "Rede local", detail: `A rede local deste servidor está ${state}${why}: a lentidão dos serviços vem daqui.`, action: "Verifique o roteador, o switch e o cabo ou Wi-Fi até o servidor." },
    (s) => !bad(s.officialState),
  );
}

/** 3. O provedor confirmou. */
function providerRule(a: Attribution): void {
  for (const s of a.remaining().filter((x) => bad(x.officialState))) {
    a.assign({ scope: "PROVIDER", label: s.name, detail: "O próprio provedor publicou problema na página de status.", action: null }, (x) => x.slug === s.slug);
  }
}

/** 4. A rota até o serviço mudou: a lentidão vem do caminho novo. */
function routeRule(a: Attribution, incidents: readonly DiagnosisIncident[]): void {
  const routed = new Map<string, string>();
  for (const i of incidents) {
    if (i.origin === "ROUTE" && !routed.has(i.serviceSlug)) routed.set(i.serviceSlug, i.title);
  }
  const abroad = a.remaining().some((s) => /→ fora do Brasil/.test(routed.get(s.slug) ?? ""));
  const detail = abroad
    ? "O caminho até estes serviços passou a atravessar um cabo internacional: a latência maior vem da distância, não de falha do serviço."
    : "O caminho até estes serviços mudou há pouco; a diferença de latência acompanha a rota nova.";
  a.assign({ scope: "UPSTREAM", label: abroad ? "Rota passou a sair do Brasil" : "Rota mudou", detail, action: null }, (s) => routed.has(s.slug));
}

/** 5. Acesso à Internet: muitos lentos ao mesmo tempo, espalhados por vários lugares, com a rede local normal. */
function accessRule(a: Attribution, input: DiagnosisInput): void {
  const measured = input.services.filter(isProvider).filter((s) => s.measuredStatus && s.measuredStatus !== "UNKNOWN" && !s.measurementPaused);
  const measuredBad = a.remaining().filter((s) => bad(s.measuredStatus));
  const placeOf = placeIndex(input.places);
  const spread = new Set(measuredBad.map((s) => placeOf.get(s.slug) ?? `?${s.slug}`)).size;
  const wide = measuredBad.length >= ACCESS_MIN_SERVICES && measuredBad.length >= measured.length * ACCESS_MIN_SHARE;
  if (!wide || spread < ACCESS_MIN_PLACES) return;
  const dnsBad = input.services.some((s) => s.category === "INTERNET" && s.slug !== LOCAL_SLUG && bad(s.measuredStatus));
  const count = plural(measuredBad.length, "serviço", "serviços");
  a.assign(
    {
      scope: "ACCESS",
      label: "Link ou operadora",
      detail: `${count} de ${measured.length} medidos ficaram fora do normal juntos, por caminhos diferentes, com a rede local normal${dnsBad ? " e os DNS públicos também lentos" : ""}: o gargalo está entre o seu roteador e a Internet.`,
      action: "Veja se algum download, backup ou atualização está ocupando o link; se continuar, abra chamado na operadora.",
    },
    (s) => bad(s.measuredStatus),
  );
}

/** 6. Dois ou mais atendidos pela mesma saída internacional ou pelo mesmo PoP de CDN. */
function placeRule(a: Attribution, places: readonly DiagnosisPlace[]): void {
  for (const p of places.filter((x) => x.kind === "EXIT" || x.kind === "EDGE")) {
    const slugs = new Set(p.services.map((s) => s.slug));
    if (a.remaining().filter((s) => slugs.has(s.slug)).length < 2) continue;
    const detail = p.kind === "EXIT" ? "Estes serviços saem do país pelo mesmo ponto e pioraram juntos." : "Estes serviços são atendidos pela mesma borda do CDN e pioraram juntos.";
    a.assign({ scope: "UPSTREAM", label: p.label, detail, action: null }, (s) => slugs.has(s.slug));
  }
}

function placeIndex(places: readonly DiagnosisPlace[] | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of places ?? []) {
    for (const s of p.services) {
      if (!out.has(s.slug)) out.set(s.slug, p.label);
    }
  }
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
