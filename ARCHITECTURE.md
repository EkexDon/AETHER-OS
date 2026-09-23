# AETHER-OS Architecture

AETHER-OS is a local-first AI Homestation that integrates with NoPes, a local-first knowledge base. AETHER-OS reads the NoPes vault (Markdown files + `.nopes/index.json`), semantically indexes all notes, and provides context-aware AI responses. The Tauri shell keeps privileged storage and execution within Rust; the React webview communicates through typed IPC commands only.

## Components

```text
React UI → Typed IPC → Tauri Commands → Rust AppState
                                      ├─ Vault Reader (reads NoPes vault)
                                      ├─ Local vector store (indexes vault notes)
                                      ├─ Ollama client (localhost only)
                                      ├─ AETHER Notes store (AI-generated notes)
                                      └─ Embedded browser webviews (subviews of main window)
```

## Data flow

1. On startup, AETHER-OS auto-detects the NoPes vault path (from config or by scanning for `.nopes/index.json`).
2. `cmd_get_vault_notes` scans the vault directory for all `.md` files. `cmd_get_vault_index` reads the parsed NoPes index (tasks, tags, wikilinks, cards, frontmatter).
3. `cmd_index_vault` generates embeddings for all vault notes via local Ollama (`nomic-embed-text`) and stores them in the local vector index. The dimension is defined by the model and locked per index.
4. `cmd_semantic_search` embeds the query locally, ranks persistent vectors by cosine similarity, and returns the highest scoring matches.
5. `cmd_agent_query` embeds the prompt, finds the top-5 relevant notes via semantic search, loads their content, builds a context-aware system prompt, and streams the AI response via the `llm-stream-chunk` event.
6. `cmd_create_aether_note` saves AI-generated responses as notes in AETHER-OS's own storage (not in the NoPes vault).

## IPC layout (frontend)

All backend access goes through `src/lib/ipc.ts`, a barrel that re-exports
one module per Rust command module:

```text
src/lib/ipc.ts                 export * from "./ipc/<domain>"  + // @anchor:ipc:<feature>
src/lib/ipc/core.ts            call(), listenSafe(), isTauriRuntime(), isMockRuntime(),
                               isDesktopRuntime(), IpcUnavailableError
src/lib/ipc/<domain>.ts        vault, ai, aetherNotes, projects, memory, terminal, system,
                               browser, notes, ide, git, calendar, lsp, tasks, agentActions,
                               diagnostics, updater — one documented wrapper per command
src/types/index.ts             export * from "./<domain>"      + // @anchor:types:<feature>
```

- `call(command, args)` uses Tauri's `invoke` in the desktop shell, the DEV
  mock backend (`src/lib/mock/backend.ts`) under `npm run dev:mock`, and
  throws `IpcUnavailableError` in a plain browser. Rejections are rethrown as
  `Error` with the backend's message.
- `listenSafe(event, handler)` delivers event *payloads*; it resolves to a
  no-op unlisten in a plain browser and never throws there.
- `isDesktopRuntime()` means "a backend can answer" (Tauri or mock);
  `isTauriRuntime()` is the strict desktop check.
- Top-level command arguments are camelCase in JS (Tauri renames Rust's
  snake_case), nested structs keep their serde (snake_case) field names.
- The mock backend is DEV-only and tree-shaken from production builds; a
  test keeps it in sync with `generate_handler!` in `lib.rs`. See
  `docs/dev/MOCK-MODE.md`.

## IPC API

| Command | Input | Output |
| --- | --- | --- |
| `cmd_get_vault_path` | none | `Option<String>` |
| `cmd_set_vault_path` | path | none |
| `cmd_get_vault_notes` | none | `VaultNote[]` |
| `cmd_get_note_content` | path | `String` |
| `cmd_get_vault_index` | none | `Option<VaultIndex>` |
| `cmd_get_vault_graph` | none | `GraphData` |
| `cmd_get_vault_stats` | none | `VaultStats` |
| `cmd_index_vault` | none | `IndexingResult` |
| `cmd_semantic_search` | query, limit | `VectorMatch[]` |
| `cmd_agent_query` | prompt, model | `String[]` (context paths) + token events |
| `cmd_agent_query_with_notes` | prompt, note_paths, model, provider | token events |
| `cmd_set_openrouter_key` | key (or null to clear) | `bool` (key configured) |
| `cmd_list_cloud_models` | none | `String[]` (OpenRouter model IDs) |
| `cmd_list_local_models` | none | `String[]` (installed Ollama models) |
| `cmd_get_health` | none | `SystemHealth` |
| `cmd_create_aether_note` | title, content, source_query, related_notes | `AetherNote` |
| `cmd_get_aether_notes` | none | `AetherNote[]` |
| `cmd_delete_aether_note` | id | none |
| `cmd_execute_agent_action` | `AgentAction` | `String` (status) |
| `cmd_agent_open_url` | url | `AgentActionResult` |
| `cmd_agent_clip_url` | url | `AgentActionResult` |
| `cmd_agent_add_memory_fact` | fact, category | `AgentActionResult` |
| `cmd_agent_save_aether_note` | title, content | `AgentActionResult` |

