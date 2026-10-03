import { DeviceInventory } from "@/components/device-inventory";

export default function Home() {
  return (
    <div className="flex w-full flex-col gap-6 px-3 py-8 lg:px-6">
      <div>
        <p className="text-sm text-muted-foreground">
          Dispositivos descobertos automaticamente na sua rede local.
        </p>
      </div>
      <DeviceInventory />
    </div>
  );
}
