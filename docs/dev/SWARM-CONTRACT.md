# AETHER-OS v0.2 — Swarm Contract

This document is the binding contract for every agent working on the v0.2
"boil the ocean" release. Read it fully before touching a file. The
orchestrator (Fable) integrates, reviews and ships; feature agents own
exactly the files listed for them and hook into the shared integration
points described below.

## 0. Ground rules (non-negotiable)

1. **No stubs, no TODOs, no mocks in production paths.** Every function is
   fully implemented, error-handled, tested and documented. `todo!()`,
   `unimplemented!()`, `// TODO`, placeholder UI copy like "Coming soon" are
   forbidden.
2. **Quality gates must be green before you report done:**
   - `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test`
   - `npx tsc --noEmit`
   - `npx vitest run`
   Run them yourself. Report the exact numbers (tests passed) in your final
   message. If a gate is red because of *someone else's* in-flight work,
   say so precisely (file + error) — do not "fix" files you do not own.
3. **File ownership.** You may create/edit only the files in your assignment
   plus the *shared integration points* listed in §3, and only in the manner
   described there (one-line additions at your named anchor). Never
   reformat, reorder or "clean up" shared files. Never touch another
   feature's files. If you truly need a change elsewhere, write it down in
   your final report as an integration request for the orchestrator.
4. **Local-first & security.** The webview has no direct FS/process access.
   All privileged work lives in Rust behind a `#[tauri::command]`. Paths from
   the UI are untrusted: resolve them inside the vault/app-data/project
   roots and reject escapes (see `engine/workspace.rs` for the pattern).
   Network calls only to `localhost` (Ollama) and `https://openrouter.ai`
   unless the feature is explicitly about fetching a user-supplied URL.
5. **Errors.** Rust: `Result<T, AetherError>` in engines, `Result<T, String>`
   at the command boundary via `.map_err(|e| e.to_string())`. Add variants to
   `AetherError` only through the orchestrator. TS: throw `Error` with a
   human-readable message; surface it in the UI (toast or inline), never
   swallow silently except for optional background refreshes.
6. **Docs.** Public Rust items get `///` docs; exported TS gets `/** */`.
   Each feature ships a `docs/features/<feature>.md` (what, why, how to use,
   data location, IPC table) — the orchestrator merges these into README,
   TUTORIAL and ARCHITECTURE.
7. **Tests.** Rust engines: `#[cfg(test)]` with `tempfile` dirs. Frontend:
   Vitest + Testing Library next to the file. Pure logic goes into `src/lib`
   so it is testable without a DOM. Aim for the critical paths, not vanity
   coverage.
8. **Commits.** Do **not** commit. The orchestrator commits at wave
   boundaries.
9. **Language.** Code, identifiers, comments and UI copy are English.
   The orchestrator reports to the user in German.

## 1. Architecture recap

```
React 18 + TS (Vite)  ──typed IPC (src/lib/ipc.ts)──▶  Tauri 2 commands (src-tauri/src/commands/*)
                                                        └─▶ engines (src-tauri/src/engine/*)
                                                             ├─ vault_reader (Markdown vault on disk, read+write)
                                                             ├─ vector_db (JSON vectors, Ollama embeddings)
                                                             ├─ local_ai / cloud_ai (Ollama / OpenRouter streaming)
                                                             ├─ memory_store, aether_notes, task_board, calendar*
                                                             ├─ terminal (portable-pty), system_monitor (sysinfo)
                                                             ├─ git_repo (git2), lsp (sidecars), workspace (sandboxed FS)
                                                             └─ web_clipper (reqwest + scraper)
```

- App data dir (macOS): `~/Library/Application Support/com.ekin.aetheros/`.
  Each engine owns a subfolder (`memory/`, `calendar/`, `tasks/`, …). New
  engines follow the same pattern: `Engine::new(&data_dir.join("<feature>"))`.
- Frontend state: the global `useAetherStore` (`src/lib/store.ts`) is
  **frozen for feature agents**. New features create their own zustand store
  `src/lib/<feature>Store.ts` (precedent: `ideStore.ts`).
- Streaming: Tauri events (`app.emit("<event-name>", payload)`), listened via
  helpers in `src/lib/ipc/<feature>.ts` using `listen()` from
  `@tauri-apps/api/event` wrapped so that the browser preview (mock mode)
  does not crash.
- Styling: CSS with design tokens (no Tailwind). See §4.

## 2. Waves

