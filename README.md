# AETHER-OS

> **A local-first personal operating system for your thoughts, your projects and your AI.** Notes, search, tasks, calendar, IDE, terminal, clipboard, sync and a multi-provider AI agent — one keyboard-first app, on your machine, private by default.

![AETHER-OS — knowledge graph, grouped navigation and the AI agent answering from the vault](docs/tutorial/images/00-hero.png)

`v0.2.0` · Tauri 2 + React 18 + Rust · 19 workspaces in 4 groups · 237 IPC commands · 693 Rust tests · 1,435 Vitest tests

---

## What is this?

AETHER-OS is what you would get if **Obsidian**, **Raycast**, **VS Code**, **Warp**, **Things**, **Paste**, **Time Machine** and a **chat-with-your-notes AI** were designed as one product. Your notes stay plain Markdown files in a folder you choose; everything else lives in the app's data folder on this machine. Nothing leaves it unless you pick a cloud model or publish something yourself.

### Workspaces

Nineteen views, grouped in the navigation rail. ⌘1–⌘9 jump to the first nine; every view is also reachable from the launcher (⌘K → "Go to …").

| Group | Workspace | Shortcut | What it does |
| --- | --- | --- | --- |
| Knowledge | **Home** | ⌘1 | Today (daily note, events, due tasks), continue where you left off, pins, Pomodoro and focus stats, vault health |
| | **Notes** | ⌘2 | Tabbed WYSIWYG Markdown editor with `[[` note autocomplete, clickable wikilinks, a Properties panel for YAML front matter, vault images, backlinks, unlinked mentions, related-note suggestions and per-note history |
| | **Search** | ⌘3 · ⌘⇧K | Universal Search: notes, files, apps, events, tasks, memory and chats, keyword + fuzzy + semantic ranking, preview pane |
| | **Graph** | ⌘4 | Force-directed graph of every wikilink, filterable by tag |
| | **AI Notes** | ⌘5 | Library of agent answers you saved |
| | **Memory** | ⌘6 | Facts the agent always knows about you |
| | **History** | ⇧⌘H (note) | Every version of every note — automatic Git snapshots, diffs, one-click restore |
| | **Export** | ⇧⌘E · ⌥⌘W | Standalone HTML, print to PDF, a static website, a Markdown bundle |
| Build | **IDE** | ⌘7 | Monaco editor with file tree, Git source control, LSP and an embedded terminal |
| | **Projects** | ⌘8 | Every Git repository in your project folders with live status |
| | **Terminal** | ⌘9 | Multi-tab PTY shell (`portable-pty` + xterm.js); quitting asks while sessions are running |
| Life | **Calendar** | — | Month / week / day, reminders, ICS import and export |
| | **Tasks** | — | Project boards (Kanban + list) with priorities, labels, checklists |
| | **Note Tasks** | ⌥⌘C | Every `- [ ]` checkbox from every note as board / list / by-note, written back to the Markdown |
| System | **Monitor** | — | CPU, memory, disks, network, battery, top processes |
| | **Browser** | — | Native embedded webviews with tabs and bookmarks |
| | **Clipboard** | ⇧⌘V | System-wide clipboard history: search, filter by kind, pin, save as note, secret filter |
| | **Plugins** | ⌥⇧⌘I (install) | Sandboxed Web Worker plugins with explicit permissions; three bundled examples |
| | **Sync & Backup** | ⌥⌘Y (sync) | End-to-end encrypted folder sync between devices and encrypted, verifiable backups |

### Available everywhere

