import type { AlertType } from "@/app/actions/alert-actions";

/** Preferências de notificação: ficam no navegador, porque a permissão também é por navegador. */
export interface NotificationPrefs {
  enabled: boolean;
  types: Record<AlertType, boolean>;
}

const KEY = "netinventory:notifications";
export const PREFS_CHANGED_EVENT = "netinventory:notification-prefs";

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: false,
  types: { LINK_DOWN: true, LINK_UP: true, DEVICE_DISCOVERED: true },
};

export function loadPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return { enabled: !!parsed.enabled, types: { ...DEFAULT_PREFS.types, ...parsed.types } };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Armazenamento indisponível (ex: janela privada): a preferência vale só nesta sessão.
  }
  window.dispatchEvent(new Event(PREFS_CHANGED_EVENT));
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}