| Wave | Who | Scope |
| --- | --- | --- |
| 1 | `design-foundation`, `infra` | Design system (tokens, primitives, shell, theme), CSS split; IPC/types split, mock backend for browser preview, CI, crash reporting, anchors |
| 2 | feature agents (parallel) | Clipboard, Launcher+Universal Search, Note history, Home+Pins+Focus, Vault tasks, AI intelligence + approvals, Plugins, Export/Publish, Backup/Sync, Onboarding+Settings |
| 3 | `integrator`, `qa-design`, `docs` | Wire cross-feature settings, full QA in mock + desktop, design review, docs, changelog |

## 3. Shared integration points (append-only, at your anchor)

After Wave 1 the following files contain named anchor comments. Add your
lines **directly above your own anchor** and nowhere else.

| File | Anchor pattern | What you add |
| --- | --- | --- |
| `src-tauri/src/engine/mod.rs` | `// @anchor:engine:<feature>` | `pub mod <feature>;` |
| `src-tauri/src/commands/mod.rs` | `// @anchor:commands:<feature>` | `pub mod <feature>_commands;` |
| `src-tauri/src/lib.rs` (AppState fields) | `// @anchor:state-field:<feature>` | `pub <feature>: Arc<...>,` |
| `src-tauri/src/lib.rs` (setup) | `// @anchor:state-init:<feature>` | construction + field in `app.manage(AppState { … })` (two anchors: `state-init` and `state-manage`) |
| `src-tauri/src/lib.rs` (handlers) | `// @anchor:handlers:<feature>` | `commands::<feature>_commands::cmd_…,` lines |
| `src/types/index.ts` | `// @anchor:types:<feature>` | `export * from "./<feature>";` (your types live in `src/types/<feature>.ts`) |
| `src/lib/ipc.ts` | `// @anchor:ipc:<feature>` | `export * from "./ipc/<feature>";` (your wrappers live in `src/lib/ipc/<feature>.ts`, using `call`/`listenSafe` from `./ipc/core`) |
| `src/lib/mock/backend.ts` | `// @anchor:mock:<feature>` | `...<feature>Handlers,` (your mock handlers live in `src/lib/mock/<feature>.ts`) |
| `src/views/registry.tsx` | `// @anchor:view:<feature>` | one `ViewDefinition` entry (see §5) |
| `src/lib/commands/registry.ts` | `// @anchor:command:<feature>` | command palette contributions (see §5) |
| `src/settings/registry.tsx` | `// @anchor:settings:<feature>` | a settings section (see §5) |
| `src/shell/FeatureHosts.tsx` | `FEATURE_HOSTS` list | one `{ id: "<feature>.<name>", component }` for an always-mounted host (overlays, start-up work, event subscriptions) — not an invisible status bar item |
| `src/styles/index.css` | "Feature views" block | `@import "./views/<feature>.css";` |
| `src-tauri/Cargo.toml` | `# @anchor:deps:<feature>` | your crate dependencies |
| `package.json` | (ask orchestrator) | npm deps: run `npm i <pkg>` yourself, it edits package.json/lock atomically; mention it in the report |

Feature keys (use exactly these): `clipboard`, `search` (launcher + universal
search), `history` (note versioning), `home` (dashboard, pins, focus),
`vaulttasks`, `intel` (compaction, suggestions, approvals), `plugins`,
`export`, `sync`, `onboarding`.

Every feature gets its own:

- `src-tauri/src/engine/<feature>.rs` (+ optional submodule dir)
- `src-tauri/src/commands/<feature>_commands.rs`
- `src/types/<feature>.ts`, `src/lib/ipc/<feature>.ts`, `src/lib/mock/<feature>.ts`
- `src/lib/<feature>Store.ts` (if state is needed) and pure helpers `src/lib/<feature>/*.ts`
- `src/components/<feature>/*.tsx` (+ `.test.tsx`)
- `src/styles/views/<feature>.css`, imported once from `src/styles/index.css` (one `@import` line in the "Feature views" block; components never import CSS)
- `docs/features/<feature>.md`

## 4. Design system (Wave 1 output — features MUST use it)

- Tokens live in `src/styles/tokens.css` (`--color-*`, `--space-*`, `--radius-*`,
  `--shadow-*`, `--font-*`, `--z-*`, `--motion-*`). Light and dark themes are
  driven by `data-theme` on `<html>`; never hardcode colors, use tokens.
- Primitives live in `src/ui/` and are the only way to render common
  controls: `Button`, `IconButton`, `Input`, `Textarea`, `Select`, `Switch`,
  `Checkbox`, `Badge`, `Card`, `Tabs`, `Modal`, `Popover`, `Tooltip`, `Kbd`,
  `EmptyState`, `Spinner`, `Toast` (`useToast()`), `SegmentedControl`,
  `ViewHeader` (title + subtitle + actions row every view starts with),
  `ListRow`, `SearchField`. Read `src/ui/README.md` for props and examples.
