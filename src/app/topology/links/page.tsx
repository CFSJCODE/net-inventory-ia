import { LinksPanel } from "@/components/topology/links-panel";

export default function TopologyLinksPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-3 py-8">
      <div>
        <p className="text-sm text-muted-foreground">
          Ligações entre equipamentos testadas continuamente. O estado de cada uma também aparece no mapa da topologia.
        </p>
      </div>
      <LinksPanel />
    </div>
  );
}