- **Launcher** — ⌘K inside the app, **⌥Space system-wide** (configurable). Commands, notes, projects, files, apps, events, tasks, memory, chats, bookmarks and clips in one list. Prefixes: `>` commands, `#` tags, `/` files, `@` people & memory, `?` help. ⌘P = go to file, ⇧⌘P = run a command.
- **AI agent panel** — ⌘J. Streaming chat grounded in your notes.
- **Quick Capture** — ⇧⌘N appends a timestamped line to today's daily note (folder and file-name pattern, incl. sub-folders like `YYYY/MM/YYYY-MM-DD`, set in Settings → Vault).
- **Web Clipper** — ⇧⌘C turns a URL into a clean Markdown note (pages up to 10 MB).
- **Focus mode & Pomodoro** — ⇧⌘F hides the chrome, ⌥⌘T starts/pauses the timer in the status bar; minutes and streaks are logged locally.
- **Pins** — ⇧⌘D pins the open note; pins (notes, projects, commands, chats, links in named groups) show at the top of the vault sidebar, on Home and in the pins drawer (⌥⌘B).
- **Settings** — ⌘, opens a modal with 15 sections; **Shortcuts overlay** — ⌘/.

---

## Design

![Home in the light theme](docs/tutorial/images/02-home-light.png)

- **Light and dark themes** (⇧⌘L toggles, or follow the system), four accents (Teal, Ember, Cobalt, Graphite), comfortable or compact density — Settings → Appearance.
- **One token-based design system** (`src/styles/tokens.css`, primitives in `src/ui/`): warm graphite surfaces, one quiet accent, IBM Plex Sans + JetBrains Mono bundled locally. Details: [`docs/dev/DESIGN-SYSTEM.md`](docs/dev/DESIGN-SYSTEM.md).
- **Keyboard-first**: every primary action is a command with a shortcut, so it shows up in the launcher, the shortcuts overlay (⌘/) and Settings → Shortcuts (searchable, exportable as a Markdown cheat sheet).
- **Shell**: titlebar with the command pill, a grouped navigation rail (⌘\ shows labels), a status bar with vault, index, providers, clipboard, history, tasks, sync, focus and pins.

---

## AI

- **Providers**: **Ollama** on `localhost:11434` (default, fully local) or **OpenRouter** (Claude, GPT, Gemini, Qwen, Llama …). The OpenRouter key is stored in the app data folder, never in the webview or the vault.
- **Grounded answers**: the agent sees all notes, a picked subset, or the open note plus its related notes; your memory facts are always included. Semantic search uses embeddings from Ollama — `nomic-embed-text` by default, any Ollama model in Settings → AI Providers (switching clears the vector index; re-index afterwards).
- **Agent actions**: the model can create and append notes, write to the daily note, remember facts, save answers, open and clip URLs, create calendar events and tasks (safe — run automatically), and **move notes, commit in a project, toggle a note task, update events** (confirm) or **run a shell command, delete a note, delete an event** (dangerous). Confirm and dangerous actions stop at an **approval dialog** with a resolved preview and warnings; every executed or denied action goes to a local audit log (Settings → AI Intelligence). Deleted notes go to `<vault>/.trash/`, never away.
- **Conversation compaction**: long chats are summarised (topic, facts, decisions, open questions, preferences) once they pass a token threshold, with a local extractive fallback when the model is offline. The token meter in the engine bar shows the window size.
- **Related notes and tags**: while you write, the status bar shows "N related"; ⇧⌘R opens a drawer with semantic or keyword matches, one-click `[[links]]` and tag chips.
- **Guidance**: the first-run wizard recommends a model for your RAM and downloads it with progress; "Ollama offline · fix" in the status bar opens copyable install/start commands.

## Plugins

Plugins are a folder with `manifest.json` and one ES module that runs in **its own Web Worker** — no DOM, no IPC, no network or storage of its own. It gets only the permissions its manifest requests *and* you grant (read/write notes, create notes, commands, a panel, a status bar item, AI queries, clipboard, HTTPS GET to named hosts), enforced in the webview host and again in Rust. Word Count, Daily Review and Random Note ship as examples. Author guide: [`docs/PLUGIN-API.md`](docs/PLUGIN-API.md).

## Sync & Backup

