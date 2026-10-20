// Dates as the owner reads them: America/Toronto wall time (spec: "today" and "this week" are Toronto days).

const DATE_TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** `2026-10-19 08:00` in Toronto time; `–` for null or an invalid date. */
export function formatDateTime(d: Date | null | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return '–';
  const p = Object.fromEntries(DATE_TIME.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" (future instants read as "just now"). */
export function relativeTime(at: Date, now: Date): string {
  const s = Math.floor((now.getTime() - at.getTime()) / 1000);
  if (!Number.isFinite(s) || s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** US dollars with two decimals: `$1.50`, `$0.00`. */
export function usd(x: number): string {
  return `$${(Number.isFinite(x) ? x : 0).toFixed(2)}`;
}
