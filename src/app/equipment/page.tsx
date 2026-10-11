import type { Metadata } from "next";
import { EquipmentView } from "@/components/equipment/equipment-view";

export const metadata: Metadata = {
  title: "Status dos equipamentos",
};

export default function EquipmentPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-3 py-8">
      <p className="text-sm text-muted-foreground">
        Consulte em tempo real o estado do hardware e das interfaces de um switch via SNMP.
      </p>
      <EquipmentView />
    </div>
  );
}
