/**
 * Focus statistics, mirroring `compute_stats` / `streak_days` in
 * `src-tauri/src/engine/focus_log.rs` (the Rust side is the source of truth;
 * this copy serves the mock backend and keeps both in lock-step via tests).
 */
import type { FocusDay, FocusSession, FocusStats } from "../../types";

/** Largest window the backend aggregates over. */
export const MAX_STATS_DAYS = 366;

const DAY_MS = 86_400_000;

/** Local-calendar `YYYY-MM-DD` of a date. */
export function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Shift a `YYYY-MM-DD` key by whole days (calendar arithmetic, DST-safe). */
export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d) + days * DAY_MS;
  return new Date(utc).toISOString().slice(0, 10);
}

/**
 * The calendar day a session belongs to: the date part of `started_at` in
 * the offset it was recorded with (RFC 3339 keeps it verbatim), or `null`
 * for an unparsable timestamp.
 */
export function sessionDateKey(session: Pick<FocusSession, "started_at">): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(session.started_at.trim());
  if (!match || Number.isNaN(Date.parse(session.started_at))) return null;
  return match[1];
}

/**
 * Consecutive active days ending on `today`, or on yesterday when `today`
 * has no activity yet.
 */
export function streakDays(active: ReadonlySet<string>, today: string): number {
  let day = active.has(today) ? today : shiftDateKey(today, -1);
  let streak = 0;
  while (active.has(day)) {
    streak += 1;
    day = shiftDateKey(day, -1);
  }
  return streak;
}

/** Aggregate work sessions into the `days`-day window ending on `today`. */
export function computeFocusStats(sessions: FocusSession[], today: string, days: number): FocusStats {
  const window = Math.min(MAX_STATS_DAYS, Math.max(1, Math.floor(days) || 1));
  const perDay = new Map<string, { minutes: number; sessions: number }>();
  for (const s of sessions) {
    if (s.kind !== "work") continue;
    const key = sessionDateKey(s);
    if (!key) continue;
    const entry = perDay.get(key) ?? { minutes: 0, sessions: 0 };
    entry.minutes += s.minutes;
    entry.sessions += 1;
    perDay.set(key, entry);
  }

  const byDay: FocusDay[] = [];
  for (let offset = window - 1; offset >= 0; offset--) {
    const date = shiftDateKey(today, -offset);
    const entry = perDay.get(date);
    byDay.push({ date, minutes: entry?.minutes ?? 0, sessions: entry?.sessions ?? 0 });
  }

  const active = new Set([...perDay].filter(([, v]) => v.minutes > 0).map(([k]) => k));
  const todayEntry = perDay.get(today);
  return {
    today_minutes: todayEntry?.minutes ?? 0,
    today_sessions: todayEntry?.sessions ?? 0,
    streak_days: streakDays(active, today),
    total_minutes: byDay.reduce((sum, d) => sum + d.minutes, 0),
    by_day: byDay,
  };
}

/** `90` → `1h 30m`, `25` → `25m`, `0` → `0m`. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}
