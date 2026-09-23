/**
 * Mock handlers for `commands/calendar_commands.rs`: ≈12 seeded events
 * spread over the current month, CRUD with the engine's validation rules,
 * iCalendar export/import, `.ics` "files" in memory and reminder settings.
 */
import type { CalendarEvent, CalendarEventPatch, IcsImportResult, ReminderSettings } from "../../types";
import {
  argBool,
  argObject,
  argOptString,
  argString,
  argStringArray,
  localDate,
  localRfc3339,
  mockUuid,
  registerReset,
  type MockArgs,
  type MockHandlerMap,
} from "./runtime";

interface CalendarState {
  events: CalendarEvent[];
  reminders: ReminderSettings;
  icsFiles: Map<string, string>;
}

function makeEvent(fields: Omit<CalendarEvent, "id" | "uid" | "created_at" | "updated_at">): CalendarEvent {
  const id = mockUuid();
  const now = new Date().toISOString();
  return { id, uid: `${id}@aether-os.local`, created_at: now, updated_at: now, ...fields };
}

function seedEvents(now: Date): CalendarEvent[] {
  const y = now.getFullYear();
  const m = now.getMonth();
  const at = (day: number, hour: number, minute = 0) => localRfc3339(new Date(y, m, day, hour, minute));
  const date = (day: number) => localDate(new Date(y, m, day));
  const today = now.getDate();
  const base = {
    description: "",
    due: null,
    tags: [] as string[],
    attendees: [] as string[],
    location: null,
    source_note_path: null,
  };
  return [
    { ...base, title: "Team Sync", all_day: false, start: at(2, 10), end: at(2, 10, 45), color: "#3b82f6", attendees: ["Mara", "Jonas", "Priya"], location: "Zoom" },
    { ...base, title: "Thesis supervisor meeting", all_day: false, start: at(5, 14), end: at(5, 15), color: "#8b5cf6", tags: ["uni"], location: "Raum 3.14", description: "Kapitel 2 besprechen" },
    { ...base, title: "Deep work: AETHER-OS", all_day: false, start: at(8, 9), end: at(8, 12), color: "#10b981", tags: ["focus"] },
    { ...base, title: "Dentist", all_day: false, start: at(11, 8, 30), end: at(11, 9, 15), color: "#f43f5e", location: "Praxis Dr. Lang" },
    { ...base, title: "Design review v0.2", all_day: false, start: at(Math.min(today, 28), 15), end: at(Math.min(today, 28), 16), color: "#3b82f6", attendees: ["Mara"], description: "Walk through the new tokens and primitives." },
    { ...base, title: "Run club", all_day: false, start: at(Math.min(today + 1, 28), 18, 30), end: at(Math.min(today + 1, 28), 19, 30), color: "#f59e0b", tags: ["health"], location: "Tempelhofer Feld" },
    { ...base, title: "Umzug: Kartons abholen", all_day: true, start: date(Math.min(today + 2, 28)), end: date(Math.min(today + 2, 28)), color: "#f97316", tags: ["umzug"] },
    { ...base, title: "Release v0.2 (target)", all_day: true, start: date(Math.min(today + 5, 28)), end: date(Math.min(today + 5, 28)), color: "#10b981", due: date(Math.min(today + 5, 28)), tags: ["aether"] },
    { ...base, title: "Conference: RustFest CFP deadline", all_day: true, start: date(18), end: date(18), color: "#ef4444", due: date(18), tags: ["career"] },
    { ...base, title: "Lunch with Jonas", all_day: false, start: at(20, 12, 30), end: at(20, 13, 30), color: "#06b6d4", location: "Markthalle Neun" },
    { ...base, title: "Weekly review", all_day: false, start: at(26, 17), end: at(26, 18), color: "#64748b", tags: ["review"] },
    { ...base, title: "Workshop: Local-first sync", all_day: true, start: date(23), end: date(24), color: "#8b5cf6", tags: ["sync"], description: "Two-day workshop, bring laptop." },
  ].map(makeEvent);
}

function seed(): CalendarState {
  return {
    events: seedEvents(new Date()),
    reminders: { enabled: true, lead_times_minutes: [10, 60] },
    icsFiles: new Map([
      [
        "/Users/demo/Downloads/team-offsite.ics",
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Demo//EN\r\nBEGIN:VEVENT\r\nUID:offsite-2026@example.com\r\nSUMMARY:Team offsite\r\nDTSTART;VALUE=DATE:" +
          localDate(new Date(new Date().getFullYear(), new Date().getMonth(), 27)).replace(/-/g, "") +
          "\r\nDTEND;VALUE=DATE:" +
          localDate(new Date(new Date().getFullYear(), new Date().getMonth(), 28)).replace(/-/g, "") +
          "\r\nLOCATION:Potsdam\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
      ],
    ]),
  };
}

