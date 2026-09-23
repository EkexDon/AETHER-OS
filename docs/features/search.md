# Quick Launcher + Universal Search (roadmap 1.4 + 4.4)

## What

One input to find anything on the machine that AETHER-OS knows about:

- **Quick Launcher** (⌘K, and ⌥Space system-wide) — a Spotlight/Raycast-style
  palette that searches commands, vault notes (title + content), projects,
  project files, installed macOS apps, calendar events, tasks, memory facts,
  AI conversations, browser bookmarks and the clipboard history, grouped by
  section. It replaces the v0.1 command palette.
- **Universal Search** (the *Search* view, ⌘3 / ⌘⇧K) — the full results page:
  category tabs with counts, hybrid keyword + semantic ranking, highlighted
  snippets, a preview pane (rendered Markdown for notes, transcripts for
  conversations, the first lines of code files, details for events/tasks)
  and a Reindex button.

## Why

Knowledge is spread over notes, code, calendars, tasks and chat history.
Switching views to find something breaks flow; one keyboard-first entry
point that ranks by keywords, fuzzy titles, meaning and what you use most
makes every other feature reachable in two keystrokes.

## How to use

### Launcher

| Key | Action |
| --- | --- |
| ⌘K | Open / close the launcher (also the titlebar search pill and "Commands ⌘K" in the status bar) |
| ⌥Space | Open the launcher from anywhere on the Mac (configurable, see Settings → Search) |
| ⌘P | *Go to file* — opens the launcher with the `/` prefix |
| ⌘⇧P | *Run a command* — opens the launcher with the `>` prefix |
| ↑ / ↓ | Move the selection (wraps around) |
| Tab / ⇧Tab | Jump to the next / previous section |
| ↵ | Open the selection (the footer names the action) |
| ⌘↵ | Open in the alternate context (see below) |
| Esc | Clear the query; on an empty query close the launcher |

With an empty query the launcher shows **Recent** results (what you opened
last, newest first) followed by every command. While typing, sections
appear in this order: Commands → Notes → Projects → Files → Apps → Events →
Tasks → Memory → Conversations → Bookmarks → Clipboard (at most six per
section). Input is debounced by 60 ms; stale responses are dropped and the
previous list stays visible while a query runs, so the list never flickers.

**Prefixes** (also in the Search view):

| Prefix | Searches | Example |
| --- | --- | --- |
| `>` | Commands only | `> theme` |
| `#` | Tags only (note hashtags + frontmatter, event tags, task labels, memory categories) | `#project` |
| `/` | Project files and notes by name/path (files first) | `/src main` |
| `@` | People & memory: memory facts and AI conversations | `@anna` |
| `?` | Lists the prefixes | `?` |

**What opening does** (↵ / ⌘↵):

| Kind | ↵ | ⌘↵ |
| --- | --- | --- |
| Note | Notes editor | Raw Markdown in the IDE (vault root) |
| Project | IDE at the project root | *Open in &lt;preferred editor&gt;* (Settings → Editor) |
| File | IDE at its index root, file opened | Preferred external editor |
| App | Launch (`open -a`) | — |
| Event | Calendar, day view on that date | Week view |
| Task | Task board with its project selected and the task open | Board only |
| Memory fact | Memory view | Search view, fact selected |
| Conversation | AI agent panel with that chat loaded (`openConversation`) | Search view with the transcript preview |
| Command | Runs it | — |
| Bookmark | System browser | — |
| Clipboard item | Copies it back to the clipboard | Clipboard history view |

The IDE refuses to switch folders while files of another folder have
unsaved changes (a toast explains why).

### Universal Search view

Type in the field (150 ms debounce); ↑/↓ select, ↵ opens, ⌘↵ opens in the
alternate context, click selects (preview), double-click opens. Tabs filter
by kind and show counts (capped at 50 per kind — refine the query for more).
Cards show the kind, age, highlighted title and snippet and a **Semantic**
badge when a result was found by meaning.

