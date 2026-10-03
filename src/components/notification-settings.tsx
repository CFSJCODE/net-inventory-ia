"use client";

import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import type { AlertType } from "@/app/actions/alert-actions";
import { DEFAULT_PREFS, loadPrefs, notificationsSupported, savePrefs, type NotificationPrefs } from "@/lib/notification-prefs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

const TYPE_LABELS: Record<AlertType, string> = {
  LINK_DOWN: "Ligação monitorada caiu",
  LINK_UP: "Ligação monitorada voltou",
  DEVICE_DISCOVERED: "Novo dispositivo na rede",
};

export function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");

  // Lê só no cliente: localStorage e a API de notificações não existem na renderização do servidor.
  useEffect(() => {
    setPrefs(loadPrefs());
    setPermission(notificationsSupported() ? Notification.permission : "unsupported");
  }, []);

  function update(next: NotificationPrefs) {
    setPrefs(next);
    savePrefs(next);
  }

  async function enable() {
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result !== "granted") return toast.error("Permissão negada. Libere as notificações nas configurações do site no navegador.");
    update({ ...prefs, enabled: true });
    new Notification("Notificações ativadas", { body: "Você será avisado sobre ligações e dispositivos novos.", icon: "/logo.png" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Notificações do navegador</CardTitle>
        <CardDescription>
          Avisos nativos quando uma ligação cai ou volta e quando um dispositivo novo entra na rede. Funcionam com o NetInventory aberto
          em alguma aba (mesmo minimizado) e valem só para este navegador.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {permission === "unsupported" && <p className="text-sm text-muted-foreground">Este navegador não suporta notificações.</p>}
        {permission === "denied" && (
          <p className="text-sm text-destructive">Notificações bloqueadas para este site. Libere nas configurações do navegador e recarregue.</p>
        )}
        {(permission === "default" || (permission === "granted" && !prefs.enabled)) && (
          <Button onClick={enable} className="w-fit">
            <BellRing className="h-3.5 w-3.5" />
            Ativar notificações
          </Button>
        )}
        {permission === "granted" && prefs.enabled && (
          <>
            <div className="flex flex-col gap-2">
              {(Object.keys(TYPE_LABELS) as AlertType[]).map((type) => (
                <Label key={type} className="flex items-center gap-2 text-sm font-normal">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={prefs.types[type]}
                    onChange={(e) => update({ ...prefs, types: { ...prefs.types, [type]: e.target.checked } })}
                  />
                  {TYPE_LABELS[type]}
                </Label>
              ))}
            </div>
            <Button variant="outline" onClick={() => update({ ...prefs, enabled: false })} className="w-fit">
              Desativar notificações
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
