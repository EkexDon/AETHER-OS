# AETHER-OS Architecture (v0.2)

AETHER-OS is a local-first desktop app: a React webview for the UI and a Rust core (Tauri 2) for everything privileged — files, processes, network, crypto. The webview has no direct filesystem, process or shell access; it talks to Rust only through typed IPC commands and events. The user's notes are a plain Markdown folder (the *vault*, Obsidian- and NoPes-compatible); everything else lives in the app data directory (`~/Library/Application Support/com.ekin.aetheros/` on macOS).

Contents: [Components](#components) · [Frontend](#frontend) · [Registries and anchors](#registries-and-anchors) · [IPC layout](#ipc-layout) · [Mock mode](#mock-mode) · [Data flow](#data-flow) · [Destructive-action approval model](#destructive-action-approval-model) · [Engines in detail](#engines-in-detail) · [Security boundaries](#security-boundaries) · [IPC reference](#ipc-reference)

## Components

```text
┌──────────────────────────── React 18 webview (src/) ─────────────────────────────┐
│ shell: Titlebar · NavRail · ViewHost · StatusBar · Launcher · SettingsModal       │
│ views (19) ← src/views/registry.tsx      commands ← src/lib/commands/registry.ts  │
│ settings sections ← src/settings/registry.tsx   status items ← shell/statusbar/   │
│ stores: useAetherStore (global) + one zustand store per feature (src/lib/*Store)  │
│ plugin host → one Web Worker per enabled plugin (typed RPC, permission checks)    │
└───────────────┬───────────────────────────────────────────────▲──────────────────┘
                │ call(cmd, args)  (src/lib/ipc/<domain>.ts)     │ listenSafe(event)
                ▼                                                │
┌──────────── Tauri 2 commands (src-tauri/src/commands/*, 28 modules) ─────────────┐
│ Result<T, String> at the boundary; blocking work on Tauri's blocking pool         │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                ▼  AppState (src-tauri/src/lib.rs) — one Arc per engine
┌──────────────────────── engines (src-tauri/src/engine/*) ────────────────────────┐
│ Knowledge  vault_reader (Markdown vault r/w, index, graph, backlinks, daily note) │
│            vector_db (JSON vectors) · aether_notes · memory_store                 │
│            note_history (notify watcher → git2 commits in <vault>/.git)           │
│            vault_tasks (checkbox parser, write-back, parse cache)                 │
│            search_index/ (SQLite FTS5 + fuzzy + frecency + RRF, apps, files)      │
│            export/ (pulldown-cmark + syntect → HTML, site, bundle, print doc)     │
│ AI         local_ai (Ollama) · cloud_ai (OpenRouter) · ai_config                  │
│            agent_actions (action enum + risk) · intel/ (compaction, suggestions,  │
│            approvals + audit log, shell_exec)                                     │
│ Build      workspace (sandboxed FS) · git_repo (git2) · lsp (sidecars)            │
│            terminal (portable-pty)                                                │
│ Life       calendar · calendar_ics · calendar_notifier · task_board · focus_log   │
│ System     system_monitor (sysinfo) · browser (native webviews) · web_clipper     │
│            clipboard (arboard poll → SQLite + FTS5) · plugins (manifests, grants) │
│            sync/ (crypto, folder_sync, conflict, snapshot = backups)              │
│            onboarding (setup state, vault detection, model pulls, reset)          │
│ Infra      diagnostics (panic hook, log, crash reports) · updater · sqlite ·     │
│            fs_guard (shared path confinement) · error (AetherError)               │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                ▼
   <vault>/ (Markdown, .git, .trash)   <app data>/ (one subfolder per engine)
   localhost:11434 (Ollama) · https://openrouter.ai · api.github.com (update check)
```

Each engine owns a subfolder of the app data directory (`Engine::new(&data_dir.join("<feature>"))`), returns `Result<T, AetherError>` and has `#[cfg(test)]` tests against `tempfile` directories. The command layer maps errors to strings with `.map_err(|e| e.to_string())`. `setup()` in `lib.rs` creates `Diagnostics` first (so a failing engine is logged), then every engine, then `app.manage(AppState { … })`; background threads (clipboard watcher, search indexer, history watcher, sync loop, calendar notifier) start there.

## Frontend

- **Shell** (`src/shell/`): `Titlebar` (drag regions, command pill, capture / clip / agent buttons), `NavRail` (views grouped Knowledge · Build · Life · System; ⌘\ shows labels), `ViewHost` (lazy views with suspense, `keepAlive` views stay mounted, one error boundary per view), `StatusBar` (registry-driven items), `ShortcutsOverlay`, `useGlobalShortcuts` (one window-level key handler resolving registry shortcuts), `FeatureHosts` (`FEATURE_HOSTS`: always-mounted hosts rendered once outside the view host, each in its own error boundary — the onboarding overlays, the note-task quick-add dialog, the plugin host bootstrap and the quit confirmation; this is the sanctioned place for session-long overlays and subscriptions, not invisible status bar items).
- **Design system** (`src/styles/`, `src/ui/`): semantic tokens for both themes and four accents, 22 primitives (`Button`, `Modal`, `Tabs`, `ViewHeader`, `Toast` …). Every stylesheet — including each feature's `src/styles/views/<feature>.css` — is imported exactly once from `src/styles/index.css` (checked by `src/styles/styles.test.ts`); components never import CSS. Rules and recipes: [`docs/dev/DESIGN-SYSTEM.md`](docs/dev/DESIGN-SYSTEM.md).
- **State**: `useAetherStore` (`src/lib/store.ts`) holds cross-cutting state (view, vault notes, selected note, agent panel, provider/model); `useShellStore` (`src/shell/shellStore.ts`) holds shell overlays (`launcherOpen` / `toggleLauncher` / `closeLauncher`, settings, shortcuts overlay). Each feature has its own zustand store (`clipboardStore`, `searchStore`, `historyStore`, `pinsStore`, `focusStore`, `vaultTasksStore`, `intelStore`, `usePluginsStore`, `exportStore`, `syncStore`, `onboardingStore`, `ideStore` …). Pure logic lives in `src/lib/<feature>/*.ts` so it is testable without a DOM.
- **Buses**: `noteEditorBus` (`requestNoteReload(path)` makes the editor re-read a note another feature changed on disk) and `agentChatBus` (`openConversation(id)`, `startNewConversation()`).

## Registries and anchors

Features plug into shared files without editing each other's code. Every shared file carries named anchor comments; a feature adds its lines directly above its own anchor (`@anchor:<kind>:<feature>`), never elsewhere.

| Registry / file | Anchor | Contribution |
| --- | --- | --- |
| `src-tauri/src/engine/mod.rs` | `engine:<feature>` | `pub mod <feature>;` |
| `src-tauri/src/commands/mod.rs` | `commands:<feature>` | `pub mod <feature>_commands;` |
| `src-tauri/src/lib.rs` | `state-field`, `state-init`, `state-manage`, `handlers` | `AppState` field, construction, registration of `cmd_*` |
| `src-tauri/Cargo.toml` | `deps:<feature>` | crate dependencies |
| `src/types/index.ts`, `src/lib/ipc.ts` | `types:<feature>`, `ipc:<feature>` | `export * from "./<feature>"` |
| `src/lib/mock/backend.ts` | `mock:<feature>` | `...<feature>Handlers` |
| `src/views/modes.ts`, `src/views/registry.tsx` | `mode:`, `view-import:`, `view:` | a `ViewMode` member and one `ViewDefinition { mode, label, icon, group, shortcut?, component, keepAlive?, hidesVaultSidebar?, description }` |
| `src/lib/commands/registry.ts` | `command-import:`, `command:` | `CommandContribution[] { id, title, group, icon?, shortcut?, keywords?, run(ctx), when?(ctx) }` |
| `src/settings/registry.tsx` | `settings-import:`, `settings:` | `SettingsSection { id, title, icon, order, component, keywords }` |
| `src/shell/statusbar/registry.ts` | `status-import:`, `status:` | `registerStatusItem({ id, order, component, align })` |
| `src/shell/FeatureHosts.tsx` | `FEATURE_HOSTS` | `{ id: "<feature>.<name>", component }` — an always-mounted host |
| `src/styles/index.css` | "Feature views" block | `@import "./views/<feature>.css";` |

The view registry feeds the rail, `viewNavigationCommands` ("Go to <view>" with the view's shortcut) and the shortcuts overlay. The command registry feeds the launcher, `useGlobalShortcuts`, the shortcuts overlay, Settings → Shortcuts and the Markdown cheat sheet. Registry tests (`src/views/registry.test.ts`, `src/settings/registry.test.ts`, `src/shell/statusbar/registry.test.ts`) keep ids unique and view shortcuts within ⌘1–⌘9. The binding rules are in [`docs/dev/SWARM-CONTRACT.md`](docs/dev/SWARM-CONTRACT.md) §3–5.

## IPC layout

```text
src/lib/ipc.ts                 export * from "./ipc/<domain>"   (+ // @anchor:ipc:<feature>)
src/lib/ipc/core.ts            call(), listenSafe(), isTauriRuntime(), isMockRuntime(),
                               isDesktopRuntime(), IpcUnavailableError
src/lib/ipc/<domain>.ts        one documented wrapper per command, typed with src/types/<domain>.ts
```

- `call(command, args)` uses Tauri's `invoke` in the desktop shell, the DEV mock backend under `npm run dev:mock`, and throws `IpcUnavailableError` in a plain browser. Rejections are rethrown as `Error` with the backend's message.
- `listenSafe(event, handler)` delivers event payloads; it resolves to a no-op unlisten in a plain browser and never throws there.
- Top-level command arguments are camelCase in JS (Tauri renames Rust's snake_case); nested structs keep their serde (snake_case) field names.
- Events (backend → webview): `llm-stream-chunk`, `terminal-output`, `lsp-message`, `browser-webview-nav`, `browser-webview-title`, `clipboard-changed`, `launcher-open`, `search-index-progress`, `search-index-updated`, `history-commit`, `export-progress`, `sync-status`, `sync-progress`, `ollama-pull-progress`, `quit-requested`.

## Mock mode

`npm run dev:mock` sets `VITE_AETHER_MOCK=1`; `call()` then routes to `src/lib/mock/backend.ts`, which aggregates one handler map per domain (`src/lib/mock/<domain>.ts`): a 33-note bilingual demo vault with a wikilink graph and dated tasks, four Git repositories, an IDE file system, calendar, task boards, 40 clipboard clips, a five-week note history, two sync devices with one conflict and four backups, three plugins, focus sessions, a fake PTY and a fake streaming LLM that emits agent actions on request. Handlers deep-copy arguments and results, reject with the same messages as Rust and take 8–40 ms.

- The mock is imported dynamically inside `if (import.meta.env.DEV)`, so production bundles do not contain it; `test_runner.sh` and CI grep `dist/` to prove it.
- `src/lib/mock/backend.test.ts` parses `generate_handler![…]` in `lib.rs` and fails when a registered command has no mock handler, a handler has no command, or an IPC wrapper calls an unregistered command.
- `window.__AETHER_MOCK__` exposes `handlers`, `events`, `invoke` and `reset()` for manual QA. Details: [`docs/dev/MOCK-MODE.md`](docs/dev/MOCK-MODE.md).

## Data flow

### A note edit

```text
keystroke in NoteEditor (TipTap)
  └─ onUpdate → Markdown serialised → autosave.schedule(path, content)   src/lib/autosave.ts
       path and content are bound when the save is scheduled; 1.2 s debounce;
       flushed immediately on note switch, view switch and unmount (fixes cross-note data loss)
  └─ cmd_write_note(path, content) → VaultReader::write_note                 canonicalised, must stay inside the vault
       │
       ├─ note_history watcher (notify, 2 s debounce) → git2 commit "note: <path>" in <vault>/.git
       │     → event history-commit → status bar "last snapshot", History view, editor drawer
       │     (safety scan every 30 s commits anything the watcher missed)
       ├─ search_index: next cmd_search_query re-scans vault mtimes if the last scan is > 10 s old;
       │     only changed notes are re-read into FTS5 (launcher / Universal Search stay current)
       ├─ vault_tasks: next cmd_vault_tasks_list / stats re-parses notes whose mtime or size changed
       │     (Note Tasks refreshes on open and window focus; Home and the status bar chip read the same)
       ├─ intel: 1.5 s after typing stops, related notes / tags are recomputed (keyword scorer,
       │     vector index when built) → status bar "N related"
       ├─ sync (when unlocked): the next round (default every 60 s) hashes, encrypts and uploads it
       └─ vector_db: unchanged until the next explicit "Index vault" (semantic search + agent context)
```

Features that change a note behind the editor's back make the editor re-read it instead of letting a pending autosave overwrite the change: History restores call `requestNoteReload(path)` (`src/lib/noteEditorBus.ts`); agent actions, related-note links and tag chips first wait until the editor is clean, write, then reload the open note (`src/lib/intel/noteEdits.ts`).

### An agent question

`AgentChat` → `cmd_agent_query_with_notes(prompt, notePaths, model, provider, conversation)` → the prompt builder (`ai_commands.rs` + `intel/compaction.rs`) adds memory facts, note context (budgeted per provider: small for local 4k models), the compaction summary and the newest messages → `local_ai` or `cloud_ai` streams tokens as `llm-stream-chunk` → the frontend parses ```` ```action ```` blocks (`lib/agentActions.ts`) → `intel/pipeline.ts` runs safe actions, queues gated ones for approval, executes in order (`intel/executeAction.ts`) and records the result → after the reply, auto-compaction runs when the window passes the threshold → the session is saved as one `MemoryStore` record (`cmd_intel_save_conversation`).

### A launcher query

`Launcher` (60 ms debounce, stale responses dropped) → `cmd_search_query(q, kinds, limit, perKind)` → FTS5 `bm25()` (title 10 · tags 5 · body 1) + fuzzy titles (+ semantic top 30 in the Search view) → reciprocal-rank fusion × frecency boost → results per kind; commands, bookmarks and clipboard items are merged in the webview. Opening a result records it via `cmd_search_recents_record`.

## Destructive-action approval model

Nothing that removes data or runs code happens without a visible, explicit step.

| Surface | Mechanism |
| --- | --- |
| Agent actions | Every `AgentAction` has a risk (`action_risk` in `engine/agent_actions.rs`, mirrored by `actionRisk` in `src/lib/intel/risk.ts`). **safe** runs automatically; **confirm** (`move_note`, `git_commit`, `toggle_vault_task`, `update_calendar_event`, `import_calendar_ics`) and **dangerous** (`run_command`, `delete_note`, `delete_calendar_event`) wait for the `ApprovalModal`. `cmd_intel_preview_action` resolves what will happen (working directory, note path, files of a commit, the task line) and adds warnings for destructive shell patterns. Esc / close denies. |
| "Always allow" | Per action kind; commands scoped to a directory subtree. Confirm-rules persist on the device (`localStorage`), dangerous-rules live in memory until quit. Revocable in Settings → AI Intelligence. |
| Audit | Actions executed by `cmd_intel_*` are audited in Rust; others and every denial via `cmd_intel_audit_record` → `<app data>/intel/audit.jsonl` (trimmed past 2 MB). |
| Soft deletes | `delete_note` moves to `<vault>/.trash/<timestamp>-<name>.md`; sync deletions go to `<vault>/.trash/` (vault) or `<app data>/sync/trash/`; clipboard deletes are committed after a 5 s Undo; pin removal has Undo. |
| Reversible writes | Every note save is a Git version; *Restore* creates a new `restore:` version. `move_note` never overwrites; exports refuse to clobber a non-AETHER folder; `create_note` never overwrites. |
| Heavy resets | Reset app data: checkbox + typing `RESET`; the data folder is renamed to `<data_dir>-backup-<ts>`. Backup *Replace* restore renames the target to `<name>.pre-restore-<ts>`. Sync conflicts keep both versions. Plugin uninstall and clipboard *Clear history* confirm first. |
| Quit | With running terminal sessions, quitting asks first (General → confirm quit, default on); a second quit within 5 s goes through. |

## Engines in detail

### AI agent actions

The system prompt (`commands/ai_commands.rs`) teaches the model to emit ```` ```action ```` JSON blocks; the frontend parser extracts them on every response. Pure-vault actions go through `cmd_execute_agent_action`; actions that need another engine are routed through `cmd_agent_*` (`open_url`, `clip_url` — fetch in Rust, Markdown conversion with `turndown` in the webview —, `add_memory_fact`, `save_aether_note`) or the `cmd_intel_*` commands (`run_command`, `delete_note`, `move_note`, `git_commit`, `create_task`, `toggle_vault_task`). `lib/agentModelSupport.ts` flags model families that are known to ignore the format (`tools: unreliable`).

| Action | Risk | Command |
| --- | --- | --- |
| `create_note`, `append_note`, `append_daily` | safe | `cmd_execute_agent_action` |
| `add_memory_fact`, `save_aether_note`, `open_url`, `clip_url` | safe | `cmd_agent_*` |
| `create_calendar_event`, `list_calendar_events` | safe | calendar commands |
| `create_task { project_id?, title, … }` | safe | `cmd_intel_create_task` (project id or name, default *Inbox*) |
| `move_note { from, to }` | confirm | `cmd_intel_move_note` — never overwrites |
| `git_commit { project_path, message }` | confirm | `cmd_intel_git_commit` — staged changes, or all when nothing is staged; repo must be inside a project dir |
| `toggle_vault_task { note_path, line }` | confirm | `cmd_intel_toggle_vault_task` — one-character rewrite |
| `update_calendar_event`, `import_calendar_ics` | confirm | calendar commands |
| `run_command { command, cwd? }` | dangerous | `cmd_intel_run_command` — `sh -lc`, stdin closed, `AETHER_AGENT=1`, cwd inside a project dir or the vault, 60 s timeout (15 s–5 min), process group killed on timeout, 64 KB per stream |
| `delete_note { path }` | dangerous | `cmd_intel_delete_note` — moves to `<vault>/.trash/` |
| `delete_calendar_event { id }` | dangerous | `cmd_delete_calendar_event` |

Conversation memory: `cmd_agent_query_with_notes` accepts `conversation { id, summary, history }`; `cmd_intel_compact` summarises all but the last N messages with the current model (structured: topic, facts, decisions, open questions, preferences) and falls back to an extractive summary. Details: [`docs/features/intel.md`](docs/features/intel.md).

### Search index

`engine/search_index/` keeps one SQLite database (`search/index.db`, WAL) with an external-content FTS5 table over notes, projects, files (names and paths only, `ignore`-crate walk honouring `.gitignore`, ≤ 50 000 files), macOS apps (`Info.plist`), events, tasks, memory facts and conversations. Retrieval fuses keyword, fuzzy-title and (optionally) semantic rankings with RRF (`Σ w / (60 + rank)`) and a frecency boost. FTS queries are built from alphanumeric terms only; snippets are escaped in Rust and rendered as text. The global launcher shortcut (`tauri-plugin-global-shortcut`, default ⌥Space) emits `launcher-open`. Details: [`docs/features/search.md`](docs/features/search.md).

### Note history

`engine/note_history.rs` initialises (or adopts) a Git repository at the vault root, commits from `HEAD` plus exactly the changed paths (never sweeping in files staged by hand), pauses during merges/rebases/detached HEAD, refuses a vault nested inside another repository, and never touches remotes, branches or config. Details: [`docs/features/history.md`](docs/features/history.md).

### Sync & backup

`engine/sync/` implements encrypted folder sync: a per-store Argon2id master key (m = 64 MiB, t = 3), BLAKE3-derived sub-keys, AES-256-GCM envelopes with authenticated headers, content-addressed blobs, per-device encrypted indexes, tombstones (30 days) and conflict copies; `snapshot.rs` writes self-contained `.aetherbak` archives. Keys are `Zeroizing` and wiped on lock, folder change and window close. **There is no relay server**; devices meet only in the shared folder. The on-disk format is specified in [`docs/features/sync.md`](docs/features/sync.md) so a relay or mobile client can reuse it.

### Plugins

`src/lib/plugins/host.ts` runs one Web Worker per enabled plugin from a blob URL. `bootstrap.ts` deletes and locks network, storage, worker and notification APIs before the plugin's code runs and installs a host-routed `fetch` only for granted `net:fetch:<host>` permissions. Every RPC call is validated and permission-checked in the host, then again in Rust (`engine/plugins.rs`: manifest validation, folder/zip install with traversal/symlink/size protection, capability checks for vault, notes and fetch). Panels are a validated JSON view tree or sanitised Markdown — never raw HTML. The desktop CSP allows `blob:` workers and scripts for this. Author guide: [`docs/PLUGIN-API.md`](docs/PLUGIN-API.md).

### Export

`engine/export/` renders Markdown with `pulldown-cmark`, highlights code with `syntect` into CSS classes, resolves wikilinks like Obsidian, sanitises raw HTML against an allowlist (no scripts, styles, iframes, event handlers, `javascript:` URLs) and writes standalone HTML, a static site (relative links only, `.aether-site.json` marker, stale pages removed on re-export) or a zip bundle (written to a temp file, then renamed). PDF goes through the system print dialog. Details: [`docs/features/export.md`](docs/features/export.md).

### Clipboard

`engine/clipboard.rs` polls the system clipboard via `arboard` every 700 ms (images with back-off), deduplicates by SHA-256, classifies text / url / code / color / image, drops likely secrets before storage, and stores clips in SQLite + FTS5 with retention (pinned clips are never pruned). Details: [`docs/features/clipboard.md`](docs/features/clipboard.md).

### IDE: workspace, Git and language servers

- `engine/workspace.rs` is the sandbox: every IDE path must resolve (after symlinks) inside a configured project directory or the vault.
- `engine/git_repo.rs` wraps libgit2 for one repository: status with staged/unstaged split, stage/unstage/discard, commit, branches, log and per-file old/new content for diffs. Discovered work trees must still be inside an allowed root. Identity falls back to `AETHER-OS <aether@local>`.
- `engine/lsp.rs` finds language servers on PATH (`typescript-language-server`, `rust-analyzer`, `pyright`/`pylsp`, `vscode-json-language-server`), speaks the `Content-Length` stdio framing and forwards JSON-RPC over `lsp-message` events. It is transport-only; the protocol lives in `lib/lsp.ts` / `lib/lspMonaco.ts`. One process per (language, root), started lazily, killed on folder close and app exit.

### Embedded browser

Browser tabs are native webviews embedded as child views of the main window (Tauri multiwebview, `unstable` feature) — no iframe, no proxy. Bounds are logical pixels from `getBoundingClientRect()`; navigation and title changes stream as `browser-webview-nav` / `browser-webview-title`; webviews are hidden when leaving the view and repositioned by a `ResizeObserver`.

### Diagnostics & crash reports

`engine/diagnostics.rs` is created first in `setup`. A panic hook writes `crash-reports/<timestamp>.log` (message, location, thread, version, OS, backtrace) and a `PANIC` line to `logs/aether.log`. The webview reports through `cmd_log_frontend_error` (root and per-view error boundaries, `window.onerror`, `unhandledrejection`; batched, de-duplicated, rate-limited). The log rotates at 5 MB (three generations). Crash report ids are validated so the UI can only read files inside `crash-reports/`. Nothing is uploaded.

### Update check

`engine/updater.rs` asks `https://api.github.com/repos/EkexDon/AETHER-OS/releases/latest` (8 s timeout, `User-Agent: AETHER-OS/<version>`, no credentials) and compares versions with a strict SemVer 2.0 parser. It only reports; nothing is downloaded. A repository without releases counts as up to date; offline and rate limits surface as readable errors. The daily automatic check is opt-in.

### Shared SQLite helper

Clipboard and search use `engine/sqlite.rs` with the bundled SQLite from `rusqlite` (FTS5 included): `open_db(path)` enables WAL, foreign keys, `synchronous=NORMAL` and a 5 s busy timeout; `migrate(conn, &[sql…])` applies pending migrations in order, one transaction each, records the version in `schema_version`, and refuses to downgrade a database written by a newer build. Errors map to `AetherError::Database`.

## Security boundaries

- **Webview isolation.** The UI has no direct filesystem, process or shell access; all privileged work is a `#[tauri::command]` in Rust. Paths from the UI — and from synced indexes, restored backups and model-proposed actions — are untrusted: `engine/fs_guard.rs` canonicalises them (for paths that do not exist yet, the deepest existing ancestor), requires the result to stay inside the vault, a configured project directory or the app data directory, rejects `.`/`..` in the missing tail, and creates directories only after that check, so a symlinked folder cannot be used to write outside a root. Ids that become file names (calendar events, task projects and items, AI notes) are validated by `check_file_id` in the same module; crash reports, conversations, clips and plugins validate their ids in their own engines.
- **The vault is read and written.** AETHER-OS writes notes (editor, capture, clipper, agent, note tasks, related-note links, sync downloads, restores), creates `<vault>/.git` for note history (plus a `.gitignore` for new repositories) and `<vault>/.trash/` for soft deletes. An existing Git repository is used as is; remotes, branches and config are never touched. History can be switched off.
- **Agent execution.** `run_command` needs an explicit approval (or a session-scoped rule), runs only with a working directory inside a project directory or the vault, gets a minimal environment (`PATH`, `HOME`, `LANG`, `TERM`, `AETHER_AGENT=1` — no inherited secrets), has a timeout and 64 KB output caps with a truncation marker, and kills its process group on timeout. Destructive note operations are soft deletes. See [the approval model](#destructive-action-approval-model).
- **Media in notes.** The webview has no file access, so images, audio, video and PDFs embedded in notes (`![](x.png)`, `![[x.png]]`) are loaded through `cmd_read_vault_asset`: the path must resolve inside the vault, the extension must be on an allowlist, files are capped at 25 MB, and the bytes come back base64-encoded (`src/lib/vaultAssets.ts` caches them per path).
- **Plugin sandbox.** Workers without DOM, IPC, network or storage; explicit, revocable permissions enforced twice (webview host and Rust); HTTPS GET only to granted hosts; panels rendered from validated data, never HTML.
- **Sync crypto.** Only ciphertext and keyed hashes reach the sync folder (Argon2id, AES-256-GCM, BLAKE3; audited crates; test vectors for each primitive). The passphrase is never stored; the derived key is written to `sync/key.bin` (0600) only with the opt-in "remember on this device". Visible metadata: blob count and sizes, modification times, device ids.
- **Clipboard.** Likely secrets (token formats, JWTs, PEM keys, card numbers, high-entropy strings) are dropped before storage; capture can be paused; everything stays local.
- **Network.** Ollama only at `localhost:11434`; cloud AI only at `https://openrouter.ai` (the key lives in `<app data>/ai/ai_config.json`, never in webview storage, never logged or returned to the UI); the update check is an anonymous GET to the GitHub releases API. Other requests happen only on explicit user action (clip or open a URL) or through a plugin's granted HTTPS hosts. Exports reference no network resource unless the user enables mermaid rendering (`cdn.jsdelivr.net`).
- **CSP** (`tauri.conf.json`): `default-src 'self'`, `connect-src` limited to self, Ollama and localhost, `worker-src 'self' blob:` for plugins.
- **Diagnostics** stay in the app data directory; there is no telemetry. `redact_secrets` replaces API keys, bearer tokens and `key=value` secrets with `[REDACTED]` in every log line and crash report before it is written and again when it is read back.
- **External launches.** The update check only hands the UI `https://github.com/EkexDon/AETHER-OS/…` URLs (exact host, no credentials or custom port; anything else falls back to the releases page). A custom external editor must be a plain macOS application name and is only launched via `open -a`; app and installer bundles are never opened as projects.
- **Fetching.** The web clipper caps pages at 10 MB; exported pages keep only `http(s)`, `mailto` and `tel` links (`obsidian:`-style app schemes are dropped) and `data:` URLs only for images; file exports never overwrite an existing file unless `overwrite` is confirmed.
- **Vectors** must be finite and match the index dimension; changing the embedding model requires re-indexing. Embedding calls support `/api/embed` and the legacy `/api/embeddings` and report a missing model with the exact `ollama pull` command.

## IPC reference

The backend registers **237 commands** in **28 modules** (`generate_handler!` in `src-tauri/src/lib.rs` is the definitive list; this reference is generated from it and the Rust signatures). Arguments are shown with their JS (camelCase) names; `—` means none / unit. Feature modules link to their feature doc for validation rules and events.

<!-- IPC:BEGIN -->
#### Vault — `commands/vault_commands.rs` (8)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_get_vault_path` | — | `Option<String>` |
| `cmd_set_vault_path` | `path: String` | — |
| `cmd_get_vault_notes` | — | `Vec<VaultNote>` |
| `cmd_get_note_content` | `path: String` | `String` |
| `cmd_get_vault_index` | — | `Option<VaultIndex>` |
| `cmd_get_vault_graph` | — | `GraphData` |
| `cmd_get_vault_stats` | — | `VaultStats` |
| `cmd_read_vault_asset` | `path: String` | `VaultAsset` |

#### AI, embeddings & providers — `commands/ai_commands.rs` (10)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_index_vault` | — | `IndexingResult` |
| `cmd_semantic_search` | `query: String`, `limit: usize` | `Vec<VectorMatch>` |
| `cmd_agent_query` | `prompt: String`, `model: String` | `Vec<String>` |
| `cmd_agent_query_with_notes` | `prompt: String`, `notePaths: Vec<String>`, `model: String`, `provider: Option<String>`, `conversation: Option<ConversationContext>` | — |
| `cmd_set_openrouter_key` | `key: Option<String>` | `bool` |
| `cmd_get_embedding_model` | — | `String` |
| `cmd_set_embedding_model` | `model: String` | `String` |
| `cmd_list_cloud_models` | — | `Vec<String>` |
| `cmd_list_local_models` | — | `Vec<String>` |
| `cmd_get_health` | — | `SystemHealth` |

#### AI Notes — `commands/aether_note_commands.rs` (3)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_create_aether_note` | `title: String`, `content: String`, `sourceQuery: String`, `relatedNotes: Vec<String>` | `AetherNote` |
| `cmd_get_aether_notes` | — | `Vec<AetherNote>` |
| `cmd_delete_aether_note` | `id: String` | — |

#### Projects — `commands/project_commands.rs` (7)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_scan_projects` | `directories: Vec<String>` | `Vec<Project>` |
| `cmd_open_project` | `path: String`, `editor: Option<String>` | — |
| `cmd_open_in_terminal` | `path: String` | — |
| `cmd_open_in_finder` | `path: String` | — |
| `cmd_get_project_dirs` | — | `Vec<String>` |
| `cmd_add_project_dir` | `dir: String` | `Vec<String>` |
| `cmd_remove_project_dir` | `dir: String` | `Vec<String>` |

#### Memory & conversations — `commands/memory_commands.rs` (6)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_save_conversation` | `messages: Vec<ChatMessageRecord>`, `contextNotes: Vec<String>` | `Conversation` |
| `cmd_get_recent_conversations` | `limit: Option<usize>` | `Vec<Conversation>` |
| `cmd_delete_conversation` | `id: String` | — |
| `cmd_save_memory_fact` | `fact: String`, `category: String` | `Vec<MemoryFact>` |
| `cmd_get_memory_facts` | — | `Vec<MemoryFact>` |
| `cmd_delete_memory_fact` | `fact: String` | `Vec<MemoryFact>` |

#### Terminal — `commands/terminal_commands.rs` (5)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_terminal_spawn` | `cwd: Option<String>`, `shell: Option<String>`, `cols: Option<u16>`, `rows: Option<u16>` | `TerminalSession` |
| `cmd_terminal_write` | `id: String`, `data: String` | — |
| `cmd_terminal_resize` | `id: String`, `cols: u16`, `rows: u16` | — |
| `cmd_terminal_kill` | `id: String` | — |
| `cmd_terminal_list` | — | `Vec<TerminalSession>` |

#### System monitor — `commands/system_commands.rs` (1)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_get_system_metrics` | — | `SystemMetrics` |

#### Browser — `commands/browser_commands.rs` (14)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_browser_info` | — | `BrowserInfo` |
| `cmd_browser_open` | `url: String` | — |
| `cmd_browser_open_librewolf` | `url: String` | — |
| `cmd_browser_webview_open` | `url: String`, `x: f64`, `y: f64`, `width: f64`, `height: f64` | `String` |
| `cmd_browser_webview_close` | `label: String` | — |
| `cmd_browser_webview_navigate` | `label: String`, `url: String` | — |
| `cmd_browser_webview_back` | `label: String` | — |
| `cmd_browser_webview_forward` | `label: String` | — |
| `cmd_browser_webview_reload` | `label: String` | — |
| `cmd_browser_webview_list` | — | `Vec<(String, String)>` |
| `cmd_browser_webview_set_bounds` | `label: String`, `x: f64`, `y: f64`, `width: f64`, `height: f64` | — |
| `cmd_browser_webview_show` | `label: String` | — |
| `cmd_browser_webview_hide` | `label: String` | — |
| `cmd_browser_webview_hide_all` | — | — |

#### Notes & capture — `commands/note_commands.rs` (8)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_write_note` | `path: String`, `content: String` | — |
| `cmd_create_note` | `relPath: String`, `content: String` | `String` |
| `cmd_append_note` | `path: String`, `content: String` | — |
| `cmd_get_backlinks` | `noteName: String` | `Vec<Backlink>` |
| `cmd_daily_note` | — | `String` |
| `cmd_append_daily` | `text: String` | `String` |
| `cmd_clip_url` | `url: String` | `ClippedPage` |
| `cmd_execute_agent_action` | `action: AgentAction` | `String` |

#### Agent actions (routed) — `commands/agent_action_commands.rs` (4)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_agent_open_url` | `url: String` | `AgentActionResult` |
| `cmd_agent_clip_url` | `url: String` | `AgentActionResult` |
| `cmd_agent_add_memory_fact` | `fact: String`, `category: String` | `AgentActionResult` |
| `cmd_agent_save_aether_note` | `title: String`, `content: String` | `AgentActionResult` |

#### IDE workspace (sandboxed FS) — `commands/ide_commands.rs` (6)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_ide_roots` | — | `Vec<String>` |
| `cmd_ide_list_dir` | `path: String` | `Vec<FsEntry>` |
| `cmd_ide_read_file` | `path: String` | `String` |
| `cmd_ide_write_file` | `path: String`, `content: String` | — |
| `cmd_ide_create_file` | `path: String`, `content: String` | `String` |
| `cmd_ide_create_dir` | `path: String` | `String` |

#### Git (IDE source control) — `commands/git_commands.rs` (10)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_git_status` | `path: String` | `RepoStatus` |
| `cmd_git_stage` | `path: String`, `files: Vec<String>` | — |
| `cmd_git_unstage` | `path: String`, `files: Vec<String>` | — |
| `cmd_git_discard` | `path: String`, `files: Vec<String>` | — |
| `cmd_git_commit` | `path: String`, `message: String` | `String` |
| `cmd_git_branches` | `path: String` | `Vec<BranchInfo>` |
| `cmd_git_switch_branch` | `path: String`, `branch: String` | — |
| `cmd_git_create_branch` | `path: String`, `branch: String` | — |
| `cmd_git_log` | `path: String`, `limit: Option<usize>` | `Vec<CommitInfo>` |
| `cmd_git_diff_file` | `path: String`, `file: String`, `staged: bool` | `FileDiff` |

#### Calendar — `commands/calendar_commands.rs` (12)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_list_calendar_events` | — | `Vec<CalendarEvent>` |
| `cmd_get_calendar_event` | `id: String` | `CalendarEvent` |
| `cmd_create_calendar_event` | `title: String`, `description: String`, `allDay: bool`, `start: String`, `end: String`, `due: Option<String>`, `color: String`, `tags: Vec<String>`, `attendees: Vec<String>`, `location: Option<String>`, `sourceNotePath: Option<String>` | `CalendarEvent` |
| `cmd_update_calendar_event` | `id: String`, `patch: EventPatch` | `CalendarEvent` |
| `cmd_delete_calendar_event` | `id: String` | — |
| `cmd_export_calendar_ics` | `from: Option<String>`, `to: Option<String>`, `calendarName: Option<String>` | `String` |
| `cmd_import_calendar_ics` | `content: String`, `overwriteExisting: bool`, `defaultColor: String` | `IcsImportResult` |
| `cmd_write_ics_to_path` | `path: String`, `content: String` | — |
| `cmd_read_ics_from_path` | `path: String` | `String` |
| `cmd_get_reminder_settings` | — | `ReminderSettings` |
| `cmd_set_reminder_settings` | `settings: ReminderSettings` | — |
| `cmd_request_notification_permission` | — | `bool` |

#### Language servers — `commands/lsp_commands.rs` (4)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_lsp_start` | `rootPath: String`, `language: String` | `Option<LspSessionInfo>` |
| `cmd_lsp_send` | `key: String`, `message: Value` | — |
| `cmd_lsp_stop` | `key: String` | — |
| `cmd_lsp_stop_all` | — | — |

#### Task boards — `commands/task_commands.rs` (10)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_list_task_projects` | — | `Vec<TaskProject>` |
| `cmd_get_task_project` | `id: String` | `TaskProject` |
| `cmd_create_task_project` | `name: String`, `description: String`, `color: String`, `icon: Option<String>` | `TaskProject` |
| `cmd_update_task_project` | `id: String`, `patch: TaskProjectPatch` | `TaskProject` |
| `cmd_delete_task_project` | `id: String` | — |
| `cmd_list_tasks` | `projectId: Option<String>` | `Vec<TaskItem>` |
| `cmd_get_task` | `id: String` | `TaskItem` |
| `cmd_create_task` | `projectId: String`, `title: String`, `description: String`, `status: String`, `priority: String`, `dueDate: Option<String>`, `labels: Vec<String>`, `order: Option<i64>` | `TaskItem` |
| `cmd_update_task` | `id: String`, `patch: TaskItemPatch` | `TaskItem` |
| `cmd_delete_task` | `id: String` | — |

#### Diagnostics & crash reports — `commands/diagnostics_commands.rs` (6)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_list_crash_reports` | — | `Vec<CrashReportSummary>` |
| `cmd_read_crash_report` | `id: String` | `CrashReport` |
| `cmd_clear_crash_reports` | — | `usize` |
| `cmd_log_frontend_error` | `payload: FrontendErrorPayload` | — |
| `cmd_open_app_data_dir` | — | — |
| `cmd_get_app_info` | — | `AppInfo` |

#### Update check — `commands/updater_commands.rs` (1)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_check_for_updates` | — | `UpdateInfo` |

#### App lifecycle — `commands/app_commands.rs` (1)

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_quit_confirmed` | — | — |

#### Clipboard — `commands/clipboard_commands.rs` (13)

Semantics, validation and events: [`docs/features/clipboard.md`](docs/features/clipboard.md).

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_clipboard_list` | `query: Option<String>`, `kind: Option<String>`, `pinnedOnly: bool`, `limit: Option<u32>`, `offset: Option<u32>` | `Vec<ClipItem>` |
| `cmd_clipboard_get` | `id: String` | `ClipItem` |
| `cmd_clipboard_copy` | `id: String` | `ClipItem` |
| `cmd_clipboard_pin` | `id: String`, `pinned: bool` | `ClipItem` |
| `cmd_clipboard_delete` | `id: String` | — |
| `cmd_clipboard_clear` | `keepPinned: bool` | `usize` |
| `cmd_clipboard_get_settings` | — | `ClipboardSettings` |
| `cmd_clipboard_set_settings` | `settings: ClipboardSettings` | `ClipboardSettings` |
| `cmd_clipboard_set_paused` | `paused: bool` | `bool` |
| `cmd_clipboard_stats` | — | `ClipboardStats` |
| `cmd_clipboard_save_as_note` | `id: String`, `title: String` | `String` |
| `cmd_clipboard_image` | `id: String`, `thumbnail: bool` | `String` |
| `cmd_clipboard_copy_latest` | — | `Option<ClipItem>` |

#### Launcher & Universal Search — `commands/search_commands.rs` (10)

Semantics, validation and events: [`docs/features/search.md`](docs/features/search.md).

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_search_query` | `q: String`, `kinds: Option<Vec<String>>`, `limit: usize`, `perKind: Option<usize>`, `semantic: Option<bool>` | `Vec<SearchHit>` |
| `cmd_search_reindex` | `kinds: Option<Vec<String>>` | `IndexReport` |
| `cmd_search_apps` | — | `Vec<AppEntry>` |
| `cmd_launch_app` | `path: String` | — |
| `cmd_search_recents_record` | `id: String`, `kind: String`, `title: Option<String>` | — |
| `cmd_search_recents_list` | `limit: Option<usize>` | `Vec<RecentHit>` |
| `cmd_search_recents_clear` | — | — |
| `cmd_search_get_settings` | — | `SearchSettings` |
| `cmd_search_set_settings` | `settings: SearchSettings` | `SearchSettings` |
| `cmd_search_status` | — | `SearchStatus` |

#### Note history — `commands/history_commands.rs` (8)

Semantics, validation and events: [`docs/features/history.md`](docs/features/history.md).

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_history_status` | — | `HistoryStatus` |
| `cmd_history_list` | `path: String`, `limit: Option<usize>` | `Vec<NoteVersion>` |
| `cmd_history_read` | `path: String`, `commitId: String` | `String` |
| `cmd_history_diff` | `path: String`, `from: Option<String>`, `to: Option<String>` | `FileDiff` |
| `cmd_history_restore` | `path: String`, `commitId: String` | `HistoryRestore` |
| `cmd_history_recent` | `limit: Option<usize>` | `Vec<HistoryActivity>` |
| `cmd_history_set_enabled` | `enabled: bool` | `HistoryStatus` |
| `cmd_history_commit_now` | `path: Option<String>` | `Option<HistoryActivity>` |

#### Home — focus log — `commands/home_commands.rs` (3)

Semantics, validation and events: [`docs/features/home.md`](docs/features/home.md).

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_focus_log_session` | `session: FocusSessionInput` | `FocusSession` |
| `cmd_focus_stats` | `days: u32` | `FocusStats` |
| `cmd_focus_list` | `limit: u32` | `Vec<FocusSession>` |

#### Note tasks — `commands/vaulttasks_commands.rs` (8)

Semantics, validation and events: [`docs/features/vaulttasks.md`](docs/features/vaulttasks.md).

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_vault_tasks_list` | `filter: Option<VaultTaskFilter>` | `Vec<VaultTaskItem>` |
| `cmd_vault_tasks_toggle` | `notePath: String`, `line: usize`, `checked: bool`, `expectedText: String` | `VaultTaskItem` |
| `cmd_vault_tasks_set_status` | `notePath: String`, `line: usize`, `status: VaultTaskStatus`, `expectedText: String` | `VaultTaskItem` |
| `cmd_vault_tasks_set_due` | `notePath: String`, `line: usize`, `due: Option<String>`, `expectedText: String` | `VaultTaskItem` |
| `cmd_vault_tasks_set_priority` | `notePath: String`, `line: usize`, `priority: VaultTaskPriority`, `expectedText: String` | `VaultTaskItem` |
| `cmd_vault_tasks_append` | `notePath: String`, `text: String` | `VaultTaskItem` |
| `cmd_vault_tasks_stats` | — | `VaultTaskStats` |
| `cmd_vault_tasks_rescan` | — | `Vec<VaultTaskItem>` |

#### AI intelligence — compaction, suggestions, approvals — `commands/intel_commands.rs` (17)

Semantics, validation and events: [`docs/features/intel.md`](docs/features/intel.md).

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_intel_get_settings` | — | `IntelSettings` |
| `cmd_intel_set_settings` | `settings: IntelSettings` | `IntelSettings` |
| `cmd_intel_compact` | `messages: Vec<ChatMessageRecord>`, `model: String`, `provider: Option<String>`, `previousSummary: Option<String>`, `keepRecent: Option<usize>` | `CompactionResult` |
| `cmd_intel_save_conversation` | `id: Option<String>`, `messages: Vec<ChatMessageRecord>`, `contextNotes: Vec<String>`, `summary: Option<String>` | `Conversation` |
| `cmd_intel_suggest_related` | `text: String`, `excludePath: Option<String>`, `limit: Option<usize>` | `Vec<Suggestion>` |
| `cmd_intel_suggest_tags` | `text: String`, `limit: Option<usize>`, `model: Option<String>`, `provider: Option<String>` | `Vec<String>` |
| `cmd_intel_add_tag` | `path: String`, `tag: String` | `AddTagResult` |
| `cmd_intel_run_command` | `command: String`, `cwd: Option<String>` | `CommandOutput` |
| `cmd_intel_delete_note` | `path: String` | `TrashedNote` |
| `cmd_intel_move_note` | `from: String`, `to: String` | `MovedNote` |
| `cmd_intel_git_commit` | `projectPath: String`, `message: String` | `GitCommitOutcome` |
| `cmd_intel_create_task` | `projectId: Option<String>`, `title: String`, `description: Option<String>`, `priority: Option<String>`, `dueDate: Option<String>` | `CreatedTask` |
| `cmd_intel_toggle_vault_task` | `notePath: String`, `line: usize` | `ToggledTask` |
| `cmd_intel_preview_action` | `action: AgentAction` | `ActionPreview` |
| `cmd_intel_audit_list` | `limit: Option<usize>` | `Vec<AuditEntry>` |
| `cmd_intel_audit_record` | `action: AgentAction`, `status: AuditStatus`, `detail: Option<String>` | `AuditEntry` |
| `cmd_intel_audit_clear` | — | — |

#### Plugins — `commands/plugins_commands.rs` (17)

Semantics, validation and events: [`docs/features/plugins.md`](docs/features/plugins.md).

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_plugins_list` | — | `Vec<PluginInfo>` |
| `cmd_plugins_install_examples` | — | `Vec<String>` |
| `cmd_plugins_read_source` | `id: String` | `String` |
| `cmd_plugins_set_enabled` | `id: String`, `enabled: bool` | `PluginInfo` |
| `cmd_plugins_set_permissions` | `id: String`, `permissions: Vec<String>` | `PluginInfo` |
| `cmd_plugins_install_from_path` | `path: String` | `PluginInfo` |
| `cmd_plugins_uninstall` | `id: String` | — |
| `cmd_plugins_get_settings` | `id: String` | `Map<String, Value>` |
| `cmd_plugins_set_settings` | `id: String`, `values: Value` | `Map<String, Value>` |
| `cmd_plugins_storage_get` | `id: String`, `key: String` | `Option<Value>` |
| `cmd_plugins_storage_set` | `id: String`, `key: String`, `value: Option<Value>` | — |
| `cmd_plugins_open_folder` | `id: Option<String>` | — |
| `cmd_plugins_vault_list` | `id: String` | `Vec<PluginVaultNote>` |
| `cmd_plugins_vault_read` | `id: String`, `path: String` | `String` |
| `cmd_plugins_vault_write` | `id: String`, `path: String`, `content: String` | — |
| `cmd_plugins_note_create` | `id: String`, `title: String`, `content: String` | `String` |
| `cmd_plugins_fetch` | `id: String`, `url: String` | `PluginFetchResponse` |

#### Export & publishing — `commands/export_commands.rs` (11)

Semantics, validation and events: [`docs/features/export.md`](docs/features/export.md).

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_export_preview_html` | `path: String`, `options: ExportOptions` | `String` |
| `cmd_export_preview_markdown` | `scope: ExportScope`, `path: String`, `options: ExportOptions` | `String` |
| `cmd_export_note_html` | `path: String`, `outPath: String`, `options: ExportOptions` | `NoteExportReport` |
| `cmd_export_print_document` | `path: String`, `options: ExportOptions` | `pdf::PrintDocument` |
| `cmd_export_site` | `scope: ExportScope`, `outDir: String`, `options: ExportOptions` | `SiteReport` |
| `cmd_export_bundle` | `scope: ExportScope`, `outPath: String`, `options: ExportOptions` | `BundleReport` |
| `cmd_export_open_path` | `path: String`, `reveal: bool` | — |
| `cmd_export_list_recent` | — | `Vec<RecentExport>` |
| `cmd_export_clear_recent` | — | — |
| `cmd_export_resolve_scope` | `scope: ExportScope` | `ScopePreview` |
| `cmd_export_list_tags` | — | `Vec<TagCount>` |

#### Sync & backup — `commands/sync_commands.rs` (17)

Semantics, validation and events: [`docs/features/sync.md`](docs/features/sync.md).

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_sync_get_settings` | — | `SyncSettings` |
| `cmd_sync_set_settings` | `patch: SyncSettingsPatch` | `SyncSettings` |
| `cmd_sync_inspect_folder` | `path: String` | `SyncFolderInfo` |
| `cmd_sync_unlock` | `passphrase: String`, `remember: bool` | `SyncStatus` |
| `cmd_sync_lock` | — | `SyncStatus` |
| `cmd_sync_now` | — | `SyncReport` |
| `cmd_sync_status` | — | `SyncStatus` |
| `cmd_sync_list_conflicts` | — | `Vec<SyncConflict>` |
| `cmd_sync_get_conflict` | `id: String` | `SyncConflictDetail` |
| `cmd_sync_resolve_conflict` | `id: String`, `keep: String` | `SyncConflict` |
| `cmd_sync_change_passphrase` | `oldPassphrase: String`, `newPassphrase: String` | `PassphraseChangeReport` |
| `cmd_sync_devices` | — | `Vec<DeviceInfo>` |
| `cmd_sync_backup_create` | `destDir: String`, `includeAppData: bool` | `BackupReport` |
| `cmd_sync_backup_list` | `dir: String` | `Vec<BackupInfo>` |
| `cmd_sync_backup_verify` | `path: String`, `passphrase: String` | `BackupVerifyReport` |
| `cmd_sync_backup_preview` | `path: String`, `passphrase: String` | `BackupPreview` |
| `cmd_sync_backup_restore` | `path: String`, `passphrase: String`, `targetDir: String`, `mode: String` | `RestoreReport` |

#### Onboarding, settings & help — `commands/onboarding_commands.rs` (17)

Semantics, validation and events: [`docs/features/onboarding.md`](docs/features/onboarding.md).

| Command | Arguments | Returns |
| --- | --- | --- |
| `cmd_onboarding_get_state` | — | `OnboardingState` |
| `cmd_onboarding_set_state` | `onboarding: OnboardingState` | `OnboardingState` |
| `cmd_onboarding_create_vault` | `path: String` | `VaultInfo` |
| `cmd_onboarding_detect_vaults` | — | `Vec<VaultInfo>` |
| `cmd_onboarding_suggest_vault_path` | — | `String` |
| `cmd_onboarding_system_profile` | — | `SystemProfile` |
| `cmd_onboarding_pull_model` | `name: String` | `PullOutcome` |
| `cmd_onboarding_cancel_pull` | `name: String` | `bool` |
| `cmd_onboarding_get_vault_prefs` | — | `VaultPrefs` |
| `cmd_onboarding_set_vault_prefs` | `prefs: VaultPrefs` | `VaultPrefs` |
| `cmd_onboarding_get_general_prefs` | — | `GeneralPrefs` |
| `cmd_onboarding_set_general_prefs` | `prefs: GeneralPrefs` | `GeneralPrefs` |
| `cmd_onboarding_reveal_vault` | — | — |
| `cmd_onboarding_data_locations` | — | `Vec<DataLocation>` |
| `cmd_onboarding_read_app_log` | `maxBytes: u64` | `AppLogTail` |
| `cmd_onboarding_read_changelog` | — | `String` |
| `cmd_onboarding_reset_app_data` | `keepVault: bool` | `ResetOutcome` |
<!-- IPC:END -->
