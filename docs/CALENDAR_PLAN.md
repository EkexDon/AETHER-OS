# AETHER-OS — Calendar Tab Implementation Plan

**Goal:** Add a new `Calendar` tab (Phase 3.2) with month / week / day views, full event CRUD, color customization, tags, attendees, and full AI agent integration (create / update / delete / list).

**Storage:** Per-event JSON files under `~/Library/Application Support/com.ekin.aetheros/calendar/events/<uuid>.json` (matches the `AetherNotes` pattern at `src-tauri/src/engine/aether_notes.rs:5-60`).

**AI integration:** Full CRUD — `create_calendar_event`, `update_calendar_event`, `delete_calendar_event`, `list_calendar_events` — all routed through the existing agent action pipeline with the same approval modal pattern as the other destructive actions.

**ICS import/export:** full round-trip with Google Calendar / Apple Calendar. Export filters by date range, import deduplicates by `UID`.

**Desktop notifications:** scheduled reminders at user-configurable lead times (default 15min + at-start). Uses `tauri-plugin-notification` (Tauri 2).

---

## 1. Data model

### 1.1 `CalendarEvent` (Rust, in new `src-tauri/src/engine/calendar.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalendarEvent {
    pub id: String,                    // uuid v4
    pub title: String,
    pub description: String,           // markdown
    /// All-day events store only the date ("YYYY-MM-DD"); timed events store
    /// a full RFC3339 timestamp in `start` and an end time. The `all_day`
    /// flag disambiguates.
    pub all_day: bool,
    /// "YYYY-MM-DD" when all_day, RFC3339 when timed.
    pub start: String,
    /// Same format as start. Required, not optional — an event without an
    /// end is just a deadline, and we have `due` for that.
    pub end: String,
    /// Optional deadline independent of start/end (e.g. "prep this by 5pm").
    /// Same format as start.
    pub due: Option<String>,
    pub color: String,                 // hex like "#3b82f6" — chosen from palette
    pub tags: Vec<String>,             // free-form, like Obsidian tags
    pub attendees: Vec<String>,        // free-form names/emails, not validated
    pub location: Option<String>,
    pub source_note_path: Option<String>, // set when created from a vault note
    pub created_at: String,            // RFC3339, set on create
    pub updated_at: String,            // RFC3339, set on every write
}
```

**Validation rules** (in `Calendar::create` / `update`):
- `title` non-empty after trim.
- `end >= start` (string-comparable for date format, parsed-comparable for timed).
- `color` matches `^#[0-9a-fA-F]{6}$`.
- For non–all-day events, both `start` and `end` parse as RFC3339.

### 1.2 Date / time handling

- Rust uses the already-pinned `chrono = "=0.4.38"` (see `src-tauri/Cargo.toml:24`).
- Frontend has no date lib yet — we'll add **`date-fns` (^3.6.0)**. It's tree-shakeable, has `format`, `parseISO`, `startOfWeek`, `eachDayOfInterval`, `isSameDay`, `addDays`, `subDays`, `startOfMonth`, `endOfMonth`, `addMonths`, `subMonths`. Smaller than dayjs/moment; no need for the full locale baggage.
- Storage format: ISO date strings (`YYYY-MM-DD`) for all-day, ISO datetime with local timezone offset for timed. The frontend normalises to the user's local timezone for display.

### 1.3 Color palette

Hard-coded in `src/lib/calendarColors.ts` as 8 hex values matching the existing AETHER accent palette in `src/styles.css`:

```ts
export const CALENDAR_COLORS = [
  "#7c3aed", // aether purple (default)
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#ec4899", // pink
  "#14b8a6", // teal
  "#6b7280", // gray
];
```

---

## 2. Rust backend

### 2.1 Engine — `src-tauri/src/engine/calendar.rs` (new)

Mirror the structure of `aether_notes.rs` exactly:

- `pub struct Calendar { storage_dir: PathBuf }`
- `impl Calendar { pub fn new(storage_dir: &Path) -> Result<Self, AetherError> }`
- `pub fn create(&self, ...) -> Result<CalendarEvent, AetherError>`
- `pub fn get(&self, id: &str) -> Result<CalendarEvent, AetherError>`
- `pub fn list(&self) -> Result<Vec<CalendarEvent>, AetherError>` — sorted by `start` ascending
- `pub fn update(&self, id: &str, patch: EventPatch) -> Result<CalendarEvent, AetherError>` — reads existing, applies patch, sets `updated_at`, writes
- `pub fn delete(&self, id: &str) -> Result<(), AetherError>`

