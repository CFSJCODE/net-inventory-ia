import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeftIcon } from "@/components/ui/arrow-left";
import { prisma } from "@/lib/prisma";
import { displayName } from "@/lib/device-name";
import { DeviceTypeIcon, DEVICE_TYPE_LABELS } from "@/components/device-type-icon";
import { StatusBadge } from "@/components/status-badge";
import { EventTimeline } from "@/components/event-timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format-time";
import { DeviceIdentityCard } from "@/components/device-identity-card";
import { DeviceSecurityCard } from "@/components/ai/device-security-card";
import { findingsForPorts } from "@/lib/security-rules";

export default async function DeviceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const device = await prisma.device.findUnique({
    where: { id },
    include: { events: { orderBy: { createdAt: "desc" } } },
  });

  if (!device) notFound();

  const openPorts = device.openPorts?.split(",").filter(Boolean) ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-3 py-8">
      <Link href="/" className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon size={16} />
        Voltar ao inventário
      </Link>

      <div className="flex items-center gap-3">
        <DeviceTypeIcon type={device.type} size={32} className="text-muted-foreground" />
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{displayName(device)}</h2>
          <p className="text-sm text-muted-foreground">{DEVICE_TYPE_LABELS[device.type]}</p>
        </div>
        <div className="ml-auto">
          <StatusBadge status={device.status} />
        </div>
      </div>

      <DeviceIdentityCard
        id={device.id}
        alias={device.alias}
        hostname={device.hostname}
        type={device.type}
        typeLocked={device.typeLocked}
        notes={device.notes}
      />

      <DeviceSecurityCard deviceId={device.id} findings={findingsForPorts(openPorts.map(Number))} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Detalhes</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <Field label="IPv4 atual" value={device.ip} mono />
          <Field label="IPv6" value={device.ipv6?.split(",").join("\n") || "Não detectado"} mono={!!device.ipv6} />
          <Field label="Hostname (descoberto)" value={device.hostname ?? "Não descoberto"} />
          <Field label="MAC" value={device.mac ?? "—"} mono />
          <Field label="Fabricante" value={device.vendor ?? "—"} />
          <Field label="Sistema operacional" value={device.os ?? "Não identificado"} />
          <Field label="Usuário logado" value={device.loggedUser ?? "Não disponível"} />
          <Field label="Portas abertas" value={openPorts.length ? openPorts.join(", ") : "Nenhuma detectada"} />
          <Field label="Primeira vez visto" value={formatDateTime(device.firstSeenAt)} />
          <Field label="Última vez visto" value={formatDateTime(device.lastSeenAt)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Histórico</CardTitle>
        </CardHeader>
        <CardContent>
          <EventTimeline events={device.events} />
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? "whitespace-pre-line break-all font-mono" : undefined}>{value}</p>
    </div>
  );
}
