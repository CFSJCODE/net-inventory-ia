import { DeviceInventory } from "@/components/device-inventory";
import { prisma } from "@/lib/prisma";

export default async function InventoryPage() {
  const initialDevices = await prisma.device.findMany({ orderBy: { lastSeenAt: "desc" } });

  return (
    <div className="flex w-full flex-col gap-6 px-3 py-8 lg:px-6">
      <div>
        <p className="text-sm text-muted-foreground">
          Dispositivos descobertos automaticamente na sua rede local.
        </p>
      </div>
      <DeviceInventory initialDevices={initialDevices} />
    </div>
  );
}
