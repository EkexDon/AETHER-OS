# Note Tasks (vault tasks)

Every `- [ ]` / `- [x]` checkbox in every Markdown note becomes a task in one
aggregated view. Each task links back to its note and line, and every edit —
checking it off, moving it on the board, changing the due date or priority —
is written back into the Markdown file. The syntax is compatible with the
Obsidian Tasks plugin, so the same vault works in Obsidian and AETHER-OS.

This complements the project **Tasks** board (`task_board.rs`), which stores
its cards outside the vault. Note tasks can be promoted to board cards.

## Why

Tasks naturally live where the thinking happens: in meeting notes, daily
notes and project pages. Scattered checkboxes are easy to write and easy to
lose; Note Tasks makes them one list without moving them out of the notes.

## How to use

Open **Note Tasks** from the rail (Life group) or with **⌘⌥C**.

| Action | How |
| --- | --- |
| Switch layout | Board · List · By note segmented control, or **⌘⌥1 / ⌘⌥2 / ⌘⌥3** (in the view) |
| Search | **⌘F** (in the view) — matches text, note name, tags and section |
| Complete / reopen | Click the checkbox (optimistic; rolled back with a toast on error) |
| Change status | Drag a card between board columns, or use the details popover |
| Due date, priority, promote | Details button (sliders icon) on every row / card |
| Open the note at the task | Note link on a row / card, or "Open note at line N" in details |
| Follow a `[[wikilink]]` | Click the link chip in the task text |
| Filter by tag | Click a `#tag` chip, or the tag filter |
| Add a task to today's daily note | Field at the top of the view, or **⌘⇧T** from anywhere |
| Rescan all notes | Rescan button or **⌘⌥R** |
| Tasks due today / overdue | Status bar chip ("3 due today"), header chips, or the palette commands "Show tasks due today" / "Show overdue tasks" |

Layouts:

- **Board** — columns Todo / In progress / Done / Cancelled. Dropping on Todo
  or Done toggles the checkbox; In progress and Cancelled rewrite the status
  character (`[/]`, `[-]`).
- **List** — open tasks grouped Overdue / Today / This week (next 6 days) /
  Later / No date; "Show completed" adds a Completed group.
- **By note** — collapsible group per note with a progress bar (done share of
  non-cancelled tasks) and the tasks' sections.

Filters (due window, priority, tag, show completed) apply to every layout;
the layout and "Show completed" are remembered per device.

## Recognised syntax

| Element | Syntax |
| --- | --- |
| Task | `- [ ] text`, `* [ ]`, `+ [ ]`, `1. [ ]`, `1) [ ]`, nested lists, inside blockquotes (`> - [ ]`) |
| Status | `[ ]` todo, `[x]`/`[X]` done, `[/]` in progress, `[-]` cancelled; any other character counts as todo and is preserved |
| Due | `📅 2026-09-30` (also `📆`, `🗓`), `due:2026-09-30`, `due: 2026-09-30`, `(due: 2026-09-30)`, `[due:: 2026-09-30]`, `@due(2026-09-30)` |
| Scheduled / start / done | `⏳` / `🛫` / `✅` or `scheduled:` / `start:` / `done:` (and `[completion:: …]`) in the same forms |
| Priority | `🔺` urgent, `⏫` high, `🔼` medium, `🔽` / `⏬` low, or `!urgent` `!high` `!medium` `!low` |
| Tags | `#tag`, nested `#area/sub` (numeric `#42` is ignored) |
| Ignored | YAML frontmatter, fenced code blocks (```` ``` ```` / `~~~`), markers inside inline code, impossible dates like `2026-02-30` |

The nearest heading above a task is shown as its section.

### How edits are written

- Only the task's own line changes; indentation, bullet, spacing, line
  endings (LF/CRLF) and a BOM are preserved.
- Checking a task appends `✅ YYYY-MM-DD` **only** when the note already uses
  Tasks-plugin emoji; reopening removes any done date.
- Due dates and priorities keep the syntax already on the line. New markers
  use emoji, or `due:` / `!priority` in notes that only use text fields. New
  priorities go before the dates, new due dates before `✅` and block ids.
- Every edit sends the task text the UI last saw. If the line changed on disk
  (edited elsewhere), nothing is written and the app rescans:
  "This note changed on disk — tasks were rescanned. Please try again."
- Adding a task inserts `- [ ] text` at the end of a `## Tasks` section (any
  heading level) or, without one, at the end of the note. The ⌘⇧T dialog
  appends the chosen priority and due date as emoji markers.

## Where data lives

