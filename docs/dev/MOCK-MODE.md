# Mock mode (browser preview)

`npm run dev:mock` starts Vite with `VITE_AETHER_MOCK=1`. Open
<http://127.0.0.1:1420> in any browser and the whole app runs against an
in-memory fake backend: a realistic vault, projects with git history, an IDE
file tree, memory, calendar, tasks, live system metrics, a fake terminal and
a fake streaming LLM. Designers and reviewers can click through every view
without Rust, Ollama or a vault on disk.

> Windows shells do not understand the `VAR=value cmd` prefix. Use
> `set VITE_AETHER_MOCK=1&& npx vite` (cmd) or
> `$env:VITE_AETHER_MOCK=1; npx vite` (PowerShell).

## How it works

```
view ──▶ src/lib/ipc.ts (barrel) ──▶ src/lib/ipc/<domain>.ts ──▶ call() / listenSafe()   (src/lib/ipc/core.ts)
                                                                   │
                           Tauri webview ─────────────────────────┼──▶ invoke / listen  (real Rust backend)
                           dev:mock in a browser ─────────────────┼──▶ mockInvoke / mockEvents (src/lib/mock/backend.ts)
                           plain browser ─────────────────────────┴──▶ IpcUnavailableError / no-op unlisten
```

- `isTauriRuntime()` — the real desktop shell is present.
- `isMockRuntime()` — `import.meta.env.DEV && VITE_AETHER_MOCK === "1" && !isTauriRuntime()`.
- `isDesktopRuntime()` — "a backend can answer": Tauri **or** mock. Views
  that gate backend calls on it (Terminal, System Monitor, Browser) therefore
  work in the preview. Use `isTauriRuntime()` only for things that need the
  real shell (native webviews, file dialogs).
- The mock is loaded with a dynamic `import("../mock/backend")` inside an
  `if (import.meta.env.DEV)` block, so production bundles do not contain it.
  `test_runner.sh` and CI grep `dist/` for a mock-only string to prove it.

`mockInvoke(command, args)` behaves like Tauri IPC: arguments and results are
deep-copied, unit results become `null`, errors reject with the error
*string* (which `call()` turns into an `Error`, exactly as for real Rust
`Err(String)`), and each call takes 8–40 ms. Events go through
`mockEvents.emit/listen`; every `listen()` is its own registration (like
Tauri), so React StrictMode's double effects are safe.

In the browser console, `window.__AETHER_MOCK__` exposes `handlers`,
`events`, `invoke` and `reset()` for manual QA.

## What the mock simulates