`EventPatch` is a struct of `Option<T>` for every mutable field, so the AI can update just the title without re-sending the whole event. Only fields that are `Some(_)` get applied.

**Concurrency:** `std::sync::Mutex<Vec<CalendarEvent>>` is overkill for personal use; per-file `std::fs::write` is atomic enough (the OS guarantees single-sector atomicity for small writes, and our files are <2KB). If two writes race, the loser's file wins on disk but the in-memory state stays consistent because every read re-reads from disk. Document this in the module header.

**Unit tests** (mirroring `aether_notes.rs:104-148`):
- `creates_and_lists_events`
- `updates_event_preserves_id_and_created_at`
- `deletes_an_event`
- `rejects_empty_title`
- `rejects_end_before_start`
- `rejects_invalid_color`

### 2.2 Tauri commands — `src-tauri/src/commands/calendar_commands.rs` (new)

```rust
#[tauri::command]
pub async fn cmd_list_calendar_events(state: State<'_, AppState>) -> Result<Vec<CalendarEvent>, String>;

#[tauri::command]
pub async fn cmd_get_calendar_event(state: State<'_, AppState>, id: String) -> Result<CalendarEvent, String>;

#[tauri::command]
pub async fn cmd_create_calendar_event(
    state: State<'_, AppState>,
    title: String,
    description: String,
    all_day: bool,
    start: String,
    end: String,
    due: Option<String>,
    color: String,
    tags: Vec<String>,
    attendees: Vec<String>,
    location: Option<String>,
    source_note_path: Option<String>,
) -> Result<CalendarEvent, String>;

#[tauri::command]
pub async fn cmd_update_calendar_event(
    state: State<'_, AppState>,
    id: String,
    patch: EventPatch,
) -> Result<CalendarEvent, String>;

#[tauri::command]
pub async fn cmd_delete_calendar_event(state: State<'_, AppState>, id: String) -> Result<(), String>;
```

`EventPatch` is re-exported (it's defined in the engine module and the command forwards the full struct).

### 2.3 Wire into `AppState` and `lib.rs`

- `src-tauri/src/lib.rs:8-12` — add `calendar::Calendar` to the engine import.
- `src-tauri/src/lib.rs:15-34` — add `pub calendar: Arc<Calendar>` to `AppState`.
- `src-tauri/src/lib.rs:50-66` — instantiate in `setup`: `let calendar = Calendar::new(&data_dir.join("calendar"))?;`
- `src-tauri/src/lib.rs:70-154` — register all 5 new commands in `invoke_handler!`.
- `src-tauri/src/commands/mod.rs` — add `pub mod calendar_commands;`

### 2.4 AI agent action — `src-tauri/src/engine/agent_actions.rs`

Add three new variants to the `AgentAction` enum (currently 7 variants in `src/types/index.ts:210-217`):

```rust
| { action: "create_calendar_event"; title: String; description: String; all_day: bool; start: String; end: String; due: Option<String>; color: Option<String>; tags: Vec<String>; attendees: Vec<String>; location: Option<String> }
| { action: "update_calendar_event"; id: String; title: Option<String>; description: Option<String>; all_day: Option<bool>; start: Option<String>; end: Option<String>; due: Option<String>; color: Option<String>; tags: Option<Vec<String>>; attendees: Option<Vec<String>>; location: Option<String> }
| { action: "delete_calendar_event"; id: String }
| { action: "list_calendar_events"; from: Option<String>; to: Option<String> }
```

`execute_action` (already in `agent_actions.rs`) gets three new match arms that delegate to the `Calendar` engine. Return values:
- `create` → `AgentActionResult` with `kind: "calendar_event_created"`, payload `{ event: CalendarEvent }`
- `update` → `kind: "calendar_event_updated"`, payload `{ event: CalendarEvent }`
- `delete` → `kind: "calendar_event_deleted"`, payload `{ id: String }`
- `list` → `kind: "calendar_events_listed"`, payload `{ events: Vec<CalendarEvent> }`

Add the corresponding `AgentActionResult*` variants to `src/types/index.ts` and to the typed `AgentActionResult` union in `src/lib/ipc.ts:251-255`.

The existing flow is: AI emits ` ```action ` JSON, the chat panel parses, shows a chip with a confirm button, on confirm it calls `cmd_execute_agent_action` and shows the result. **Update/delete are destructive** — they must route through the existing approval modal (the one that's already in the chat panel for safe writes; we extend the same modal to require explicit confirmation for `update` and `delete`). The `create` action can stay as auto-confirmed (it matches the current "safe-write" policy).

### 2.5 CORS / event payload for the agent

When the AI lists events, the response payload can be large. Clamp the result to a date range that the AI should specify (`from` / `to`). If omitted, default to `today ± 30 days` server-side. Add this clamp inside `execute_action`'s `list_calendar_events` arm so the AI can never accidentally pull a 10k-event payload.

---

## 3. Frontend

### 3.1 New types — `src/types/index.ts`

Add at the bottom of the existing file:

```ts
export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  all_day: boolean;
  start: string;       // "YYYY-MM-DD" or RFC3339
  end: string;
  due: string | null;
  color: string;       // hex
  tags: string[];
  attendees: string[];
  location: string | null;
  source_note_path: string | null;
  created_at: string;
  updated_at: string;
}

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