let state = seed();
registerReset(() => {
  state = seed();
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateTitle(title: string): void {
  if (!title.trim()) throw new Error("invalid input: title is required");
}

function validateColor(color: string): void {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`invalid input: color must match #RRGGBB, got "${color}"`);
}

function validateRange(allDay: boolean, start: string, end: string): void {
  if (allDay) {
    if (!DATE_RE.test(start) || Number.isNaN(Date.parse(start))) throw new Error("invalid input: start date: input contains invalid characters");
    if (!DATE_RE.test(end) || Number.isNaN(Date.parse(end))) throw new Error("invalid input: end date: input contains invalid characters");
    if (end < start) throw new Error(`invalid input: end ${end} is before start ${start}`);
    return;
  }
  const rfc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
  if (!rfc.test(start) || Number.isNaN(Date.parse(start))) throw new Error("invalid input: start datetime: input contains invalid characters");
  if (!rfc.test(end) || Number.isNaN(Date.parse(end))) throw new Error("invalid input: end datetime: input contains invalid characters");
  if (Date.parse(end) < Date.parse(start)) throw new Error(`invalid input: end ${end} is before start ${start}`);
}

function sorted(): CalendarEvent[] {
  return [...state.events].sort((a, b) => a.start.localeCompare(b.start));
}

function find(id: string): CalendarEvent {
  const event = state.events.find((e) => e.id === id);
  if (!event) throw new Error(`vault error: event not found: ${id}`);
  return event;
}

function createFromArgs(args: MockArgs): CalendarEvent {
  const title = argString(args, "title");
  const allDay = argBool(args, "allDay");
  const start = argString(args, "start");
  const end = argString(args, "end");
  const color = argString(args, "color");
  validateTitle(title);
  validateColor(color);
  validateRange(allDay, start, end);
  const event = makeEvent({
    title: title.trim(),
    description: argString(args, "description"),
    all_day: allDay,
    start,
    end,
    due: argOptString(args, "due"),
    color,
    tags: argStringArray(args, "tags"),
    attendees: argStringArray(args, "attendees"),
    location: argOptString(args, "location"),
    source_note_path: argOptString(args, "sourceNotePath"),
  });
  state.events.push(event);
  return event;
}

function applyPatch(event: CalendarEvent, patch: Partial<CalendarEventPatch>): CalendarEvent {
  const next: CalendarEvent = { ...event };
  const set = <K extends keyof CalendarEventPatch>(key: K) => {
    const value = patch[key];
    if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
  };
  (["title", "description", "all_day", "start", "end", "due", "color", "tags", "attendees", "location"] as const).forEach(set);
  validateTitle(next.title);
  validateColor(next.color);
  validateRange(next.all_day, next.start, next.end);
  next.title = next.title.trim();
  next.updated_at = new Date().toISOString();
  return next;
}

// ── iCalendar ────────────────────────────────────────────────

function icsEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function icsUnescape(text: string): string {
  return text.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function toIcsStamp(value: string, allDay: boolean): string {
  if (allDay) return `;VALUE=DATE:${value.replace(/-/g, "")}`;
  return `:${new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}

/** Serialise events (optionally within `from`..`to`) as iCalendar. */
export function exportIcs(events: CalendarEvent[], from: string | null, to: string | null, name: string): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AETHER-OS//Calendar//EN", `X-WR-CALNAME:${icsEscape(name)}`];
  for (const e of events) {
    if (from && e.end.slice(0, 10) < from.slice(0, 10)) continue;
    if (to && e.start.slice(0, 10) > to.slice(0, 10)) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `SUMMARY:${icsEscape(e.title)}`,
      `DTSTART${toIcsStamp(e.start, e.all_day)}`,
      `DTEND${toIcsStamp(e.end, e.all_day)}`,
      `X-AETHER-COLOR:${e.color}`
    );
    if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
    if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
    if (e.tags.length) lines.push(`CATEGORIES:${e.tags.map(icsEscape).join(",")}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

function parseIcsDate(prop: string, value: string): { allDay: boolean; value: string } {
  if (/VALUE=DATE(?!-)/.test(prop) || /^\d{8}$/.test(value)) {
    return { allDay: true, value: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) throw new Error(`unparseable date ${value}`);
  const [, y, mo, d, h, mi, s, z] = m;
  const date = z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return { allDay: false, value: localRfc3339(date) };
}

/** Parse and merge an iCalendar document into the store. */
export function importIcs(content: string, overwrite: boolean, defaultColor: string): IcsImportResult {
  if (!content.includes("BEGIN:VCALENDAR")) throw new Error("invalid input: not an iCalendar file (missing BEGIN:VCALENDAR)");
  const unfolded = content.replace(/\r?\n[ \t]/g, "");
  const result: IcsImportResult = { added: 0, updated: 0, skipped: 0, errors: [] };
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const props = new Map<string, { params: string; value: string }>();
    for (const line of body.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const [name, ...params] = line.slice(0, idx).split(";");
      props.set(name.toUpperCase(), { params: params.join(";"), value: line.slice(idx + 1) });
    }
    const uid = props.get("UID")?.value ?? mockUuid();
    if (props.has("RRULE")) {
      result.skipped += 1;
      result.errors.push(`skipped recurring event ${uid}: recurrence is not supported`);
      continue;
    }
    try {
      const startProp = props.get("DTSTART");
      if (!startProp) throw new Error("missing DTSTART");
      const start = parseIcsDate(startProp.params, startProp.value);
      const endProp = props.get("DTEND");
      const end = endProp ? parseIcsDate(endProp.params, endProp.value) : start;
      const color = props.get("X-AETHER-COLOR")?.value ?? defaultColor;
      const fields = {
        title: icsUnescape(props.get("SUMMARY")?.value ?? "Untitled event"),
        description: icsUnescape(props.get("DESCRIPTION")?.value ?? ""),
        all_day: start.allDay,
        start: start.value,
        end: end.value < start.value ? start.value : end.value,
        due: null,
        color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#3b82f6",
        tags: (props.get("CATEGORIES")?.value ?? "").split(",").map((t) => icsUnescape(t.trim())).filter(Boolean),
        attendees: [],
        location: props.has("LOCATION") ? icsUnescape(props.get("LOCATION")!.value) : null,
        source_note_path: null,
      };
      validateRange(fields.all_day, fields.start, fields.end);
      const existing = state.events.find((e) => e.uid === uid);
      if (existing) {
        if (!overwrite) {
          result.skipped += 1;
          continue;
        }
        Object.assign(existing, fields, { updated_at: new Date().toISOString() });
        result.updated += 1;
      } else {
        state.events.push({ ...makeEvent(fields), uid });
        result.added += 1;
      }
    } catch (error) {
      result.errors.push(`${uid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function validateIcsPath(path: string): string {
  if (!path.trim()) throw new Error("path is empty");
  if (!/\.ics$/i.test(path)) throw new Error("path must end in .ics");
  return path;
}

export const calendarHandlers: MockHandlerMap = {
  cmd_list_calendar_events: () => sorted(),
  cmd_get_calendar_event: (args) => find(argString(args, "id")),
  cmd_create_calendar_event: (args) => createFromArgs(args),
  cmd_update_calendar_event: (args) => {
    const event = find(argString(args, "id"));
    const updated = applyPatch(event, argObject<CalendarEventPatch>(args, "patch"));
    state.events = state.events.map((e) => (e.id === updated.id ? updated : e));
    return updated;
  },
  cmd_delete_calendar_event: (args) => {
    const id = argString(args, "id");
    find(id);
    state.events = state.events.filter((e) => e.id !== id);
  },
  cmd_export_calendar_ics: (args) =>
    exportIcs(sorted(), argOptString(args, "from"), argOptString(args, "to"), argOptString(args, "calendarName") ?? "AETHER-OS"),
  cmd_import_calendar_ics: (args) =>
    importIcs(argString(args, "content"), argBool(args, "overwriteExisting"), argString(args, "defaultColor")),
  cmd_write_ics_to_path: (args) => {
    const path = validateIcsPath(argString(args, "path"));
    state.icsFiles.set(path, argString(args, "content"));
  },
  cmd_read_ics_from_path: (args) => {
    const path = validateIcsPath(argString(args, "path"));
    const content = state.icsFiles.get(path);
    if (content === undefined) throw new Error(`file does not exist: ${path}`);
    return content;
  },
  cmd_get_reminder_settings: () => state.reminders,
  cmd_set_reminder_settings: (args) => {
    const settings = argObject<ReminderSettings>(args, "settings");
    if (typeof settings.enabled !== "boolean" || !Array.isArray(settings.lead_times_minutes)) {
      throw new Error("invalid args `settings` for command: expected { enabled, lead_times_minutes }");
    }
    state.reminders = {
      enabled: settings.enabled,
      lead_times_minutes: settings.lead_times_minutes.filter((n) => Number.isFinite(n) && n >= 0),
    };
  },
  cmd_request_notification_permission: () => true,
};
