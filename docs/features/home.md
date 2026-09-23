# Home, Pins and Focus (roadmap 3.3 + 3.4)

## What

Three connected pieces that make AETHER-OS the first thing you open in the
morning:

- **Home** — the dashboard (`mode: "dashboard"`, ⌘1). Greeting and date,
  quick actions, today's daily note, today's and tomorrow's calendar events,
  tasks that are due or overdue, where to continue (recent notes, projects,
  AI chats), your pins, the Pomodoro timer with focus statistics, and vault
  health with "Index vault for AI".
- **Pins** — bookmarks for notes, projects, commands, AI conversations and
  links, organised in named groups and reorderable by drag-and-drop or the
  keyboard. Shown on Home and in a pins drawer reachable from anywhere.
- **Pomodoro & Focus Mode** — a wall-clock based Pomodoro timer (work → break
  → … → long break) in the status bar, a local focus log with daily minutes
  and streaks, and a distraction-free Focus Mode.

## Why

The old dashboard showed counters. Home answers the questions you have when
you sit down: *what is on today, what is overdue, what was I working on,
what do I keep coming back to, and am I focusing?* Pins remove the hunt for
the handful of notes, repos and commands you use every day. The timer and
the focus log turn "deep work" into something you can see accumulate,
without an account or a cloud service.

## How to use

### Home

Open it with **⌘1** or the first rail item. The layout is an asymmetric
65 / 35 grid when the content area is at least 1100 px wide (Today and
Continue on the left; Focus, Pinned and Vault on the right) and a single
column below that (Today → Focus → Continue → Pinned → Vault).

| Block | What it shows | Header action |
| --- | --- | --- |
| Header | "Good morning/afternoon/evening/night", the date, the vault name and quick actions: **New note** (⌘N), **Capture** (⌘⇧N), **Task**, **Event**, **Launcher** (⌘K). Below 760 px the buttons collapse to icons. | — |
| Today | The daily note (`daily/YYYY-MM-DD.md`: *Open*, or *Create* when missing) plus a one-line capture field that appends a timestamped bullet; **Schedule** — events today (all-day first, "Now" badge, past events dimmed) and tomorrow, click to edit; **Due** — open task-board items due today or earlier (checkbox completes them, click opens the task editor) and, when the Note Tasks feature is installed, open checkbox tasks from notes (click opens the note). | Calendar |
| Continue | Segmented **Notes / Projects / Chats**: notes by modification time, projects by last commit with branch and git status chip (`clean`, `3 changed`), recent AI conversations. Every row has a pin button. | Search / Projects / Open chat |
| Pinned | Your pin groups (see below). | Manage (opens the drawer) |
| Focus | Timer with phase, cycle dots and progress, Start / Pause / Resume, Skip, Stop and a Focus Mode toggle; today's minutes, sessions and streak; a 7-day bar chart (today in the accent color). | Settings |
| Vault | Notes, open tasks, tags and links as tiles; **Index vault for AI** with a progress bar and the time and result of the last run. | Graph |

Every block has an empty state with a next step, loads independently (a
failing source shows an inline error only in its own block) and refreshes
whenever Home is opened.

### Pins

- **Pin**: the pin button on any Continue row, **⌘⇧D** (*Pins: pin current
  note*) for the note open in the editor, the "Pin “…”" button at the top of
  the drawer, or the drawer's **Add pin** form for links (`example.com/x`
  becomes `https://example.com/x`; only http/https) and commands (any
  command from the palette).
- **Unpin**: the × on a pin, **Delete/Backspace** on a focused pin (with
  *Undo* in the toast), or *Pins: unpin current note*.
- **Open**: click or Enter. Note → editor, project → IDE with that folder as
  root, command → runs it, conversation → opens the AI agent panel, link →
  system browser. Pins whose note left the vault or whose command no longer
  exists are marked *Missing*; opening one offers *Unpin*.
- **Reorder**: drag a pin (grip on hover) above/below another pin or into
  another group; or focus it and press **⌥↑ / ⌥↓** (crosses into the
  neighbouring group at the edges). **↑ / ↓** move focus between pins.
- **Groups** (drawer): *New group*, rename (pencil or double-click the name),
  delete (its pins move to the first remaining group; the last group stays).
- **Drawer**: the bookmark icon in the status bar (with the pin count),
  **⌥⌘B** (*Pins: show pins*) or *Manage* on Home. Escape or a click outside
  closes it; it is non-modal, so the app stays usable.

`PinsPanel` (`src/components/home/PinsPanel.tsx`, `variant="compact" |
"full"`) is exported so the vault sidebar can host it as well.

### Pomodoro & Focus Mode

- The status bar shows **Focus** when idle; click it (or **⌥⌘T**, *Focus:
  start or pause Pomodoro*) to start a work session. While running it shows
  `mm:ss` in the phase color (accent = focus, green = break, blue = long
  break); click to pause/resume, the arrow skips to the next phase.
- Phases: work (25 min) → break (5) → … → after 4 work sessions a long break
  (15) → work. Breaks start automatically (setting), work always waits for
  you. **Skip** during work logs the minutes focused so far and counts the
  cycle; **Stop** returns to idle and logs a started work session. Sessions
  under one minute are not logged.
- When a phase ends you get a toast and — if enabled and permitted — a
  desktop notification; an optional chime is off by default.
- The timer stores wall-clock timestamps, so it never drifts and a reload
  (or reopening the app) continues exactly; phases that ended while the app
  was closed are completed and logged at their real end time without a
  notification.