export type CalendarView = "month" | "week" | "day";
```

Extend `AgentAction` (currently at `src/types/index.ts:210-217`) with four new variants matching the Rust enum.
Extend the `AgentActionResult` union in `src/lib/ipc.ts:251-255` with four new variants.

### 3.2 IPC wrappers — `src/lib/ipc.ts`

Add after the existing note-editing block (~line 244):

```ts
export const listCalendarEvents = () => call<CalendarEvent[]>("cmd_list_calendar_events");
export const getCalendarEvent = (id: string) => call<CalendarEvent>("cmd_get_calendar_event", { id });
export const createCalendarEvent = (input: Omit<CalendarEvent, "id" | "created_at" | "updated_at">) =>
  call<CalendarEvent>("cmd_create_calendar_event", input);
export const updateCalendarEvent = (id: string, patch: CalendarEventPatch) =>
  call<CalendarEvent>("cmd_update_calendar_event", { id, patch });
export const deleteCalendarEvent = (id: string) => call<void>("cmd_delete_calendar_event", { id });
```

### 3.3 Store — `src/lib/store.ts`

Add to the `AetherState` interface and implementation:

```ts
calendarEvents: CalendarEvent[];
calendarView: CalendarView;     // default "month"
calendarDate: string;            // ISO date string "YYYY-MM-DD" of the focused day
setCalendarEvents: (events: CalendarEvent[]) => void;
upsertCalendarEvent: (event: CalendarEvent) => void;
removeCalendarEvent: (id: string) => void;
setCalendarView: (v: CalendarView) => void;
setCalendarDate: (d: string) => void;
```

`upsertCalendarEvent` matches by `id` and replaces in place, so the UI doesn't have to re-fetch after create/update.

### 3.4 ViewMode extension

`src/lib/store.ts:4` currently has `ViewMode = "dashboard" | "search" | ... | "ide"`. Add `"calendar"`.

### 3.5 Component — `src/components/Calendar.tsx` (new)

Top-level structure:

```
<Calendar>
  <CalendarToolbar />   // Today | < > | "October 2026" | [Month|Week|Day] | + New
  <CalendarGrid />      // switches on calendarView
  <CalendarEventList /> // right rail, shows the focused day's events in detail
  {editorOpen && <EventEditorModal />}
