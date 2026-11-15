import type { StatusServiceRow } from "@/app/actions/global-status-actions";
import type { LocalConnectivity, ServiceCategory, ServiceStatus } from "@/lib/global-status/types";

/**
 * O que mudou entre duas consultas da página e merece um aviso na tela. Funções puras: a página só
 * guarda o que viu (`rememberSeen`) e mostra os avisos (`transitionNotices`).
 */

/** Os serviços desta categoria medem a conexão do próprio servidor: ficam na faixa "Sua Internet", não nos cards. */
export const INTERNET_CATEGORY: ServiceCategory = "INTERNET";
/** Visão de fora (IODA e rotas BGP): fica na faixa "Internet no Brasil", não nos cards; as mudanças dela viram aviso. */
export const REGIONAL_CATEGORY: ServiceCategory = "REGIONAL";

/** O que a página lembra entre as consultas: o último estado julgado de cada serviço e o da conexão do servidor. */
export interface SeenStatus {
  states: Map<string, ServiceStatus>;
  connection: LocalConnectivity["state"];
}

/** Um aviso na tela. `long` = fica 15 s em vez do tempo padrão (quedas). */
export interface Notice {
  tone: "error" | "warning" | "success";
  title: string;
  description?: string;
  long?: boolean;
}

type ServiceSeen = Pick<StatusServiceRow, "slug" | "name" | "category" | "status" | "measuredReason" | "officialStatus" | "measurementPaused">;
type Seen = { services: readonly ServiceSeen[]; connectivity: Pick<LocalConnectivity, "state" | "reason"> };

/** Aviso de um serviço que mudou para pior (ou voltou) desde o estado lembrado; "Sem dados" não é notícia. */
export function serviceNotice(service: ServiceSeen, was: ServiceStatus | undefined): Notice | null {
  const now = service.status;
  if (!was || was === now || now === "UNKNOWN" || was === "UNKNOWN") return null;
  const description = service.measuredReason ?? service.officialStatus ?? undefined;
  if (now === "DOWN") return { tone: "error", title: `${service.name}: fora do ar`, description, long: true };
  if (now === "DEGRADED" && was === "OK") return { tone: "warning", title: `${service.name}: degradado`, description };
  if (now === "OK") return { tone: "success", title: `${service.name}: normalizado` };
  return null;
}

/**
 * Um serviço cujo estado, nesta consulta, não é um julgamento novo: os da faixa "Sua Internet" (nunca
 * viram aviso) e os que estão com as medições paradas pela conexão local. Nesse intervalo o card mostra
 * só o status oficial (ou "Sem dados"), o que não é notícia do serviço.
 */
const notJudged = (service: ServiceSeen) => service.category === INTERNET_CATEGORY || service.measurementPaused;

/**
 * Compara a consulta nova com o que a página lembra e devolve os avisos, na ordem: primeiro a conexão
 * do servidor, depois os serviços. Com a conexão fora nenhum serviço é anunciado. Quando ela volta,
 * cada serviço é comparado com o estado de antes da queda assim que for medido de novo: uma queda que
 * começou durante a falta de Internet é anunciada, e uma que já tinha sido anunciada não se repete.
 */
export function transitionNotices(before: SeenStatus, data: Seen): Notice[] {
  const notices: Notice[] = [];
  const wasOk = before.connection === "ok";
  const isOk = data.connectivity.state === "ok";
  if (wasOk && !isOk) notices.push({ tone: "error", title: "Sua Internet está fora", description: data.connectivity.reason ?? undefined, long: true });
  else if (!wasOk && isOk) notices.push({ tone: "success", title: "Sua Internet voltou" });
  if (!isOk) return notices;
  for (const service of data.services) {
    if (notJudged(service)) continue;
    const notice = serviceNotice(service, before.states.get(service.slug));
    if (notice) notices.push(notice);
  }
  return notices;
}

/**
 * O que lembrar depois de uma consulta. Com a conexão fora, para cada serviço que ainda não foi medido
 * de novo depois da volta e para o que está "Sem dados", fica o estado de antes: é contra ele que o
 * próximo julgamento do serviço será comparado.
 */
export function rememberSeen(before: SeenStatus | null, data: Seen): SeenStatus {
  const connection = data.connectivity.state;
  if (connection !== "ok") return { states: before?.states ?? new Map(), connection };
  const states = new Map<string, ServiceStatus>();
  for (const service of data.services) {
    const judged = !service.measurementPaused && service.status !== "UNKNOWN";
    const kept = judged ? service.status : before?.states.get(service.slug);
    if (kept) states.set(service.slug, kept);
  }
  return { states, connection };
}
