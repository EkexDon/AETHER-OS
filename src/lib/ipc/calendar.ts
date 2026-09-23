/** Calendar commands (`src-tauri/src/commands/calendar_commands.rs`). */
import type {
  CalendarEvent,
  CalendarEventPatch,
  IcsImportResult,
  ReminderSettings,
} from "../../types";
import { call } from "./core";

/** Fields of a new calendar event (snake_case like the Rust struct). */
export interface CalendarEventInput {
  title: string;
  description: string;
  all_day: boolean;
  start: string;
  end: string;
  due: string | null;
  color: string;
  tags: string[];
  attendees: string[];
  location: string | null;
  source_note_path: string | null;
}

/** Map an event input to the camelCase top-level args Tauri expects. */
export function calendarEventArgs(input: CalendarEventInput): Record<string, unknown> {
  return {
    title: input.title,
    description: input.description,
    allDay: input.all_day,
    start: input.start,
    end: input.end,
    due: input.due,
    color: input.color,
    tags: input.tags,
    attendees: input.attendees,
    location: input.location,
    sourceNotePath: input.source_note_path,
  };
}

/** All events, sorted by start. */
export const listCalendarEvents = () => call<CalendarEvent[]>("cmd_list_calendar_events");
/** One event by id. */
export const getCalendarEvent = (id: string) => call<CalendarEvent>("cmd_get_calendar_event", { id });
/** Create an event (validates title, color and range). */
export const createCalendarEvent = (input: CalendarEventInput) =>
  call<CalendarEvent>("cmd_create_calendar_event", calendarEventArgs(input));
/** Apply a partial update (nested patch keeps snake_case field names). */
export const updateCalendarEvent = (id: string, patch: CalendarEventPatch) =>
  call<CalendarEvent>("cmd_update_calendar_event", {
    id,
    patch: {
      title: patch.title,
      description: patch.description,
      all_day: patch.all_day,
      start: patch.start,
      end: patch.end,
      due: patch.due,
      color: patch.color,
      tags: patch.tags,
      attendees: patch.attendees,
      location: patch.location,
    },
  });
/** Delete an event. */
export const deleteCalendarEvent = (id: string) => call<void>("cmd_delete_calendar_event", { id });
/** Export events (optionally within `from`..`to`) as an iCalendar string. */
export const exportCalendarIcs = (from: string | null, to: string | null, calendarName: string | null) =>
  call<string>("cmd_export_calendar_ics", { from, to, calendarName });
/** Import an iCalendar string. */
export const importCalendarIcs = (content: string, overwriteExisting: boolean, defaultColor: string) =>
  call<IcsImportResult>("cmd_import_calendar_ics", { content, overwriteExisting, defaultColor });
/** Read a user-picked `.ics` file. */
export const readIcsFromPath = (path: string) => call<string>("cmd_read_ics_from_path", { path });
/** Write an `.ics` file to a user-picked path. */
export const writeIcsToPath = (path: string, content: string) =>
  call<void>("cmd_write_ics_to_path", { path, content });
/** Reminder notification settings. */
export const getReminderSettings = () => call<ReminderSettings>("cmd_get_reminder_settings");
/** Update reminder notification settings. */
export const setReminderSettings = (settings: ReminderSettings) =>
  call<void>("cmd_set_reminder_settings", { settings });
/** Ask the OS for notification permission; resolves to whether it was granted. */
export const requestNotificationPermission = () => call<boolean>("cmd_request_notification_permission");