</Calendar>
```

**Month view** (`CalendarMonthGrid`): 7-column grid, 6 rows. Each cell shows date number, dot indicators for events (up to 3 dots colored by event.color, "+N more" if overflow). Click a day → sets `calendarDate` and switches the right rail to show that day's events. Click a dot → opens the event editor in read mode. Click the empty cell → opens the event editor in create mode with that date pre-filled.

**Week view** (`CalendarWeekGrid`): 7 columns × 24 rows. Each column is a day; events are absolutely positioned blocks proportional to their duration. All-day events render as a strip at the top. Click an empty slot → create event at that hour on that day. Click an event block → open editor.

**Day view** (`CalendarDayGrid`): Same as week view but a single column, more vertical space per hour. Same interactions.

**Navigation:**
- `Today` button → sets `calendarDate` to today.
- `←` / `→` arrows → step by month (month view) or week (week view) or day (day view).
- Clicking the centered title opens a month picker (small popover with the year + 12 month grid).

**Right rail (`CalendarEventList`):**
- Shows events whose `start` is on `calendarDate` (or whose date range includes it, for multi-day events).
- Each event: color stripe on the left, title (bold), time range (or "All day"), tags as chips, attendees as avatar-style initials in a row, location (if any).
- Click → open editor.
- Hover → shows a delete (trash) icon in the top-right corner.
- Empty state: "No events for this day" with a "+ New event" button.

**State management:**
- On mount, call `listCalendarEvents()` once and seed the store.
- After any create/update/delete (from the editor or via AI), update the store in place via `upsertCalendarEvent` / `removeCalendarEvent`. No re-fetch needed.

### 3.6 Event editor modal — `src/components/EventEditorModal.tsx` (new)

Modal pattern matches `QuickCapture.tsx` (overlay + centred card). Fields:

| Field | Control |
|-------|---------|
| **Title** | `<input>` (required, autofocus) |
| **All day** | toggle / checkbox |
| **Starts** | date input (always); time input (only when all-day is off) |
| **Ends** | date input (always); time input (only when all-day is off) |
| **Duration** | read-only text "2h 30m" computed live (only when all-day is off) |
| **Due** | date+time input, optional, with a "clear" button |
| **Tags** | tag input — type a tag, hit Enter, chip appears. Backspace on empty input removes last chip. Matches the existing tag input pattern in `NoteEditor` if any, otherwise hand-roll it from a small inline component. |
| **Attendees** | same chip input pattern, but with a small "user" icon on each chip and a different background. Optional. |
| **Location** | single-line text input, optional |
| **Description** | `<textarea>`, optional, ~6 rows, accepts markdown |
| **Color** | 8 swatches in a row, click to select. The selected one has a ring. |
| **Source note** | read-only text, only shown if `source_note_path` is set (set automatically when the AI creates the event from a note context) |

**Buttons (footer):**
- Left: "Delete" (only when editing an existing event) — red text, confirms with a second click or a confirm popover.
- Right: "Cancel" (closes), "Save" (primary, disabled if title is empty or end < start).

**Behaviour:**
- `Cmd+Enter` saves, `Esc` cancels.
- On save: call `createCalendarEvent` or `updateCalendarEvent`, then `upsertCalendarEvent`, then close.
- On delete: confirm, call `deleteCalendarEvent`, then `removeCalendarEvent`, then close.
- Open with `null` event → create mode. Open with a `CalendarEvent` → edit mode.

### 3.7 Wire the tab into the shell — `src/App.tsx`

Three changes:

1. **Line 2** — add `Calendar` to the lucide-react import.
2. **Line ~17** — add `import { Calendar } from "./components/Calendar";` (lazy-loaded like the IDE since it's not always open):
   ```ts
   const CalendarView = lazy(() =>
     import("./components/Calendar").then((m) => ({ default: m.Calendar }))
   );
   ```
3. **Line 150-162** — add to `navItems`:
   ```ts
   { mode: "calendar", icon: <Calendar size={18} />, label: "Calendar" },
   ```
4. **Line ~212-231** — add the view switch:
   ```tsx
   {view === "calendar" && (
     <Suspense fallback={<div className="ide-loading"><Loader2 size={20} className="spin" /> Loading calendar…</div>}>
       <CalendarView />
     </Suspense>
   )}
   ```

Place the new nav item between `editor` and `ide` to keep it near the front (it's a primary workflow surface). Adjust index in `navItems` accordingly.

### 3.8 Add `date-fns` to `package.json`

`"date-fns": "^3.6.0"` under `dependencies`. Vite's tree-shaker will pull only the functions we use.

---

## 4. Styles — `src/styles.css`

Add a new section at the end (file is currently 1× single CSS file; check it before editing). Variables to follow the existing theme system (already using CSS custom properties for the dark mode / aether purple).

Required CSS classes (minimal subset — full styles will be drafted in the implementation pass):

```css
.calendar-view { ... }
.calendar-toolbar { ... }
.calendar-month-grid { ... }
.calendar-week-grid { ... }
.calendar-day-grid { ... }
.calendar-cell { ... }
.calendar-cell-other-month { ... opacity: 0.4 }
.calendar-cell-today { ... border: 1px solid var(--accent) }
.calendar-event-pill { ... }
.calendar-event-block { ... }   /* for week/day views */
.calendar-event-list { ... }    /* right rail */
.calendar-event-row { ... }
.calendar-event-color-stripe { ... }
.calendar-tag-chip { ... }
.calendar-attendee-chip { ... }
.calendar-color-swatch { ... }
.calendar-color-swatch.selected { ... box-shadow: 0 0 0 2px var(--accent) }

