"use client";

import { useRouter } from "next/navigation";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

function pageNumbers(page: number, pageCount: number): number[] {
  const start = Math.max(1, Math.min(page - 2, pageCount - 4));
  const end = Math.min(pageCount, start + 4);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/**
 * Paginação genérica. `hrefFor` dá um link real a cada página (abrir em nova aba, URL
 * compartilhável); sem ele, os links são "#" e só `onPageChange` é chamado.
 */
export function DevicePagination({
  page,
  pageCount,
  onPageChange,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  hrefFor?: (page: number) => string;
}) {
  if (pageCount <= 1) return null;

  const href = (target: number) => hrefFor?.(target) ?? "#";

  function go(target: number, e: React.MouseEvent) {
    // Ctrl/Cmd/clique do meio abrem o link normalmente em outra aba.
    if (hrefFor && (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1)) return;
    e.preventDefault();
    onPageChange(Math.min(Math.max(target, 1), pageCount));
  }

  return (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious href={href(Math.max(page - 1, 1))} text="Anterior" onClick={(e) => go(page - 1, e)} className={page === 1 ? "pointer-events-none opacity-50" : undefined} />
        </PaginationItem>
        {pageNumbers(page, pageCount).map((n) => (
          <PaginationItem key={n}>
            <PaginationLink href={href(n)} isActive={n === page} onClick={(e) => go(n, e)}>
              {n}
            </PaginationLink>
          </PaginationItem>
        ))}
        <PaginationItem>
          <PaginationNext href={href(Math.min(page + 1, pageCount))} text="Próxima" onClick={(e) => go(page + 1, e)} className={page === pageCount ? "pointer-events-none opacity-50" : undefined} />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

/** Paginação para páginas renderizadas no servidor: a página atual vive na URL (?page=N). */
export function UrlPagination({ page, pageCount, basePath }: { page: number; pageCount: number; basePath: string }) {
  const router = useRouter();
  const hrefFor = (n: number) => (n === 1 ? basePath : `${basePath}?page=${n}`);
  return <DevicePagination page={page} pageCount={pageCount} hrefFor={hrefFor} onPageChange={(n) => router.push(hrefFor(n))} />;
}
