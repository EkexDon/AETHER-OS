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

## Security boundaries

- The UI has no direct filesystem, process, or shell access.
- AETHER-OS is **read-only** on the NoPes vault — it never writes to or modifies NoPes files.
- AI-generated notes are stored in AETHER-OS's own App Data directory, completely separate from the vault.
- Ollama requests are restricted to `localhost:11434`.
- The OpenRouter API key is stored only in the app data directory (`ai_config.json`),
  never in webview localStorage, and is never logged or returned to the UI.
  Cloud requests go exclusively to `https://openrouter.ai`.
- Vectors must be finite and match the dimension already stored in the index; changing the embedding model requires re-indexing.
- Embedding calls support both the current `/api/embed` and legacy `/api/embeddings` endpoints, and report a missing model with the exact `ollama pull` command.
