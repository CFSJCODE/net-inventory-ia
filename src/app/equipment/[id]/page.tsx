import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEquipment } from "@/app/actions/equipment-actions";
import { EquipmentDetailSection } from "@/components/equipment/equipment-view";

export const metadata: Metadata = { title: "Detalhes do equipamento" };

export default async function EquipmentDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getEquipment(id);
  if (!result.ok) notFound();

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-5 px-3 py-8">
      <Link href="/equipment" className="w-fit rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">← Equipamentos</Link>
      <EquipmentDetailSection equipment={result.data} />
    </main>
  );
}