- **Semantic** switch: fuses the vault's vector index (Ollama
  `nomic-embed-text`) into the ranking. Without an embedded vault the view
  shows a notice with an **Index vault** button (same action as the status
  bar "Index" item) and falls back to keyword results.
- **Reindex**: rebuilds every kind; the header shows progress per kind and a
  toast summarises the `IndexReport` ("412 notes · 3 180 files · 21 apps · 2.4 s").

### Commands

| Command | Shortcut |
| --- | --- |
| Search: open launcher | ⌘K |
| Search: universal search view | ⌘⇧K |
| Search: reindex | — |
| Go to file | ⌘P |
| Run a command | ⌘⇧P |

### Settings → Search

- **System-wide shortcut** on/off and the accelerator (modifiers first, one
  key, must include Alt/Ctrl/Cmd — e.g. `Alt+Space`,
  `CommandOrControl+Shift+Space`). Invalid values are rejected with the
  reason; if another app already owns the combination the error is shown
  under the switch.
- **What to search**: per-kind checkboxes with document counts. Unchecked
  kinds are purged from the index and never returned.
- **File index folders**: default = every project found in the Projects
  view's folders; add absolute folders to index those instead (Browse… in
  the desktop app).
- **Index**: status, *Reindex now*, *Clear recents*.

## Ranking

Every query runs three retrievers and fuses them with **reciprocal-rank
fusion** (`score = Σ weight / (60 + rank)`):

1. **Keyword** — SQLite FTS5 `bm25()` with column weights title 10 · tags 5 ·
   body 1; every query term is a prefix match; diacritics are folded
   (`kase` finds *Käsespätzle*). Snippets come from `snippet()`.
2. **Fuzzy titles** — exact > prefix > word prefix > substring > compact
   subsequence, so abbreviations work (`clbrd` → *Clipboard*,
   `vsc` → *Visual Studio Code*). Letters may be skipped inside the first
   matched word only; later hits must start a word.
3. **Semantic** (Search view with *Semantic* on) — top 30 vault notes from
   the vector index with cosine ≥ 0.25.

The fused score is multiplied by a **frecency** boost
(`1 + 0.5·ln(1 + frecency/100)`, max 2): frecency = visits × average age
weight of the last 10 visits (≤ 3 days 100, ≤ 13 days 70, ≤ 30 days 50,
≤ 89 days 30, older 10). Results are then capped per kind and normalised to
`(0, 1]`.

Snippets are HTML-escaped in Rust with only `<mark>` added for matches; the
UI still never uses `innerHTML` — it parses the `<mark>` pairs into React
text nodes.

## Where data lives

`~/Library/Application Support/com.ekin.aetheros/search/`

| File | Content |
| --- | --- |
| `index.db` | SQLite (WAL): `docs(id, kind, title, subtitle, path, body, tags, updated_at, extra, sig)` + external-content FTS5 `docs_fts(title, body, tags)` kept in sync by triggers; `meta` (last full index) |
| `recents.json` | Last 50 opened results with visit history (frecency) |
| `settings.json` | Shortcut, enabled kinds, file index folders |

Indexing:

- **Start-up**: a background thread indexes every kind once the app state is
  ready and emits `search-index-updated`.
- **Notes**: incremental by modification time + size through `VaultReader`;
  every `cmd_search_query` re-scans vault mtimes when the last scan is older
  than 10 s (only changed notes are re-read, deleted ones removed).
- **Files**: `ignore`-crate walk of each root — `.gitignore`/`.ignore` rules
  (also outside git repos), hidden entries, `node_modules`, `target`, `.git`,
  `dist`, `build`, `.next`, `.venv`, `__pycache__` skipped; depth ≤ 8; at
  most 50 000 files; only names and paths are indexed, never contents.