| Domain | File | Behaviour |
| --- | --- | --- |
| Vault | `vault.ts`, `vaultStore.ts`, `fixtures/vault.ts` | 33 bilingual notes (PARA folders, `daily/`, frontmatter, `#tags`, a connected `[[wikilink]]` graph, dated tasks, flashcards, a mermaid block, an image reference, a long tutorial). Index, graph, stats and backlinks are computed from live content, so create/write/append/delete stay consistent. `cmd_set_vault_path` moves the demo content to the new path. |
| Notes | `notes.ts` | Create (sanitised, never clobbers), write (vault-scoped), append, backlinks, daily note + timestamped bullets, clipping, vault agent actions with the real status strings. |
| AI | `ai.ts` | `cmd_index_vault` takes ≈1.5 s; semantic search ranks by TF-IDF (cosine-like scores); `cmd_agent_query(_with_notes)` streams a grounded Markdown answer word by word over `llm-stream-chunk` (30 ms/chunk), German when asked in German. Explicit intents ("remember…", "create a note…", "today…") and every third turn add an ```action block. Health: Ollama online, OpenRouter unconfigured until a key is set. |
| AETHER Notes, Memory | `aetherNotes.ts`, `memory.ts` | Seeded CRUD stores; also used by the agent-action router mock. |
| Projects, IDE, Git | `projects.ts`, `ide.ts`, `fsStore.ts`, `git.ts`, `fixtures/workspace.ts` | Four repos under `/Users/demo/Developer`. The IDE sandbox (project dirs + vault) rejects escapes. Git keeps HEAD/index/worktree per repo, so status, stage/unstage/discard, commit, log, branches and diffs follow IDE edits. |
| Terminal | `terminal.ts` | Fake zsh: echo, backspace, Ctrl-C/L, `ls cd pwd cat echo date whoami uname git status history clear exit`; output is base64 over `terminal-output`. |
| System | `system.ts` | Mean-reverting random walks for CPU (8 cores), memory, disks, network, processes, battery. |
| Browser | `browser.ts` | External opens are logged; embedded webviews get labels and emit nav/title events (nothing is rendered). |
| Calendar, Tasks | `calendar.ts`, `tasks.ts` | ≈12 events across the current month, validation as in Rust, ICS export/import; three task projects with a backlog, end-of-column ordering, cascade delete. |
| LSP | `lsp.ts` | `cmd_lsp_start` returns a session key but the server never answers, so Monaco keeps its built-in single-file features. |
| Diagnostics, Updater | `diagnostics.ts`, `updater.ts` | One sample crash report, frontend error log; the update check reports the next minor version after 600 ms. |
| v0.2 features | `clipboard.ts`, `search.ts`, `history.ts`, `home.ts`, `vaulttasks.ts`, `intel.ts`, `plugins.ts`, `export.ts`, `sync.ts`, `onboarding.ts`, `app.ts` | 40 clips with a live feed; a search index over every mock source and 21 fake apps; a five-week note history; 14 days of focus sessions; tasks parsed from the live mock vault; canned compaction, keyword-based related notes and fake `run_command` output; three bundled plugins; simulated exports; two sync devices with one conflict and four backups (passphrases with "wrong" fail); a first-run wizard state kept in `localStorage` (`aether-mock-onboarding`); quit confirmation via `__AETHER_MOCK__.requestQuit()`. Details in each `docs/features/<feature>.md`. |

**Media in the demo vault.** `cmd_read_vault_asset` serves three files —
`attachments/sourdough.jpg` (embedded in *Sauerteigbrot Rezept* as
`![…](attachments/sourdough.jpg)`), `01-Projects/assets/aether-architecture.png`
(*AETHER-OS*, `![[aether-architecture.png|480]]`) and
`attachments/garden-sketch.png` (*Garden Planner App*, `![…](garden-sketch.png)`,
found through the attachment-folder fallback). Whatever the extension, each
is a small PNG landscape generated from its path (`src/lib/mock/png.ts`,
`mockPicture`); other paths fail with the Rust error messages.

**Prompts that trigger agent actions** (`pickAction` in `src/lib/mock/ai.ts`,
English or German): "run `<cmd>`" / "run the tests" → `run_command` in the
demo app (approval, dangerous); "delete … note" → `delete_note` of
*Quick Capture* (approval, dangerous); "move … note" → `move_note` of
*Reading List* to `03-Resources/` (approval, confirm); "remember …" →
`add_memory_fact`; "create a note …" → `create_note`; "daily" / "today" /
"todo" → `append_daily`. Without such a phrase, every third answer appends
to the daily note. The mock LLM emits no `git_commit`, `create_task` or
`toggle_vault_task` blocks; those handlers are exercised by tests.

To take screenshots without the setup wizard, set `localStorage["aether-mock-onboarding"] = '{"completed_at":"2026-01-01T00:00:00Z","version_seen":"<package.json version>","skipped_steps":[]}'` (and `aether-theme` to `light` or `dark`) before the page loads.

Every store registers a reset function; tests call `resetMockState()` and
`setMockLatency(0)` in `beforeEach`.

## Adding handlers for a feature

1. Create `src/lib/mock/<feature>.ts` exporting
   `export const <feature>Handlers: MockHandlerMap = { cmd_…: (args) => … }`.
   Read arguments with the helpers from `./runtime` (`argString`,
   `argOptString`, `argBool`, `argNumber`, `argStringArray`, `argObject`);
   they reject missing keys with Tauri's wording. Top-level args arrive in
   **camelCase** (as the IPC wrapper sends them), nested structs in
   **snake_case**.
2. Keep state in module scope and `registerReset(() => { state = seed(); })`.
3. Emit streaming events with `mockEvents.emit("<event>", payload)`.
4. Add `...<feature>Handlers,` directly above `// @anchor:mock:<feature>` in
   `src/lib/mock/backend.ts`.
5. Throw `Error`s with the same messages the Rust command returns.

## The coverage test

`src/lib/mock/backend.test.ts` parses the `generate_handler![…]` block of
`src-tauri/src/lib.rs` and fails when

- a registered command has no mock handler (you forgot your mock),
- a mock handler exists for a command that is not registered (stale mock), or
- a wrapper in `src/lib/ipc/*.ts` calls a command that is not registered
  (typo in a command name).

So a feature cannot land a Rust command without the matching mock, and the
browser preview never silently breaks.
