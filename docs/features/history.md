# Note history — automatic Git versioning (roadmap 4.1)

## What

A Time Machine for the vault. Every note save is committed to a local Git
repository at the vault root, automatically and without any Git knowledge.
You can browse the history of any note, see exactly what changed between
versions (unified or side by side), and restore any version with one click.
Deleted notes can be brought back the same way.

## Why

Autosave is great until an accidental select-all-and-type, a bad find and
replace, or an AI action rewrites a note. With every save kept as a version,
nothing written in AETHER-OS is ever lost, and the history is plain Git: it
stays useful outside the app (`git log`, any Git GUI, the IDE's Source
Control panel) and never leaves the machine.

## How to use

- **History view** (rail → Knowledge → History, or *Go to History* in ⌘K):
  - **Activity** (left): every snapshot of the vault, grouped by day. Click an
    entry to open that note at that version; multi-file snapshots list their
    notes as chips.
  - **Versions** (middle): versions of the selected note, newest first, with
    `+added −removed` line counts. Find another note with the search field
    at the top. ↑/↓, Home and End move through the versions.
  - **Changes** (right): the diff of the selected version.
    *Previous* shows what that save changed; *Current file* shows what
    changed since then. Toggle unified / side by side; long unchanged
    regions are folded ("Show N unchanged lines"), changed words inside a
    modified line are highlighted.
  - **Restore this version** asks for confirmation, writes the old content
    back (like an editor save) and records it as a new `restore:` version,
    so a restore can itself be undone.
  - On narrow windows the columns collapse into Activity / Versions /
    Changes tabs.
- **While editing**: **⇧⌘H** opens a drawer with the history of the current
  note on top of the editor. Restoring from there refreshes the editor
  immediately. The ⤢ button opens the full History view.
- **Status bar**: the clock item shows the time of the last snapshot
  ("2m ago", "History off"); click it to open the History view. A red dot
  means the last background snapshot failed (details in the tooltip and in
  Settings).
- **Settings → History**: switch automatic versioning on/off, *Snapshot
  now*, repository location, version count, last snapshot, watcher state,
  and **Open in IDE** (opens the vault repo in the IDE so its Source Control
  panel shows the history).

| Shortcut | Command |
| --- | --- |
| ⇧⌘H | History: show note history (drawer in the editor, otherwise the History view) |
| ⌥⌘S | History: snapshot now (commit every pending change) |
| — | History: toggle automatic versioning |

## How it works

- **Repository.** On first use (with versioning on) AETHER-OS runs the
  equivalent of `git init -b main` in the vault folder and writes a
  `.gitignore` (`.obsidian/workspace*.json`, `.trash/`, `.DS_Store`) if none
  exists. If the vault **already is** a Git repository, it is used as is:
  history commits go to the current branch; remotes, branches and config
  are never touched, and files you staged by hand are not swept into an
  automatic commit (commits are built from `HEAD` plus exactly the changed
  paths). A vault that lies *inside* another repository is refused with a
  clear message instead of creating a nested repository.
- **What is versioned.** Markdown notes (`*.md`) and attachments (images,
  PDF, audio, video, `.canvas`, `.excalidraw`; at most 25 MB each).
  Hidden files and folders (`.git`, `.obsidian`, `.trash`, …) are skipped and
  `.gitignore` rules are honoured.
- **When.** A background watcher (`notify` + `notify-debouncer-mini`, 2 s
  debounce) commits the files touched by a burst of saves as one commit —
  `note: <path>` for one file, `notes: N files` for several. A safety scan
  every 30 s (and right after start or enabling) commits anything the watcher
  missed, e.g. files changed while the app was closed or moved folders.
  Unchanged files never produce empty commits.
- **Identity.** Your Git `user.name` / `user.email`; `AETHER-OS
  <aether@local>` when none is configured.
