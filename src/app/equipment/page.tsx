import type { Metadata } from "next";
import { EquipmentView } from "@/components/equipment/equipment-view";

export const metadata: Metadata = {
  title: "Equipamentos",
};

export default function EquipmentPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-3 py-8">
      <p className="text-sm text-muted-foreground">
        Cadastre os switches e roteadores gerenciáveis e acompanhe o hardware e cada porta em tempo real via SNMP.
      </p>
      <EquipmentView />
    </div>
  );
}