- Tasks live only in the Markdown notes of the vault.
- A parse cache (per-note mtime + size + parsed tasks) is kept in
  `<app data>/vaulttasks/cache.json` (macOS:
  `~/Library/Application Support/com.ekin.aetheros/vaulttasks/`). Only notes
  whose mtime or size changed are re-parsed; a corrupt cache is discarded;
  switching vaults resets it. Rescan drops it entirely.
- UI preferences: `localStorage["aether-vaulttasks-prefs"]` (layout, show
  completed).

## IPC

All paths are absolute note paths as returned by the vault scan. Rust
re-validates them: they must resolve (after symlinks) inside the vault, be
visible (no dot-folders) and end in `.md`.

| Command | Input | Output |
| --- | --- | --- |
| `cmd_vault_tasks_list` | `filter?: { status?: all\|open\|todo\|in_progress\|done\|cancelled, due_before?, due_after?, tag?, note_path?, query? }` (dates inclusive) | `VaultTaskItem[]` |
| `cmd_vault_tasks_toggle` | `notePath, line, checked, expectedText` | `VaultTaskItem` |
| `cmd_vault_tasks_set_status` | `notePath, line, status, expectedText` | `VaultTaskItem` |
| `cmd_vault_tasks_set_due` | `notePath, line, due: "YYYY-MM-DD" \| null, expectedText` | `VaultTaskItem` |
| `cmd_vault_tasks_set_priority` | `notePath, line, priority: none\|low\|medium\|high\|urgent, expectedText` | `VaultTaskItem` |
| `cmd_vault_tasks_append` | `notePath, text` | `VaultTaskItem` (the new task) |
| `cmd_vault_tasks_stats` | none | `VaultTaskStats { total, open, in_progress, done, cancelled, overdue, due_today, due_this_week, by_note[] }` |
| `cmd_vault_tasks_rescan` | none | `VaultTaskItem[]` (cache dropped, all notes re-parsed) |

`VaultTaskItem`: `id` (FNV-1a 64 of path + line + raw text), `note_path`,
`note_name`, `line` (0-based), `indent`, `depth`, `text_raw`, `text_clean`
(markers removed, tags/links kept), `checked`, `status_char`, `status`, `due`,
`scheduled`, `start`, `done_date`, `priority`, `tags`, `section`.

Errors: `vault error: note changed, rescan (line N no longer holds this
task)`, `vault error: refusing to edit outside the vault: …`, `invalid input:
invalid date "…" — expected YYYY-MM-DD`, `invalid input: task text is
required`.

## Implementation

| Layer | Files |
| --- | --- |
| Rust parser, edits, cache, engine | `src-tauri/src/engine/vault_tasks.rs` |
| Commands | `src-tauri/src/commands/vaulttasks_commands.rs` (blocking pool) |
| Types / IPC | `src/types/vaulttasks.ts`, `src/lib/ipc/vaulttasks.ts` |
| TS parser + edits (mock, optimistic UI) | `src/lib/vaulttasks/parser.ts`, `edit.ts` |
| Filters, grouping, stats, dates, segments, commands | `src/lib/vaulttasks/*.ts` |
| Store | `src/lib/vaultTasksStore.ts` |
| UI | `src/components/vaulttasks/*`, `src/styles/views/vaulttasks.css` |
| Mock | `src/lib/mock/vaulttasks.ts` (parses the live mock vault) |

The Rust parser is the source of truth. The TypeScript port must produce the
same output: both test suites compare their result for
`src/lib/vaulttasks/__fixtures__/tasks.md` with `tasks.expected.json`.
After changing the parser, regenerate the expectation with
`UPDATE_VAULTTASKS_GOLDEN=1 cargo test golden` and make the Vitest
suite pass again.

### Editor hand-off

"Open note" selects the note in the editor and stores the target line in
`useVaultTasksStore` (`pendingLine`). `NoteEditor` calls
`useVaultTasksStore.getState().consumePendingLine(notePath)` after loading the
note, maps the 0-based file line onto the editor block
(`src/lib/editor/lineToBlock.ts`, front matter lines counted), scrolls there
and briefly flashes the block (`src/lib/editor/lineFlash.ts`). The toast shows
the line ("Opened Masterarbeit · line 21").

## Limitations

- Resolved in v0.2 (Wave 3): the editor scrolls to the task's line and
  highlights it (see *Editor hand-off*).
- Recurrence (`🔁 every week`) is kept as text; completing a recurring task
  does not create the next occurrence.
- Setext headings, indented (4-space) code blocks, HTML comments and `%%`
  comments are not detected; checkboxes inside them are treated as tasks.
- Cancelling a task does not add a `❌` date; only `✅` is written.
- Scanning runs on list/stats/rescan requests (cheap thanks to the cache);
  there is no filesystem watcher, so the view refreshes on open and when the
  window regains focus.
