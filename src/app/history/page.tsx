import { prisma } from "@/lib/prisma";
import { EventTimeline } from "@/components/event-timeline";
import { UrlPagination } from "@/components/device-pagination";
import { AiSummaryCard } from "@/components/ai/ai-summary-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const PAGE_SIZE = 20;

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page: pageParam } = await searchParams;
  const total = await prisma.deviceEvent.count();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Página inválida ou além do fim (ex: eventos apagados) cai na faixa válida em vez de mostrar vazio.
  const page = Math.min(Math.max(Math.floor(Number(pageParam)) || 1, 1), pageCount);

  const events = await prisma.deviceEvent.findMany({
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    include: { device: { select: { id: true, hostname: true, alias: true, ip: true } } },
  });

  const first = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const last = (page - 1) * PAGE_SIZE + events.length;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-3 py-8">
      <div>
        <p className="text-sm text-muted-foreground">
          Eventos da rede: novos dispositivos, mudanças de IP/hostname, status online/offline e ligações que caíram ou voltaram.
        </p>
      </div>

      {page === 1 && <AiSummaryCard />}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Eventos</CardTitle>
          {total > 0 && (
            <span className="text-xs text-muted-foreground">
              {first}–{last} de {total}
            </span>
          )}
        </CardHeader>
        <CardContent>
          <EventTimeline events={events} />
        </CardContent>
      </Card>

      <UrlPagination page={page} pageCount={pageCount} basePath="/history" />
    </div>
  );
}