- **Folder sync, no relay, no account.** Point every device at a folder you already sync (iCloud Drive, Dropbox, Syncthing, a NAS, a USB stick). AETHER-OS writes only encrypted, content-addressed blobs there: Argon2id key derivation from your passphrase, AES-256-GCM per object, keyed BLAKE3 names — the sync tool never sees a file name or content. The vault and, optionally, app data (memory, calendar, tasks, AI notes) are synced every minute (configurable); concurrent edits become conflict copies you resolve side by side. There is no relay server and no mobile client; the on-disk format is documented for one.
- **Backups**: `.aetherbak` archives (encrypted, self-contained, verifiable), manual or scheduled with retention; restore as merge or replace (the old folder is renamed, never deleted).
- There is no passphrase reset. Details and the full threat model: [`docs/features/sync.md`](docs/features/sync.md).

## Export

Single note → standalone HTML (inlined styles and images, highlighted code) or PDF via the system print dialog; a folder, tag, selection or the whole vault → a static site (index, backlinks, tag pages, client-side search, light/dark, sitemap, CNAME) or a Markdown bundle (`.zip`, wikilinks optionally converted). Everything is written locally; raw HTML is sanitised. Details: [`docs/features/export.md`](docs/features/export.md).

---

## Download / Install

Starting with v0.2.0, ready-to-run installers are attached to every **[GitHub release](https://github.com/EkexDon/AETHER-OS/releases/latest)** — no Rust, Node.js or Ollama needed:

| System | File |
| --- | --- |
| macOS 12+ — Apple Silicon and Intel (universal) | `AETHER-OS_<version>_universal.dmg` |
| Windows 10 / 11 (x64) | `AETHER-OS_<version>_x64-setup.exe` (per user, no admin) or `…_x64_en-US.msi` |
| Linux x64 | `AETHER-OS_<version>_amd64.AppImage`, `…_amd64.deb` (Debian/Ubuntu), `AETHER-OS-<version>-1.x86_64.rpm` (Fedora/openSUSE) |

Each release also has a `SHA256SUMS.txt`. The builds are not signed with paid Apple/Microsoft certificates, so the first start needs one extra click: **macOS** — System Settings → Privacy & Security → *Open Anyway* (macOS 12–14: right-click → *Open*), or `xattr -cr /Applications/AETHER-OS.app`; **Windows** — SmartScreen → *More info* → *Run anyway*; **Linux** — `chmod +x` the AppImage. Step-by-step instructions, the optional Ollama setup, where data lives per OS and how to uninstall: **[`docs/INSTALL.md`](docs/INSTALL.md)**.

---

## Quick start

### Prerequisites

1. **Rust** (stable) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
2. **Node.js 20+** — `brew install node` (CI uses Node 22)
3. **Ollama** (optional, for local AI) — `brew install ollama`

### Install and run

```bash
git clone https://github.com/EkexDon/AETHER-OS.git
cd AETHER-OS
npm install
npx tauri icon src-tauri/icons/icon.svg   # once after a fresh clone (icons are generated)
npm run app                               # tauri dev: Vite + the Rust shell
```

On first launch the **setup wizard** walks you through: connect or create a vault → check Ollama and download a recommended model (or paste an OpenRouter key) → download `nomic-embed-text` and index the vault → a six-card tour of the key shortcuts. Every step can be skipped and re-run later (⌘K → "Help: run setup again").

### Browser preview (no Rust, no Ollama)

```bash
npm run dev:mock    # http://127.0.0.1:1420
```

The whole app runs against an in-memory mock backend with a demo vault, projects, calendar, tasks, clipboard, sync devices and a fake streaming LLM — every IPC command has a mock handler. All screenshots in this repo come from it. See [`docs/dev/MOCK-MODE.md`](docs/dev/MOCK-MODE.md).

### Quality gates

```bash
npm run check       # cargo fmt --check → clippy -D warnings → cargo test → tsc → vitest → vite build → mock-free bundle check
```

CI runs the same gates on every push ([`docs/dev/CI.md`](docs/dev/CI.md)); tagged releases build unsigned macOS, Linux and Windows bundles ([`docs/dev/RELEASING.md`](docs/dev/RELEASING.md)).

---

## Tutorial

[`docs/TUTORIAL.md`](docs/TUTORIAL.md) walks through every workspace and utility with a screenshot: what it is, why it exists, how to use it, and the shortcuts.

---

## Tests

| Suite | Command | Count (v0.2.0) |
| --- | --- | --- |
| Rust (engines + commands, `tempfile` sandboxes, crypto test vectors) | `cd src-tauri && cargo test` | 693 passed |
| Frontend (Vitest + Testing Library, 153 files) | `npx vitest run` | 1,435 passed |

Parity tests keep the mock backend in sync with `generate_handler!` in `src-tauri/src/lib.rs` (a command without a mock fails the build) and the Rust and TypeScript note-task parsers in sync through a shared golden fixture.

---

## Architecture

| Layer | Technology | Where |
| --- | --- | --- |
| Desktop shell | Tauri 2 (multi-webview, `unstable`) | `src-tauri/` |
| Frontend | React 18 + TypeScript + Vite 6 | `src/` |
| Design system | CSS tokens + 22 primitives, light/dark | `src/styles/`, `src/ui/` |
| Shell & registries | views, commands, settings, status bar with anchors | `src/shell/`, `src/views/registry.tsx`, `src/lib/commands/registry.ts`, `src/settings/registry.tsx` |
| State | Zustand (one global store + one store per feature) | `src/lib/store.ts`, `src/lib/*Store.ts` |
| Typed IPC | `call()` / `listenSafe()` wrappers per domain; mock backend in DEV | `src/lib/ipc/`, `src/lib/mock/` |
| Note editor | TipTap (ProseMirror) + `tiptap-markdown` | `src/components/NoteEditor.tsx` |
| IDE | Monaco (bundled), LSP sidecars, `git2` | `src/components/IdeView.tsx`, `engine/lsp.rs`, `engine/git_repo.rs` |
| Terminal | `portable-pty` + xterm.js | `engine/terminal.rs`, `src/components/Terminal.tsx` |
| AI | Ollama / OpenRouter over `reqwest` streaming; JSON vector index | `engine/local_ai.rs`, `engine/cloud_ai.rs`, `engine/vector_db.rs`, `engine/intel/` |
| Search | SQLite FTS5 (bm25) + fuzzy + semantic, reciprocal-rank fusion, frecency | `engine/search_index.rs` |
| Clipboard | `arboard` polling → SQLite + FTS5 | `engine/clipboard.rs` |
| History | `notify` watcher → `git2` commits in `<vault>/.git` | `engine/note_history.rs` |
| Sync & backup | Argon2id, AES-256-GCM, BLAKE3, `zeroize` | `engine/sync/` |
| Export | `pulldown-cmark` + `syntect`, `zip` | `engine/export/` |
| Plugins | Web Workers + typed RPC, manifest validation in Rust | `src/lib/plugins/`, `engine/plugins.rs` |
| Diagnostics | panic hook, error boundaries, rotating log, GitHub release check | `engine/diagnostics.rs`, `engine/updater.rs` |

The backend registers **237 Tauri commands** in 28 command modules over 34 engine modules. Full component diagram, IPC tables per domain, the anchor mechanism and the security model: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Where your data lives

`<app data>` = `~/Library/Application Support/com.ekin.aetheros/` on macOS.

| Data | Location |
| --- | --- |
| **Your notes** (vault) | the folder you choose — plain `.md` files |
| Note versions | `<vault>/.git` (a normal Git repository; `.gitignore` written for new repos) |
| Trashed notes (agent deletes, sync deletes) | `<vault>/.trash/` |
| Vault connection | `<app data>/config.json` |
| Project folders | `<app data>/project_dirs.json` |
| AI provider settings, OpenRouter key | `<app data>/ai/ai_config.json` |
| Vector embeddings | `<app data>/vectors/` |
| Memory facts, chat sessions + summaries | `<app data>/memory/facts.json`, `memory/conversations/` |
| AI Notes | `<app data>/aether/notes/` |
| Agent settings, audit log | `<app data>/intel/settings.json`, `intel/audit.jsonl` |
| Calendar, reminders | `<app data>/calendar/` |
| Task boards | `<app data>/tasks/` |
| Note-task parse cache | `<app data>/vaulttasks/cache.json` |
| Focus sessions | `<app data>/focus/sessions.jsonl` |
| Clipboard history | `<app data>/clipboard/` (`history.db`, `images/`, `settings.json`) |
| Search index, recents | `<app data>/search/` (`index.db`, `recents.json`, `settings.json`) |
| History setting | `<app data>/history/settings.json` |
| Plugins | `<app data>/plugins/` (packages, `.data/<id>/`, `state.json`) |
| Recent exports | `<app data>/export/recents.json` |
| Sync state (+ `key.bin` only with "remember on this device") | `<app data>/sync/` |
| Setup state, daily-note and general preferences | `<app data>/onboarding.json`, `vault_prefs.json`, `general_prefs.json` |
| Log, crash reports | `<app data>/logs/aether.log`, `crash-reports/` |
| UI preferences (theme, accent, pins, layout) | webview `localStorage` (`aether-*` keys) |

Settings → Data & Privacy lists these with sizes and can reset app data (the folder is moved aside, never deleted; the vault is never touched).

**Media in notes:** `![alt](path)` and `![[file.png|300]]` images show in the editor; the rendered previews (Search, AI Notes, exports) also play video, audio and PDF and understand `![[file.png|300]]`. Paths resolve relative to the note, the vault root, or `attachments/` / `assets/` folders, and the files are read through Rust from inside the vault. Web images in AI answers and plugin panels load only when you click them.

**Privacy:** outbound requests go only to `localhost:11434` (Ollama), `https://openrouter.ai` (when you use a cloud model), `https://api.github.com/repos/EkexDon/AETHER-OS/releases/latest` (update check), URLs you clip or open, and HTTPS hosts a plugin was granted. No telemetry; crash reports stay local.

---

## Contributing

The codebase is built so features can be added without editing each other's files. To add a feature `<feature>`:

1. **Rust** — engine in `src-tauri/src/engine/<feature>.rs` (`Result<T, AetherError>`, `#[cfg(test)]` with `tempfile`), commands in `src-tauri/src/commands/<feature>_commands.rs` (`Result<T, String>`), and one line each at the `@anchor:*:<feature>` comments in `engine/mod.rs`, `commands/mod.rs` and `lib.rs` (state field, init, manage, handlers). Resolve every UI path inside the vault / project / data roots and reject escapes.
2. **Types & IPC** — `src/types/<feature>.ts` and `src/lib/ipc/<feature>.ts` (wrappers over `call` / `listenSafe`), exported from `src/types/index.ts` and `src/lib/ipc.ts` at their anchors.
3. **Mock** — `src/lib/mock/<feature>.ts` with a handler for **every** command, registered in `src/lib/mock/backend.ts`. `backend.test.ts` fails otherwise.
4. **UI** — a view in `src/views/registry.tsx` (+ its mode in `src/views/modes.ts`), commands with shortcuts in `src/lib/commands/registry.ts`, a settings section in `src/settings/registry.tsx`, status items in `src/shell/statusbar/registry.ts`. Use the primitives from `src/ui/` and tokens only.
5. **Tests & docs** — Vitest next to the file, pure logic in `src/lib/<feature>/`; a `docs/features/<feature>.md` (what, why, how, data location, IPC table); run `npm run check`.

The binding rules are in [`docs/dev/SWARM-CONTRACT.md`](docs/dev/SWARM-CONTRACT.md); UI recipes in [`docs/dev/DESIGN-SYSTEM.md`](docs/dev/DESIGN-SYSTEM.md).

---

## License

Private project. Not yet open-sourced.