## AI Agent Actions

The agent can take seven kinds of actions on the vault, emitted as
```action JSON blocks in the AI's reply. The system prompt (`commands/ai_commands.rs:8`) teaches the format; the frontend parser (`lib/agentActions.ts`) extracts them on every response.

- **Safe actions (auto-executed, v1):** `create_note`, `append_note`, `append_daily`, `add_memory_fact`, `save_aether_note`, `open_url`, `clip_url`.
- **Action routing.** Pure-vault actions are handled by the existing `cmd_execute_agent_action` (synchronous). The four variants that need a different engine (`add_memory_fact` → memory store, `save_aether_note` → AETHER notes, `open_url` → system browser, `clip_url` → fetcher) are routed through dedicated commands in `commands/agent_action_commands.rs` that return a tagged `AgentActionResult` enum so the frontend can switch on the response shape.
- **Frontend orchestration.** `clip_url` is intentionally two-step: the backend fetches HTML and returns the raw `ClippedPage`; the frontend runs the existing `turndown` pipeline (`lib/clipper.ts:htmlToMarkdown`), composes the note body, and calls `cmd_create_note`. This keeps `turndown` (a JS dep) on the frontend where it belongs, and lets the note path use the existing vault filename sanitization.
- **Model capability detection.** `lib/agentModelSupport.ts` is a small family-prefix registry (`llama3.1+`, `qwen2.5+`, `claude-3+`, `gpt-4o+`, `gemini-2+` are known-good; `tinyllama`, `qwen:0.5b`, `stablelm` are known-bad). The engine bar shows a `tools: unreliable` warning chip for the latter so the user knows to expect chat-only behavior.

| Command | Input | Output |
| --- | --- | --- |
| `cmd_execute_agent_action` | `AgentAction` (vault-only variants) | `String` (status) |
| `cmd_agent_open_url` | url | `{ kind: "opened", url }` |
| `cmd_agent_clip_url` | url | `{ kind: "clipped_page", path: ClippedPage }` |
| `cmd_agent_add_memory_fact` | fact, category | `{ kind: "fact_saved", fact: MemoryFact }` |
| `cmd_agent_save_aether_note` | title, content | `{ kind: "aether_note_saved", note: AetherNote }` |

### Future: destructive tools

When 2.4 grows to include terminal, git, or file-delete actions, the same routing pattern applies: each gets its own `cmd_agent_*` command, but the frontend will gate the call on a per-action approval modal because those actions are not safe to auto-execute.

### Approval-gated actions, audit log and conversation memory (`intel`, v0.2)

Destructive tools landed with the `intel` feature (details:
`docs/features/intel.md`). Every action has a risk level — `action_risk` in
`engine/agent_actions.rs`, mirrored by `actionRisk` in `src/lib/intel/risk.ts`:
**safe** actions run automatically as before; **confirm** and **dangerous**
actions wait for the `ApprovalModal` (details resolved by
`cmd_intel_preview_action`; "always allow" rules per kind, commands scoped to a
directory; dangerous rules never survive a restart). `src/lib/intel/pipeline.ts`
queues all gated actions of a reply at once and executes the reply's actions in
order; `src/lib/intel/executeAction.ts` routes each one. Actions executed by the
`cmd_intel_*` commands are audited in Rust; the others (and every denial) are
recorded through `cmd_intel_audit_record` in `<app data>/intel/audit.jsonl`.

| Action | Risk | Command |
| --- | --- | --- |
| `run_command { command, cwd? }` | dangerous | `cmd_intel_run_command` — `sh -lc`, cwd inside project roots or the vault, 60 s timeout, process group killed on timeout, 64 KB output per stream |
| `delete_note { path }` | dangerous | `cmd_intel_delete_note` — moves to `<vault>/.trash/<timestamp>-<name>.md` |
| `delete_calendar_event { id }` | dangerous | `cmd_delete_calendar_event` |
| `move_note { from, to }` | confirm | `cmd_intel_move_note` — never overwrites |
| `git_commit { project_path, message }` | confirm | `cmd_intel_git_commit` — staged changes, or all changes when nothing is staged (`git_repo.rs`) |
| `toggle_vault_task { note_path, line }` | confirm | `cmd_intel_toggle_vault_task` — one-character checkbox rewrite |
| `update_calendar_event`, `import_calendar_ics` | confirm | calendar commands |
| `create_task { project_id?, title, … }` | safe | `cmd_intel_create_task` — project id or name, default "Inbox" |
| all v0.1 actions | safe | unchanged routing (audited via `cmd_intel_audit_record`) |

Conversation memory: `cmd_agent_query_with_notes` accepts an optional
`conversation { id, summary, history }`; the prompt builder
(`engine/intel/compaction.rs`, called from `ai_commands.rs`) adds the summary and
the newest messages within a per-provider budget (smaller note context for local
4k-context models) and lists recent conversation *titles* in the system prompt.
`cmd_intel_compact` summarises all but the last N messages with the current
model and falls back to an extractive summary; sessions are saved as one
`MemoryStore` record each (`cmd_intel_save_conversation`) with the summary in
the `summary` field.

## Embedded IDE — Language Servers (LSP)

Project-wide IntelliSense in the IDE comes from standard LSP servers spawned
as sidecars:

- `engine/lsp.rs` owns the processes: it finds servers on PATH
  (`typescript-language-server`, `rust-analyzer`, `pyright`/`pylsp`,
  `vscode-json-language-server`; TS falls back to `npx` when no global
  install exists), speaks the mandatory `Content-Length` stdio framing, and
  forwards JSON-RPC both ways over Tauri IPC/events. It is strictly
  transport-only — zero protocol semantics.
- The frontend (`lib/lsp.ts`, `lib/lspMonaco.ts`) owns the protocol:
  initialize handshake, full-text document sync (debounced 250 ms), and the
  Monaco mappings — hover, completions (incl. snippets), go-to-definition,
  and `publishDiagnostics` → squiggly markers.
- One process per `(language, project root)`; sessions start lazily when a
  file of that language is opened, stop when the folder closes, and are all
  killed on app exit.
- Graceful degradation: no server binary on PATH ⇒ status stays hidden and
  Monaco keeps its built-in single-file features. A live handshake test in
  `lsp.rs` runs against a real `typescript-language-server` when one is
  installed (needs classic TypeScript ≤5 with `tsserver.js`; projects
  without their own TS dependency should `npm i -D typescript`).

## Embedded IDE (Source Control)

The IDE view embeds Monaco (bundled locally, no CDN) behind the sandboxed
`Workspace` API. The Source Control sidebar adds Git operations on top:

- `git_repo.rs` wraps libgit2 (`git2`) for a single repository: status with
  staged/unstaged split, stage/unstage/discard, commit, branch listing,
  switching, creation, recent log, and per-file old/new content for diffs.
  Identity falls back to `AETHER-OS <aether@local>` when no git config exists.
- Repos are opened via discovery from any subdirectory, but the discovered
  work tree must still be inside an allowed project root — a symlinked `.git`
  pointing outside is rejected.
- Frontend: `IdeSourceControl` (branch switcher, staged/unstaged groups with
  stage/unstage/discard, commit box, log) and `IdeDiffView` (Monaco
  side-by-side diff overlay, Escape to close).

## Embedded Browser

The built-in browser renders pages in **native webviews embedded as subviews of the main window**
via Tauri 2's multiwebview API (`Window::add_child`, requires the `unstable` feature). Each browser
tab is a real WKWebView (macOS) — no iframe, no proxy, no separate window. Sites with strict
anti-framing policies (Google, YouTube, GitHub) work natively.

- `BrowserWebviews` (`src-tauri/src/commands/browser_commands.rs`) tracks open webviews (label → URL); the webview handles themselves live in Tauri's window manager (`app.get_webview(label)`).
- Coordinates are logical pixels relative to the main window's content area, so the frontend passes `getBoundingClientRect()` values directly — no coordinate conversion.
- Navigation and title changes stream to the frontend via the `browser-webview-nav` and `browser-webview-title` events; the React tab bar keeps address bar and history in sync.
- Webviews are shown/hidden when switching tabs or leaving the browser view, and repositioned via `ResizeObserver` when the layout changes.

| Command | Input | Output |
| --- | --- | --- |
| `cmd_browser_webview_open` | url, x, y, width, height | label |
| `cmd_browser_webview_navigate` | label, url | none |
| `cmd_browser_webview_set_bounds` | label, x, y, width, height | none |
| `cmd_browser_webview_show` / `hide` / `close` | label | none |
| `cmd_browser_webview_back` / `forward` / `reload` | label | none |
| `cmd_browser_webview_list` | none | `(label, url)[]` |
| `cmd_browser_webview_hide_all` | none | none |

## Diagnostics & crash reports

Crash reporting is local and needs no opt-in because nothing leaves the
machine (`engine/diagnostics.rs`, created first in `setup`):

- A process-wide panic hook writes `crash-reports/<timestamp>.log` (message,
  location, thread, app version, OS, backtrace; the timestamp is UTC RFC 3339
  with `:` → `-` so it is a valid filename on every OS) and appends a
  `PANIC` line to `logs/aether.log`, then calls the previous hook.
- The webview reports through `cmd_log_frontend_error`: the root
  `ErrorBoundary` (`src/components/system/ErrorBoundary.tsx`, also available
  per view via `withViewBoundary`) sends fatal render errors, and
  `src/lib/diagnostics.ts` forwards `window.onerror` / `unhandledrejection`
  (batched, de-duplicated, rate-limited, never throws). Fatal errors also get
  a crash report. Payload fields are truncated before they reach disk.
- `logs/aether.log` rotates at 5 MB and keeps `aether.log.1` … `.3`.
- Crash report ids are validated (`[A-Za-z0-9._-]`, no `..`) so the UI can
  only read files inside `crash-reports/`.

| Command | Input | Output |
| --- | --- | --- |
| `cmd_list_crash_reports` | none | `CrashReportSummary[]` (newest first) |
| `cmd_read_crash_report` | id | `CrashReport` |
| `cmd_clear_crash_reports` | none | number removed |
| `cmd_log_frontend_error` | payload `{ message, stack?, component_stack?, source?, view?, url?, fatal? }` | none |
| `cmd_open_app_data_dir` | none | none (Finder / Explorer / `xdg-open`) |
| `cmd_get_app_info` | none | `{ version, tauri_version, os, arch, data_dir }` |

## Update check

`engine/updater.rs` asks
`https://api.github.com/repos/EkexDon/AETHER-OS/releases/latest` (8 s timeout,
`User-Agent: AETHER-OS/<version>`, no credentials) and compares versions with
a strict SemVer 2.0 parser (`v` prefix allowed, pre-release precedence per
§11, build metadata ignored). It only reports; nothing is downloaded. A
repository without published releases (HTTP 404) counts as "up to date";
offline, timeouts and rate limits surface as readable `network error: …`
messages. Release URLs outside `https://github.com/` are replaced by the
releases page.

