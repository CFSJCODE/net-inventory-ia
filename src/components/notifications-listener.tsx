"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { getAlertsSince, type AlertEvent } from "@/app/actions/alert-actions";
import { loadPrefs, notificationsSupported, PREFS_CHANGED_EVENT, type NotificationPrefs } from "@/lib/notification-prefs";

const POLL_MS = 15_000;

const TITLES: Record<AlertEvent["type"], string> = {
  LINK_DOWN: "🔴 Ligação caiu",
  LINK_UP: "🟢 Ligação voltou",
  DEVICE_DISCOVERED: "🆕 Novo dispositivo na rede",
};

/**
 * Consulta eventos novos periodicamente e mostra notificações nativas do navegador. Só funciona com o
 * app aberto em alguma aba (escolha do usuário: sem serviço externo). Começa a contar a partir do
 * carregamento, para não notificar eventos antigos.
 */
export function NotificationsListener() {
  const router = useRouter();
  const since = useRef(new Date().toISOString());
  const prefs = useRef<NotificationPrefs | null>(null);

  useEffect(() => {
    if (!notificationsSupported()) return;
    prefs.current = loadPrefs();
    const onPrefsChanged = () => (prefs.current = loadPrefs());
    window.addEventListener(PREFS_CHANGED_EVENT, onPrefsChanged);

    let stopped = false;
    async function poll() {
      const p = prefs.current;
      if (!p?.enabled || Notification.permission !== "granted") return;
      try {
        const alerts = await getAlertsSince(since.current);
        if (stopped || !alerts.length) return;
        since.current = alerts[alerts.length - 1].createdAt;
        for (const alert of alerts) {
          if (!p.types[alert.type]) continue;
          // tag = id do evento: com várias abas abertas, o navegador mostra a notificação uma vez só.
          const n = new Notification(TITLES[alert.type], { body: `${alert.deviceName} ${alert.message}`, tag: alert.id, icon: "/logo.png" });
          n.onclick = () => {
            window.focus();
            router.push(`/devices/${alert.deviceId}`);
            n.close();
          };
        }
      } catch {
        // Falha de rede/sessão expirada: tenta de novo no próximo ciclo.
      }
    }

    const timer = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener(PREFS_CHANGED_EVENT, onPrefsChanged);
    };
  }, [router]);

  return null;
}