.event-editor-overlay { ... }   /* same pattern as .quick-capture-overlay */
.event-editor-modal { ... }
.event-editor-field { ... }
.event-editor-field-label { ... }
.event-editor-chip-input { ... }
.event-editor-chip { ... }
.event-editor-color-row { ... }
.event-editor-footer { ... }
.event-editor-delete { ... color: #ef4444; }
```

The exact values will be tuned during implementation to match the existing AETHER aesthetic (dark panels, purple accent, subtle borders). No new CSS variables needed; reuse what's there.

---

## 5. Tests

### 5.1 Rust — `src-tauri/src/engine/calendar.rs`

Inline `#[cfg(test)]` module at the bottom of the file. Tests (mirror `aether_notes.rs:104-148`):

- `creates_and_lists_events` — happy path, list returns the created event
- `updates_event_preserves_id_and_created_at` — only the patched fields change
- `deletes_an_event` — list returns empty after delete
- `rejects_empty_title` — returns error
- `rejects_end_before_start` — returns error
- `rejects_invalid_color` — non-hex color rejected
- `list_is_sorted_by_start` — chronological order

### 5.2 Frontend — `src/components/Calendar.test.tsx` (new)

Vitest + React Testing Library (already in the dev deps — see `package.json:58-70`). One smoke test:

- Renders the toolbar with the current month name and a "New" button.
- Smoke test only — full interaction tests would require a mock IPC layer that's currently not set up for any component (see `SystemMonitor.test.tsx`, `Browser.test.tsx`, `Terminal.test.tsx` for the existing pattern).

### 5.3 Manual verification checklist (run after build)

- Open the Calendar tab → month grid renders with today's date highlighted.
- Create an event from a day's empty cell → modal opens with that date pre-filled.
- Save → event appears in the month grid (dot) and the right rail.
- Click the event pill → editor opens in update mode.
- Edit the title, save → dot + rail update in place.
- Change the color → dot color updates.
- Add a tag, remove it → chip input behaves correctly.
- Switch to week view → event block renders at the right time, proportional to duration.
- Switch to day view → single-column version, same event block.
- Delete the event → disappears everywhere.
- Open a chat with the agent, ask "what meetings do I have next week?" → agent calls `list_calendar_events` and shows a chip with the result.
- Ask the agent to "book a meeting with Anna tomorrow at 3pm about the roadmap" → agent emits `create_calendar_event`, the chat panel shows the confirm chip, clicking confirm creates the event.
- Ask the agent to "move that meeting to 4pm" → emits `update_calendar_event`, requires explicit confirm in the modal, on confirm the event shifts.
- `npm run build` → no TS errors.
- `cargo test --manifest-path src-tauri/Cargo.toml` → all green.
- `npm test` → all green.

---

## 6. File-by-file change list

| File | Action | Approx. LOC |
|------|--------|-------------|
| `src-tauri/src/engine/calendar.rs` | **create** | ~250 (incl. tests) |
| `src-tauri/src/commands/calendar_commands.rs` | **create** | ~80 |
| `src-tauri/src/commands/mod.rs` | edit (+1 line) | 1 |
| `src-tauri/src/lib.rs` | edit (import + state + register) | ~10 |
| `src-tauri/src/engine/agent_actions.rs` | edit (4 new action variants + arms) | ~60 |
| `src/types/index.ts` | edit (3 new types + 4 action variants) | ~50 |
| `src/lib/ipc.ts` | edit (5 new wrappers + 4 result variants) | ~40 |
| `src/lib/store.ts` | edit (ViewMode + 5 fields + 5 setters) | ~30 |
| `src/components/Calendar.tsx` | **create** | ~450 |
| `src/components/Calendar.test.tsx` | **create** | ~30 |
| `src/components/EventEditorModal.tsx` | **create** | ~250 |
| `src/lib/calendarColors.ts` | **create** | ~15 |
| `src/App.tsx` | edit (import + navItems + view switch) | ~10 |
| `src/styles.css` | edit (new section at end) | ~180 |
| `package.json` | edit (+`date-fns`) | 1 |
| `AETHER-OS-FEATURE-ROADMAP.md` | edit (flip 3.2 to ✅) | 2 |

**Total new code: ~1,100 LOC. Total edits: ~6 small touches across existing files.**

---

## 7. ICS import / export

### 7.1 Crate

Add `icalendar = "0.7"` to `src-tauri/Cargo.toml` (most actively maintained ICS parser/writer for Rust; supports RFC 5545 read + write).

### 7.2 Export

New module `src-tauri/src/engine/calendar_ics.rs`:

```rust
pub struct IcsExportOptions {
    pub from: Option<String>,  // "YYYY-MM-DD" or RFC3339, lower bound
    pub to: Option<String>,    // upper bound
    pub calendar_name: String, // default "AETHER-OS"
}

pub fn export_calendar(events: &[CalendarEvent], opts: &IcsExportOptions) -> String;
```

- Returns a single VCALENDAR string with one VEVENT per `CalendarEvent`.
- `UID` = `<event.id>@aether-os.local` (stable, allows round-trip dedupe).
- `DTSTAMP` = now.
- `DTSTART` / `DTEND`: for `all_day` events use `VALUE=DATE` (`20261010`); for timed events use the RFC3339 timestamp.
- `SUMMARY` = title, `DESCRIPTION` = description, `LOCATION` = location.
- `CATEGORIES` = tags (comma-separated).
- `ATTENDEE` lines = attendees (one per attendee, `CN=` for display name).
- `X-AETHER-COLOR` = custom property carrying the color hex (non-standard but useful for re-import).
- `X-AETHER-SOURCE-NOTE` = `source_note_path` if present.
- CRLF line endings per RFC 5545.
- The frontend will call this through a command that writes the string to a path the user picks via the dialog plugin, so no extra Tauri-side file write deps.

### 7.3 Import

```rust
pub struct IcsImportOptions {
    pub overwrite_existing: bool,  // default false: skip if UID matches an existing event
    pub default_color: String,     // applied to imported events that lack X-AETHER-COLOR
}

pub struct IcsImportResult {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub errors: Vec<String>,  // line + reason per unparseable VEVENT
}

pub fn import_calendar(ics: &str, opts: &IcsImportOptions) -> Result<(Vec<CalendarEvent>, IcsImportResult), AetherError>;
```

- Parse via `icalendar::Calendar::parse`.
- For each VEVENT: extract UID (generate a fresh one if missing), SUMMARY, DTSTART/DTEND (detect DATE vs DATETIME), DESCRIPTION, LOCATION, CATEGORIES, ATTENDEE CNs, X-AETHER-COLOR, X-AETHER-SOURCE-NOTE.
- Build a `CalendarEvent` and return the list. The command layer (in `calendar_commands.rs`) is responsible for the dedupe decision: it receives the list, checks each UID against `Calendar::list()` (only on file, not in memory, to keep the engine simple), and creates/updates accordingly. The engine function above is a pure parser.

**File handling on the command side:**
- The frontend uses `@tauri-apps/plugin-dialog` `open()` to get the .ics path, then `readTextFile()` (or a new `cmd_read_text_file` if the FS plugin isn't already there — check; otherwise use the existing `ideReadFile` style, but that one is sandboxed to project dirs, so a generic read would need a new command or a fs plugin). **Decision: add `cmd_read_ics_file(path: String) -> Result<String, String>` and `cmd_write_ics_file(path: String, content: String) -> Result<(), String>` as the two thin file-IO commands.** Path validation: must end in `.ics`, must be a regular file, must be readable/writable by the user. No path sandboxing — the user explicitly picked it.

### 7.4 UI

New component `src/components/CalendarImportExportDialog.tsx`:
- Two tabs: **Export** and **Import**.
- Export tab: date range pickers (from / to), "Export" button → opens save dialog → calls `exportCalendarToFile` → success toast.
- Import tab: file picker (default filter: `.ics`) → calls `importCalendarFromFile` → result dialog showing `added / updated / skipped / N errors`, with collapsible error list.
- Accessible from a small "Import / Export" button in the calendar toolbar.

---

## 8. Desktop notifications

### 8.1 Crate + plugin

- Add `tauri-plugin-notification = "2"` to `src-tauri/Cargo.toml`.
- Add `@tauri-apps/plugin-notification` to `package.json`.
- Register in `src-tauri/src/lib.rs`: `.plugin(tauri_plugin_notification::init())`.
- Add notification permissions to `src-tauri/capabilities/default.json` (or whatever the capabilities file is — verify during implementation). Required: `notification:default` (granted) + `notification:allow-notify`, `notification:allow-request-permission`, `notification:allow-is-permission-granted`.

### 8.2 Notification engine

New module `src-tauri/src/engine/calendar_notifier.rs`:

```rust
pub struct ReminderSettings {
    pub enabled: bool,                  // master switch
    pub lead_times_minutes: Vec<u32>,   // default [15, 0] (15min before + at start)
}

pub struct CalendarNotifier {
    app: tauri::AppHandle,
    settings_path: PathBuf,             // ~/.../com.ekin.aetheros/calendar/reminders.json
}

impl CalendarNotifier {
    pub fn new(app: &tauri::AppHandle, data_dir: &Path) -> Result<Self, AetherError>;
    pub fn settings(&self) -> ReminderSettings;
    pub fn set_settings(&self, settings: ReminderSettings) -> Result<(), AetherError>;

    /// Spawn the background scheduler. Polls every 60s. Reads events from
    /// the Calendar engine, fires a notification for any reminder whose
    /// trigger time falls in the [now-60s, now+5s] window and hasn't
    /// already been delivered this session (dedupe by event id + lead time).
    pub fn start(self: Arc<Self>, calendar: Arc<Calendar>) -> Result<(), AetherError>;

    /// Cancel all pending notifications (e.g. on event delete / update).
    pub fn reschedule(&self);
}
```

**Dedupe:** keep an in-memory `HashSet<(String, u32)>` of "delivered" `(event_id, lead_minutes)` tuples. Persist the set to `reminders_state.json` on every fire so restarts don't re-fire old reminders. Reset daily (entries older than 24h are pruned on load).

**Permission request:** on first `start()`, call `app.notification().request_permission()`. If denied, log and disable silently — the UI will show a "notifications blocked" hint in the reminder settings.

**Notification body:** `Title: <event title>`, `Body: <time range or "All day">` + "in 15 minutes" prefix depending on lead time. For multi-day all-day events, body = "starts in 15 minutes (Oct 10–12)".

### 8.3 Wire-in

- `AppState` gets `pub notifier: Arc<CalendarNotifier>` (constructed in `setup` after the calendar).
- `cmd_get_reminder_settings` / `cmd_set_reminder_settings` for the UI.
- `cmd_request_notification_permission` for the explicit "enable" button.
- The notifier's `start()` is called once at app startup, with a `Arc<Calendar>` reference. After any `create` / `update` / `delete` calendar command, call `notifier.reschedule()` (cheap — it just clears the in-memory pending-fire set and the next tick re-evaluates).
- On Tauri `RunEvent::Exit`, the notifier's polling task ends with the runtime; no extra cleanup needed.

### 8.4 UI

- A small "🔔" toggle in the calendar toolbar opens `ReminderSettingsDialog.tsx`.
- Dialog contents:
  - Master switch: "Enable notifications"
  - When disabled, the macOS / system permission status is shown (granted / denied / not-asked) with a "Request permission" button.
  - When enabled: checklist of lead times — `[ ] 1 day before`, `[ ] 1 hour before`, `[ ] 30 min before`, `[ ] 15 min before`, `[ ] 5 min before`, `[ ] At start`. User picks any combination.
  - Preview: "You will be notified 15 minutes before each event, and again when it starts."
- Settings persist via the engine; reload on app open.

### 8.5 Why a polling scheduler and not `tokio::time::sleep` per event?

Simpler reasoning, no leaked timers, easy to reschedule on event edits, and 60s resolution is fine for a reminder. The window `[now-60s, now+5s]` guarantees we don't miss a reminder that fires at the top of a minute, and prevents double-firing if the tick lands a few seconds late.

---

## 9. Risks & open questions

1. **Timezone handling for timed events.** Decision: store RFC3339 with the user's local offset at creation time, do not convert on display. This means an event created on the road in another timezone will look "off" when viewed at home, but it matches what Apple Calendar / Google Calendar do for "floating" events and avoids a hard dep on `chrono-tz`. Documented in the engine module header.
2. **All-day multi-day events.** Decision: for an all-day event spanning 2+ days, `start = "2026-10-10"`, `end = "2026-10-12"` means the event occupies Oct 10, 11, 12 in the month grid (end-exclusive). The right rail will show it on each of those days.
3. **Attendees free-form.** Not validated against any contact store. If you want real attendee management later, that's a v2 feature.
4. **Notification permission UX on first run.** Decision: don't auto-request on app start. The user has to enable reminders in the settings dialog, which is when we ask. This avoids the "scary first-run permission popup" that gets denied reflexively.
5. **Vault `due:` integration.** The `VaultTask.due` field exists in the type system but the index parser is a separate concern. The calendar will **not** read tasks from notes in this cut. If you want a future "tasks view" on the calendar, that's a separate `vault_tasks_due` engine pass.
6. **AI prompt context.** The agent's system prompt should mention the new actions. Update `src-tauri/src/engine/local_ai.rs` / `cloud_ai.rs` system prompt (find where the existing `create_note` action is listed) to advertise the four new actions with their JSON shape. Without this, the AI won't know it can book meetings.
7. **ICS recurring events (`RRULE`).** Out of scope. The importer will skip VEVENTs with RRULE and report them in the error list. A future pass adds a "recur" field on `CalendarEvent` and expands occurrences client-side.

---

## 10. File-by-file change list

| File | Action | Approx. LOC |
|------|--------|-------------|
| `src-tauri/Cargo.toml` | edit (+`icalendar`, +`tauri-plugin-notification`) | 2 |
| `src-tauri/capabilities/default.json` | edit (notification perms) | 10 |
| `src-tauri/src/engine/calendar.rs` | **create** | ~250 (incl. tests) |
| `src-tauri/src/engine/calendar_ics.rs` | **create** | ~200 (incl. tests) |
| `src-tauri/src/engine/calendar_notifier.rs` | **create** | ~200 (incl. tests) |
| `src-tauri/src/commands/calendar_commands.rs` | **create** | ~150 (10 commands) |
| `src-tauri/src/commands/mod.rs` | edit (+1 line) | 1 |
| `src-tauri/src/lib.rs` | edit (import + state + register plugin + commands) | ~25 |
| `src-tauri/src/engine/agent_actions.rs` | edit (5 new action variants + arms) | ~100 |
| `src/types/index.ts` | edit (3 new types + 5 action variants) | ~60 |
| `src/lib/ipc.ts` | edit (10 new wrappers + 5 result variants) | ~80 |
| `src/lib/store.ts` | edit (ViewMode + fields + setters + reminderSettings) | ~40 |
| `src/components/Calendar.tsx` | **create** | ~500 |
| `src/components/Calendar.test.tsx` | **create** | ~30 |
| `src/components/EventEditorModal.tsx` | **create** | ~280 |
| `src/components/CalendarImportExportDialog.tsx` | **create** | ~150 |
| `src/components/ReminderSettingsDialog.tsx` | **create** | ~120 |
| `src/lib/calendarColors.ts` | **create** | ~15 |
| `src/App.tsx` | edit (import + navItems + view switch + ICS import in toolbar) | ~15 |
| `src/styles.css` | edit (new sections at end) | ~280 |
| `package.json` | edit (+`date-fns`, +`@tauri-apps/plugin-notification`) | 2 |
| `AETHER-OS-FEATURE-ROADMAP.md` | edit (flip 3.2 to ✅) | 2 |

**Total new code: ~2,200 LOC. Total edits: ~8 small touches across existing files.**

---

## 11. Implementation order (subagent-friendly slicing)

The work splits cleanly into **9 parallel-safe slices** after deps + types are committed. All slices assume types are committed first.

1. **Cargo + npm deps + capability file + plugin registration.** Foundation; no code yet.
2. **Rust calendar engine + commands.** Independent, no UI needed for `cargo test` to pass.
3. **Rust ICS import/export engine + commands.** Depends on 2 for the `CalendarEvent` type.
4. **Rust notification engine + commands.** Depends on 2 for events + 1 for the plugin.
5. **AI agent action variants.** Depends on 2 (engine ref) and 3 (ICS import action).
6. **IPC wrappers + store + types.** Depends on types only (those are committed first).
7. **`calendarColors.ts` + `EventEditorModal` + `CalendarImportExportDialog` + `ReminderSettingsDialog`.** Independent UI primitives.
8. **`Calendar.tsx`.** Depends on 6 + 7.
9. **`App.tsx` tab wiring + `styles.css` + tests + verification.** Last; depends on all above.

Each slice is small enough for a single subagent and verifiable on its own (`cargo test` for 2-5, `tsc --noEmit` for 6-8, `vitest` for 7+9).