| Command | Input | Output |
| --- | --- | --- |
| `cmd_check_for_updates` | none | `UpdateInfo { current, latest, update_available, url, notes, published_at }` |

## Shared SQLite helper

Features that need a relational store (clipboard history, universal search)
use `engine/sqlite.rs` with the bundled SQLite from `rusqlite` (FTS5
included):

- `open_db(path)` creates parent directories and enables `journal_mode=WAL`,
  `foreign_keys=ON`, `synchronous=NORMAL` and a 5 s busy timeout.
- `migrate(conn, &[sql…])` applies pending migrations in order, one
  transaction each, and records the version in a one-row `schema_version`
  table. It is idempotent, rolls back a failing migration and refuses to
  downgrade a database written by a newer build.
- Errors map to `AetherError::Database`.

## Integration anchors

Shared files carry `@anchor:<kind>:<feature>` comments where Wave 2 feature
agents append their lines (SWARM-CONTRACT §3): `engine/mod.rs`,
`commands/mod.rs`, `lib.rs` (`state-field`, `state-init`, `state-manage`,
`handlers`), `Cargo.toml` (`deps`), `src/types/index.ts`, `src/lib/ipc.ts`
and `src/lib/mock/backend.ts`.

## Security boundaries

- The UI has no direct filesystem, process, or shell access.
- AETHER-OS is **read-only** on the NoPes vault — it never writes to or modifies NoPes files.
- AI-generated notes are stored in AETHER-OS's own App Data directory, completely separate from the vault.
- Ollama requests are restricted to `localhost:11434`.
- The OpenRouter API key is stored only in the app data directory (`ai_config.json`),
  never in webview localStorage, and is never logged or returned to the UI.
  Cloud requests go exclusively to `https://openrouter.ai`.
- The update check is the only other outbound request: an anonymous GET to
  `https://api.github.com/repos/EkexDon/AETHER-OS/releases/latest`.
- Crash reports and logs stay in the app data directory; nothing is uploaded.
- Vectors must be finite and match the dimension already stored in the index; changing the embedding model requires re-indexing.
- Embedding calls support both the current `/api/embed` and legacy `/api/embeddings` endpoints, and report a missing model with the exact `ollama pull` command.
