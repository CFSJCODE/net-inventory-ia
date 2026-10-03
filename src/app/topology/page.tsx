import { TopologyView } from "@/components/topology/topology-view";

export default function TopologyPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-3 py-8">
      <div>
        <p className="text-sm text-muted-foreground">
          Mapa dos dispositivos do inventário a partir do gateway. Clique em um dispositivo para ver os detalhes.
        </p>
      </div>
      <TopologyView />
    </div>
  );
}
