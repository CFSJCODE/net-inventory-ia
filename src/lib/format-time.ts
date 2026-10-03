const RTF = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 1000 * 60 * 60 * 24 * 365],
  ["month", 1000 * 60 * 60 * 24 * 30],
  ["day", 1000 * 60 * 60 * 24],
  ["hour", 1000 * 60 * 60],
  ["minute", 1000 * 60],
  ["second", 1000],
];

export function formatRelativeTime(date: string | Date): string {
  const target = typeof date === "string" ? new Date(date) : date;
  const diffMs = target.getTime() - Date.now();

  for (const [unit, ms] of UNITS) {
    if (Math.abs(diffMs) >= ms || unit === "second") {
      return RTF.format(Math.round(diffMs / ms), unit);
    }
  }
  return RTF.format(0, "second");
}

export function formatDateTime(date: string | Date): string {
  const target = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" }).format(target);
}