- **Apps**: `.app` bundles in `/Applications`, `~/Applications`,
  `/System/Applications` (and one sub-folder level, e.g. `Utilities`); name
  from `Info.plist` (XML or binary) `CFBundleDisplayName` → `CFBundleName` →
  bundle file name; cached for 5 minutes.
- **Projects, memory, conversations, events, tasks**: full sync on every
  reindex (unchanged rows are not rewritten).
- Changing *What to search* or the file folders re-indexes the affected
  kinds in the background.

## IPC

| Command | Input | Output |
| --- | --- | --- |
| `cmd_search_query` | `q`, `kinds?: SearchKind[]`, `limit`, `perKind?`, `semantic?` | `SearchHit[]` (`{ id, kind, title, subtitle, path, snippet_html, score, updated_at, extra, matched }`) — errors with "…vault index…" when `semantic` is requested without an embedded vault |
| `cmd_search_reindex` | `kinds?: SearchKind[]` (all when omitted) | `IndexReport { kinds: KindReport[], total, ms }` |
| `cmd_search_apps` | — | `AppEntry[] { name, path, bundle_id }` |
| `cmd_launch_app` | `path` (must be a `.app` inside the app folders) | — |
| `cmd_search_recents_record` | `id`, `kind`, `title?` | — |
| `cmd_search_recents_list` | `limit?` (default 20, max 50) | `RecentHit[]` (`hit` resolved for indexed kinds) |
| `cmd_search_recents_clear` | — | — |
| `cmd_search_get_settings` | — | `SearchSettings` |
| `cmd_search_set_settings` | `settings` | normalised `SearchSettings` (validated) |
| `cmd_search_status` | — | `SearchStatus { counts, total, last_indexed_at, indexing, shortcut, shortcut_error }` |

Events: `launcher-open` (global shortcut fired; the backend already focused
the main window), `search-index-progress` (`KindReport` after each kind),
`search-index-updated` (`IndexReport` after background runs and reindexes).

Frontend: `src/lib/ipc/search.ts` (wrappers + `onLauncherOpen`,
`onSearchIndexProgress`, `onSearchIndexUpdated`), `src/lib/searchStore.ts`
(`openLauncher(prefix)`, Search view state, `reindex()` with toasts),
`src/lib/search/*` (prefix parser, fuzzy scorer on top of
`lib/commands/fuzzy`, highlight parser, frecency/RRF mirror, launcher list
model, open actions, bookmarks/clipboard sources, commands),
`src/components/launcher/Launcher.tsx`, `src/components/search/*`
(`UniversalSearch`, `SearchResultCard`, `SearchPreview`, `SearchSettings`,
`Highlighted`), `src/styles/views/search.css`. Mock: `src/lib/mock/search.ts`
builds a live index over the mock vault, projects, mock file system, memory,
calendar, tasks and 21 fake apps.

## Security

- Paths from the UI are untrusted: `cmd_launch_app` canonicalizes the path
  and only launches `.app` bundles inside the application folders; file
  index folders must be absolute, existing directories (the filesystem root
  is refused); opening files goes through the sandboxed IDE commands.
- FTS queries are built from alphanumeric terms only (no MATCH-syntax
  injection); snippets are escaped server-side and rendered as text.
- Nothing leaves the machine; semantic search talks to the local Ollama only.

## Limitations

- App launching and discovery are macOS-only (other platforms report a clear
  error and simply index no apps).
- File contents are not indexed (names and paths only), and the file index is
  refreshed on start-up, on *Reindex* and when the folders change — not live.
- Semantic results cover vault notes only (the vector index holds notes).
- Resolved in v0.2 (Wave 3): ↵ on a conversation loads it into the agent chat
  via `openConversation(id)` (`src/lib/agentChatBus.ts`); ⌘↵ shows the
  transcript preview in the Search view.
- The global shortcut is registered from Rust; if another app already owns
  the combination, registration fails and Settings → Search shows why.
