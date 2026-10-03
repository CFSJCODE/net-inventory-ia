"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const CANCEL_EVENT = "top-loading-bar:cancel";

/**
 * Cancela uma navegação que a barra detectou pelo clique mas que não vai acontecer — ex: o clique
 * que encerra um arrasto no mapa. Precisa ser explícito porque o Link do Next sempre chama
 * preventDefault, então não dá para distinguir pelo evento.
 */
export function cancelNavigationProgress() {
  window.dispatchEvent(new Event(CANCEL_EVENT));
}

/** Operações mais rápidas que isso não mostram a barra (evita piscar em cliques instantâneos). */
const SHOW_DELAY_MS = 100;
/** Se a navegação não concluir nesse tempo (ex: link para a própria página), a barra se encerra sozinha. */
const NAVIGATION_TIMEOUT_MS = 15_000;

/**
 * Detecta o início de uma navegação no App Router, que não expõe eventos de rota: cliques em links
 * internos (inclusive os que chamam router.push no onClick, como a paginação) e voltar/avançar.
 * O fim é detectado pela mudança de pathname/searchParams.
 */
function useNavigationPending(): boolean {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);

  // Rota mudou = navegação concluída. Ajuste de estado durante a renderização (padrão do React para
  // "estado derivado de prop que mudou"), em vez de um efeito que renderizaria duas vezes.
  const routeKey = `${pathname}?${searchParams}`;
  const [lastRouteKey, setLastRouteKey] = useState(routeKey);
  if (routeKey !== lastRouteKey) {
    setLastRouteKey(routeKey);
    setPending(false);
  }

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin) return;
      // Mesmo endereço (ou só a âncora #) não dispara navegação.
      if (url.pathname === location.pathname && url.search === location.search) return;
      setPending(true);
    }
    const onPopState = () => setPending(true);
    const onCancel = () => setPending(false);

    // Captura: roda antes do onClick dos componentes, que podem chamar preventDefault (Link, paginação).
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    window.addEventListener(CANCEL_EVENT, onCancel);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(CANCEL_EVENT, onCancel);
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(false), NAVIGATION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  return pending;
}

/** Barra de progresso fina no topo da tela, no estilo NProgress. */
export function TopLoadingBar() {
  const navigating = useNavigationPending();
  // Só o primeiro carregamento de cada consulta: as atualizações automáticas em segundo plano
  // (inventário a cada 15s, ligações a cada 10s) fariam a barra piscar o tempo todo.
  const initialFetches = useIsFetching({ predicate: (q) => q.state.data === undefined });
  const mutations = useIsMutating();
  const busy = navigating || initialFetches > 0 || mutations > 0;

  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);

  useEffect(() => {
    if (busy) {
      // Começa após um pequeno atraso e avança cada vez mais devagar, sem nunca chegar a 100%
      // enquanto houver trabalho — o fim real é desconhecido (um scan leva ~20s, uma página ~100ms).
      let trickle: ReturnType<typeof setInterval> | undefined;
      const start = setTimeout(() => {
        visibleRef.current = true;
        setVisible(true);
        setProgress(15);
        trickle = setInterval(() => setProgress((p) => p + (90 - p) * 0.06), 250);
      }, SHOW_DELAY_MS);
      return () => {
        clearTimeout(start);
        if (trickle) clearInterval(trickle);
      };
    }

    if (!visibleRef.current) return;
    // Terminou: completa a barra, deixa a animação de largura acontecer e some.
    setProgress(100);
    const hide = setTimeout(() => {
      visibleRef.current = false;
      setVisible(false);
    }, 300);
    const reset = setTimeout(() => setProgress(0), 600);
    return () => {
      clearTimeout(hide);
      clearTimeout(reset);
    };
  }, [busy]);

  return (
    <div
      role="progressbar"
      aria-label="Carregando"
      aria-hidden={!visible}
      aria-valuenow={Math.round(progress)}
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px]"
    >
      <div
        className={cn(
          "h-full bg-primary shadow-[0_0_10px_color-mix(in_oklab,var(--color-primary)_70%,transparent)] transition-[width,opacity] ease-out",
          progress === 0 ? "duration-0" : "duration-300",
          visible ? "opacity-100" : "opacity-0",
        )}
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
