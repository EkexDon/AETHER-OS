/**
 * Calendar-date helpers for vault tasks. Dates are ISO `YYYY-MM-DD` strings
 * in the user's local calendar; arithmetic runs in UTC so DST changes never
 * shift a day.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date of `d` as `YYYY-MM-DD`. */
export function toIsoDate(d: Date): string {
  return `${String(d.getFullYear()).padStart(4, "0")}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today's local date as `YYYY-MM-DD`. */
export function todayIso(now: Date = new Date()): string {
  return toIsoDate(now);
}

/** Midnight UTC of an ISO date (years below 100 stay literal). */
function toUtc(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(y, m - 1, d);
  return date;
}

function fromUtc(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** `iso` shifted by whole days. */
export function addDaysIso(iso: string, days: number): string {
  const date = toUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

/** How pressing a due date is, relative to today. */
export type DueUrgency = "overdue" | "today" | "soon" | "later";

/** `soon` means within the next three days. */
export function dueUrgency(due: string, today: string): DueUrgency {
  const diff = daysBetween(today, due);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff <= 3) return "soon";
  return "later";
}

const weekdayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const shortFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const shortYearFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const longFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** `Sep 30`, or `Sep 30, 2027` outside the current year. */
export function formatShortDate(iso: string, today: string): string {
  return iso.slice(0, 4) === today.slice(0, 4) ? shortFmt.format(toUtc(iso)) : shortYearFmt.format(toUtc(iso));
}

/** `Wednesday, September 30, 2026`. */
export function formatLongDate(iso: string): string {
  return longFmt.format(toUtc(iso));
}

/** `Today`, `Tomorrow`, `Yesterday`, `3d overdue`, `Fri` (this week) or `Sep 30`. */
export function relativeDueLabel(due: string, today: string): string {
  const diff = daysBetween(today, due);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff < -1) return `${-diff}d overdue`;
  if (diff < 7) return weekdayFmt.format(toUtc(due));
  return formatShortDate(due, today);
}
