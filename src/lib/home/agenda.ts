/**
 * Calendar helpers for the Home "Today" block. Day matching follows the
 * Calendar view exactly: all-day events use `YYYY-MM-DD` keys with an
 * exclusive end (unless start == end), timed events cover every local day
 * between their start and end.
 */
import type { CalendarEvent } from "../../types";
import { dateKey } from "./focusStats";
import { formatTime } from "./format";

function parseTimed(value: string): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Does `event` occur on local day `dayKey` (`YYYY-MM-DD`)? */
export function eventOccursOn(event: CalendarEvent, dayKey: string): boolean {
  if (event.all_day) {
    const start = event.start.slice(0, 10);
    const end = event.end.slice(0, 10);
    if (start === end) return dayKey === start;
    return start <= dayKey && dayKey < end;
  }
  const start = parseTimed(event.start);
  const end = parseTimed(event.end) ?? start;
  if (!start || !end) return false;
  return dateKey(start) <= dayKey && dayKey <= dateKey(end);
}

/** Events on `dayKey`: all-day first, then by start time, then title. */
export function agendaFor(events: CalendarEvent[], dayKey: string): CalendarEvent[] {
  return events
    .filter((e) => eventOccursOn(e, dayKey))
    .sort((a, b) => {
      if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
      const at = a.all_day ? 0 : parseTimed(a.start)?.getTime() ?? 0;
      const bt = b.all_day ? 0 : parseTimed(b.start)?.getTime() ?? 0;
      return at - bt || a.title.localeCompare(b.title);
    });
}

/** `All day`, `09:30 – 10:15`, or `until 10:15` / `from 22:00` for multi-day timed events. */
export function eventTimeLabel(event: CalendarEvent, dayKey: string): string {
  if (event.all_day) return "All day";
  const start = parseTimed(event.start);
  const end = parseTimed(event.end);
  if (!start) return "";
  const startsToday = dateKey(start) === dayKey;
  const endsToday = end ? dateKey(end) === dayKey : true;
  if (startsToday && endsToday) return end ? `${formatTime(start)} – ${formatTime(end)}` : formatTime(start);
  if (!startsToday && end && endsToday) return `until ${formatTime(end)}`;
  if (startsToday) return `from ${formatTime(start)}`;
  return "All day";
}

/** Is a timed event happening at `now`? */
export function isEventNow(event: CalendarEvent, now: Date): boolean {
  if (event.all_day) return false;
  const start = parseTimed(event.start);
  const end = parseTimed(event.end);
  return !!start && !!end && start.getTime() <= now.getTime() && now.getTime() < end.getTime();
}

/** Has a timed event already ended at `now`? */
export function isEventPast(event: CalendarEvent, now: Date): boolean {
  if (event.all_day) return false;
  const end = parseTimed(event.end);
  return !!end && end.getTime() <= now.getTime();
}