- **Safety.** Automatic commits pause (with a message in Settings and the
  status bar) while the repository is mid-merge/rebase or has a detached
  HEAD. All paths from the UI are resolved inside the vault; traversal,
  hidden paths and paths outside the vault are rejected. Git work runs on
  Tauri's blocking pool so large snapshots never stall the UI.
- **Vault changes at runtime** are picked up automatically: every command
  resolves the vault path again and the watcher follows it.

## Where data lives

| Data | Location |
| --- | --- |
| Versions | `<vault>/.git` (a normal Git repository) |
| Ignore rules | `<vault>/.gitignore` (written only for fresh repositories) |
| On/off setting | `<app data>/history/settings.json` (`{ "enabled": true }`) |

## IPC

Paths are absolute vault paths (as returned by `cmd_get_vault_notes`) or
vault-relative. Commit ids may be full or abbreviated (≥ 4 hex chars).

| Command | Input | Output |
| --- | --- | --- |
| `cmd_history_status` | none | `HistoryStatus { enabled, vault_path, repo_path, branch, commit_count, last_commit_at, watching, last_error }` |
| `cmd_history_list` | `path`, `limit?` (default 50, max 500) | `NoteVersion[] { id, short_id, time, message, author, change, summary_added, summary_removed }`, newest first |
| `cmd_history_read` | `path`, `commitId` | `String` (content in that version) |
| `cmd_history_diff` | `path`, `from?`, `to?` | `FileDiff { path, old_content, new_content, is_binary }` — `to: null` = file on disk, `from: null` = the version before `to` |
| `cmd_history_restore` | `path`, `commitId` | `HistoryRestore { content, commit_id }` (`commit_id` null when unchanged or versioning is off) |
| `cmd_history_recent` | `limit?` (default 50, max 500) | `HistoryActivity[] { commit_id, short_id, time, message, files: { rel_path, path, change }[], file_count }` |
| `cmd_history_set_enabled` | `enabled` | `HistoryStatus` |
| `cmd_history_commit_now` | `path?` (one note, or all pending changes) | `HistoryActivity \| null` |

Event: `history-commit` (payload `HistoryActivity`) after every commit made
by the watcher, a snapshot or a restore. Frontend: `onHistoryCommit()` in
`src/lib/ipc/history.ts`; `useHistoryStore` / `initHistorySync()` in
`src/lib/historyStore.ts` keep the status bar and views live.

## Code map

| Part | Files |
| --- | --- |
| Engine (repo, watcher, commits, log, diff, restore) | `src-tauri/src/engine/note_history.rs` |
| Commands + engine wiring | `src-tauri/src/commands/history_commands.rs` |
| Types / IPC | `src/types/history.ts`, `src/lib/ipc/history.ts` |
| Store, line diff (Myers), formatting, commands | `src/lib/historyStore.ts`, `src/lib/history/{diff,format,commands}.ts` |
| UI | `src/components/history/*` (`HistoryView`, `NoteHistoryPanel`, `HistoryDiffView`, `ActivityTimeline`, `NotePicker`, `RestoreDialog`, `HistoryDrawer`, `HistoryStatusItem`, `HistorySettings`), `src/styles/views/history.css` |
| Mock (browser preview) | `src/lib/mock/history.ts` — a seeded five-week history of the demo vault (edits, a multi-file commit, a deleted note, an accidental wipe that was restored); edits made in the preview are committed every 3 s like the real watcher |

## Limitations

- Renames are recorded as delete + add; a note's version list does not
  follow it across a rename (the old path's history stays browsable).
- Merge commits in an existing repository are followed along the first
  parent only.
- Attachments can be listed and diffed as "binary", but only text notes can
  be restored from the UI.
- Every save that is followed by ≥ 2 s of quiet becomes its own version;
  there is no automatic squashing or pruning of old versions yet.
- The editor reloads a note from disk only when it mounts, so a restore
  while the note is open briefly remounts the editor (one frame).