- **Focus Mode** (**⌘⇧F**, *Focus: toggle focus mode*, or the button in the
  Focus block) sets `<html data-focus="true">`: the navigation rail dims
  (full on hover), the vault sidebar, the titlebar action stack (capture /
  clip / agent) and all status bar items except the timer and *Exit focus*
  are hidden, the command pill recedes and the editor widens to 920 px.
  Press **Esc twice** (within 0.6 s) or click *Exit focus* to leave.
- **Settings → Focus & Pomodoro**: focus / short / long break minutes,
  sessions before a long break, auto-start breaks, desktop notifications
  (asks for permission when switched on) and sound (with *Test*), reset to
  defaults.

### Commands

| Command | Shortcut |
| --- | --- |
| Pins: pin current note | ⌘⇧D |
| Pins: unpin current note | — (only when the current note is pinned) |
| Pins: show pins | ⌥⌘B |
| Focus: toggle focus mode | ⌘⇧F |
| Focus: start or pause Pomodoro | ⌥⌘T |
| Focus: skip to next phase | — |
| Focus: stop Pomodoro | — |
| Focus: Pomodoro settings | — |
| Home: open today's daily note | — |

## Where data lives

| Data | Location |
| --- | --- |
| Completed focus sessions | `<app data>/focus/sessions.jsonl` (one JSON object per line: `id`, `started_at`, `ended_at` (RFC 3339, local offset), `minutes`, `kind` = `work`/`break`/`long_break`, `note_path`) |
| Pins | localStorage `aether-pins` |
| Pomodoro settings | localStorage `aether-focus-settings` |
| Running timer | localStorage `aether-focus-timer` (phase, status, `endsAt`, remaining, cycle count) |
| Last "Index vault for AI" run | localStorage `aether-home-last-index` |

The focus log is append-only; a line cut off by a crash is skipped on read
and the next write starts a fresh line. `note_path` is metadata only and is
never used to touch the file system.

## IPC

| Command | Input | Output |
| --- | --- | --- |
| `cmd_focus_log_session` | `session: { started_at, ended_at, minutes?, kind, note_path? }` (nested, snake_case) | `FocusSession` |
| `cmd_focus_stats` | `days` (clamped to 1–366) | `FocusStats { today_minutes, today_sessions, streak_days, total_minutes, by_day: [{ date, minutes, sessions }] }` |
| `cmd_focus_list` | `limit` (clamped to 1–1000) | `FocusSession[]`, newest first |

Validation: RFC 3339 timestamps, `ended_at ≥ started_at`, 1 ≤ minutes ≤
1440 and not longer than the span, single-line `note_path` ≤ 4096 bytes.
Statistics count only `work` sessions, attributed to the local date of
`started_at`; the streak is the run of consecutive days with at least one
work session ending today — or yesterday while today has none yet.

Home also reads existing commands: `cmd_list_calendar_events`,
`cmd_list_task_projects`, `cmd_list_tasks`, `cmd_update_task`,
`cmd_get_recent_conversations`, `cmd_get_project_dirs`, `cmd_scan_projects`
(only when no projects are loaded yet), `cmd_daily_note`,
`cmd_append_daily`, `cmd_index_vault`, `cmd_get_vault_notes`,
`cmd_get_vault_stats`, `cmd_agent_open_url`, and — optionally —
`cmd_vault_tasks_list({ filter: { due_before } })` from the Note Tasks
feature (errors are ignored, the section simply stays hidden).

Mock mode (`npm run dev:mock`) seeds 14 days of focus sessions with gaps and
a live streak and validates exactly like the Rust engine
(`src/lib/mock/home.ts`, stats via the shared TS port
`src/lib/home/focusStats.ts`).

## Code map

- Rust: `src-tauri/src/engine/focus_log.rs` (engine + tests),
  `src-tauri/src/commands/home_commands.rs`.
- Pure logic (tested): `src/lib/home/pomodoro.ts` (state machine),
  `reorder.ts` (pin ordering), `focusStats.ts`, `agenda.ts`, `dueTasks.ts`,
  `recent.ts`, `pinActions.ts`, `focusMode.ts`, `format.ts`, `notify.ts`.
- Stores: `src/lib/focusStore.ts`, `src/lib/pinsStore.ts`,
  `src/lib/homeStore.ts`; commands in `src/lib/home/commands.ts`.
- UI: `src/components/Dashboard.tsx` and `src/components/home/*`
  (`HomeBlock`, `TodayBlock`, `ContinueBlock`, `FocusBlock`, `FocusChart`,
  `VaultBlock`, `PinsPanel`, `PinsDrawer`, `PinButton`, `statusItems`,
  `FocusSettings`), styles in `src/styles/views/home.css` (formerly
  `dashboard.css`).
- The timer engine (`useFocusEngine`) runs inside the always-mounted status
  bar timer, which also owns the double-Escape listener.

## Limitations

- Opening a pinned or recent **conversation** opens the agent panel; loading
  that specific conversation needs an API on `AgentChat` (not owned by this
  feature).
- `PinsPanel` is exported for the vault sidebar but not mounted there yet
  (`VaultSidebar.tsx` is owned elsewhere).
- "Last indexed" is recorded for runs started from Home; the status bar's
  *Index* item does not report its runs.
- Desktop notifications exist only in the Tauri app; the browser preview uses
  in-app toasts.
- The timer ticks while the status bar is mounted (always, in the app shell).
