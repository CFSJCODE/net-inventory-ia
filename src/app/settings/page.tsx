import { SettingsForm } from "@/components/settings-form";

export default function SettingsPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-3 py-8">
      <div>
        <p className="text-sm text-muted-foreground">Scan da rede, notificações e limpeza do inventário.</p>
      </div>
      <SettingsForm />
    </div>
  );
}
