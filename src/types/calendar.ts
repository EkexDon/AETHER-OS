/** Calendar types — mirror `engine/calendar.rs`, `calendar_ics.rs`, `calendar_notifier.rs`. */

/** A calendar event. */
export interface CalendarEvent {
  id: string;
  uid: string;
  title: string;
  description: string;
  all_day: boolean;
  /** "YYYY-MM-DD" when all_day, RFC3339 timestamp when timed */
  start: string;
  /** Same format as start. Always present (single-day events have end == start + duration). */
  end: string;
  /** Optional deadline. Same format as start. */
  due: string | null;
  /** Hex like "#3b82f6" */
  color: string;
  tags: string[];
  attendees: string[];
  location: string | null;
  /** Set when the event was created from a vault note context by the AI. */
  source_note_path: string | null;
  created_at: string;
  updated_at: string;
}

/** Partial update for `cmd_update_calendar_event` (snake_case, nested struct). */
export interface CalendarEventPatch {
  title?: string;
  description?: string;
  all_day?: boolean;
  start?: string;
  end?: string;
  due?: string | null;
  color?: string;
  tags?: string[];
  attendees?: string[];
  location?: string | null;
}

/** Calendar layout mode. */
export type CalendarView = "month" | "week" | "day";

/** Outcome of an `.ics` import. */
export interface IcsImportResult {
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** Desktop notification reminders for upcoming events. */
export interface ReminderSettings {
  enabled: boolean;
  lead_times_minutes: number[];
}
