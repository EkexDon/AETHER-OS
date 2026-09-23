/** Date/time formatting helpers for the Home dashboard. */

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");

/** RFC 3339 timestamp with the local UTC offset, e.g. `2026-09-22T09:00:00+02:00`. */
export function toLocalRfc3339(ms: number): string {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/** Greeting for the time of day. */
export function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** `Tuesday, 22 September` (English, independent of the OS locale). */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

/** Short weekday (`Mon`) for a `YYYY-MM-DD` key. */
export function weekdayShort(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short" });
}

/**
 * Compact relative time for a past instant: `just now`, `5m ago`, `3h ago`,
 * `yesterday`, `4d ago`, `3w ago`, then `12 Mar` / `12 Mar 2024`.
 */
export function relativeTime(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return "yesterday";
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  const then = new Date(thenMs);
  const sameYear = then.getFullYear() === new Date(nowMs).getFullYear();
  return then.toLocaleDateString("en-GB", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** `09:30` in 24-hour local time. */
export function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Last path component without the `.md` extension. */
export function noteTitleFromPath(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/** Folder of `path` relative to `root` (`""` for the root itself). */
export function relativeFolder(path: string, root: string | null): string {
  const normalized = path.replace(/\\/g, "/");
  const base = root ? root.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const rel = base && normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized;
  const idx = rel.lastIndexOf("/");
  return idx <= 0 ? "" : rel.slice(0, idx);
}