- Icons: `lucide-react`, sizes 14/16/18 only.
- Every view: `ViewHeader` on top, content in a scroll container, an
  `EmptyState` when there is nothing, inline error via `Toast`.
- Keyboard-first: every primary action has a shortcut listed in the
  command registry so it shows up in the launcher and the shortcuts overlay.
- Respect the frontend design rules: no blue→purple gradients, no pure
  black/white, contextual radii (badge 4 / button 8 / card 12 / modal 16),
  multi-layer shadows, explicit `transition` properties (never `all`).

## 5. Frontend registries

```ts
// src/views/registry.tsx
export interface ViewDefinition {
  mode: ViewMode;             // string literal, add yours to ViewMode in src/views/modes.ts
  label: string;
  icon: LucideIcon;
  group: "knowledge" | "build" | "system" | "life";
  shortcut?: string;          // e.g. "mod+1"
  component: React.LazyExoticComponent<React.ComponentType> | React.ComponentType;
  keepAlive?: boolean;        // render hidden instead of unmounting (terminal)
  hidesVaultSidebar?: boolean;
}

// src/lib/commands/registry.ts
export interface CommandContribution {
  id: string;                 // "<feature>.<verb>"
  title: string;
  group: string;              // shown as section label
  icon?: LucideIcon;
  shortcut?: string;
  keywords?: string[];
  run: (ctx: CommandContext) => void | Promise<void>;
  when?: (ctx: CommandContext) => boolean;
}

// src/settings/registry.tsx
export interface SettingsSection {
  id: string;                 // "<feature>"
  title: string;
  icon: LucideIcon;
  order: number;
  component: React.ComponentType;
}
```

## 6. Mock mode (browser preview)

`npm run dev:mock` starts Vite with `VITE_AETHER_MOCK=1`. In that mode
`call()` routes to `src/lib/mock/backend.ts`, which serves a realistic fake
vault, projects, memory, calendar, tasks, metrics and a fake streaming LLM.
Every feature adds mock handlers for **all** of its commands so the whole app
can be exercised and screenshotted in a normal browser. The mock is
`import.meta.env.DEV`-only and tree-shaken from production builds.

## 7. Reporting format (final message of every agent)

```
## <feature> — done
Files: <list>
Gates: cargo test <n> passed · clippy clean · tsc clean · vitest <n> passed
Integration requests: <none | precise list>
Known limitations: <none | precise list>
Docs: docs/features/<feature>.md
```

## 8. Outcome (v0.2.0, 2026-09-23)

The sections above stay the contract for future waves. What v0.2 produced:

| | Wave 1 | Wave 2 | Wave 3 |
| --- | --- | --- | --- |
| Scope | design system, shell, registries + anchors, IPC/type split, mock backend, diagnostics, update check, SQLite helper, CI + release workflows | the ten features of §3 (`clipboard`, `search`, `history`, `home`, `vaulttasks`, `intel`, `plugins`, `export`, `sync`, `onboarding`) | integration (cross-feature settings, quit confirmation, editor properties, fixes), QA, docs |
| Commit | `5172ea1` | `2836438` | by the orchestrator |

Counts at release (from the sources, not estimates):

- **19 workspaces** in 4 rail groups (Knowledge 8 · Build 3 · Life 3 · System 5), 15 settings sections, 85 built-in palette commands (58 keyboard shortcuts incl. editor-local ones).
- **237 Tauri commands** in 28 command modules over 34 engine modules; every command has a mock handler (enforced by `src/lib/mock/backend.test.ts`).
- **671 Rust tests** (`cargo test`) and **1,133 Vitest tests** in 148 files; `cargo fmt --check`, `clippy -D warnings` and `tsc --noEmit` clean (test counts taken at 09:50, lint and type checks at 08:55, end of Wave 3a).
- Docs: ten `docs/features/*.md`, `docs/PLUGIN-API.md`, `docs/dev/{DESIGN-SYSTEM,MOCK-MODE,CI,RELEASING}.md`; README, TUTORIAL (32 screenshots from mock mode), ARCHITECTURE and CHANGELOG rewritten for 0.2.0.

Cross-feature wiring that a feature could not do inside its own files was listed under *Limitations* in its feature doc and landed in the Wave 3 integration pass: pins in the vault sidebar, the editor scrolling to a note task's line, daily-note preferences honoured by the vault reader, a configurable embedding model and the quit confirmation with running terminals. The same pass added the editor's Properties panel, which also stops the editor from rewriting YAML front matter. Keep that pattern for future waves: record the request in the feature doc, and let an integration wave own the shared files. Always-mounted hosts go into `src/shell/FeatureHosts.tsx`, feature stylesheets into `src/styles/index.css` (see §3).
