# Plugins

Sandboxed, permission-scoped plugins that extend AETHER-OS without changing
its code (roadmap 5.1). Plugin authors: see [`docs/PLUGIN-API.md`](../PLUGIN-API.md).

## What

- A plugin is a folder with `manifest.json` and one plain-JavaScript ES
  module. It runs in its **own Web Worker** — no DOM, no Tauri IPC, no
  network or browser storage — and talks to the app over a typed RPC.
- It gets only the capabilities its manifest requests **and the user
  grants**: reading or writing notes, creating notes, commands, a side
  panel, a status bar item, AI queries, the clipboard, HTTPS requests to
  named hosts.
- UI contributions are declarative: palette commands (group "Plugins"), a
  panel rendered from a validated JSON view tree or sanitized Markdown, a
  status bar text, toasts.
- Three real example plugins ship with the app: **Word Count**, **Daily
  Review** and **Random Note**.

## Why

People want their own small automations (a word counter, a daily ritual, a
link fetcher) without forking the app or trusting arbitrary code with their
vault and API keys. The worker sandbox plus explicit permissions make a
plugin's reach visible and revocable, and double enforcement (webview host
*and* Rust) means a bug in one layer cannot widen it.

## How to use

Open **Plugins** from the rail (System group) or the palette ("Go to
Plugins").

| Action | How |
| --- | --- |
| Install a plugin | **Install plugin** (⌥⇧⌘I) → choose a folder or `.zip` (or paste a path) → **Install**. Installing the same id again updates it. |
| Enable / disable | The switch on the plugin card. The first enable opens the permission review. |
| Review permissions | **Permissions** on the card: one switch per requested permission with a plain-language description and risk label. |
| Change settings | **Settings** on the card (form generated from the manifest; values are validated). |
| Use a plugin's panel | The **Plugin panels** card (tabs when several plugins have one), or click the plugin's status bar item. |
| Run a plugin command | ⌘K → group **Plugins**, its own shortcut, or the ▶ button in the card's command list. |
| Reload all plugins | **Reload** in the header or "Reload plugins" (⌥⇧⌘R). |
| Open the plugins folder | **Open folder** in the header, "Open plugins folder" in the palette, or the folder icon on a card. |
| Uninstall | Trash icon on the card → confirm. Settings and plugin storage are deleted; notes are untouched. |

Plugin cards show the live status (*Running*, *Starting…*, *Failed* with the
activation error and **Retry**, *Disabled*, *Broken* for an invalid
package), granted vs. not granted permission chips, registered commands
and the last warning/error the plugin reported.

### Bundled examples

| Plugin | What it does | Permissions |
| --- | --- | --- |
| Word Count | Word count + reading time of the open note in the status bar; per-heading breakdown in its panel. Settings: reading speed, show characters. | `vault:read`, `ui:statusbar`, `ui:panel` |
| Daily Review | Command **Daily review**: asks the AI to summarise today's daily note (`daily/YYYY-MM-DD.md`) and writes it under `## Review` (replacing an older review), then opens the note. Settings: folder, style, open afterwards. | `vault:read`, `vault:write`, `ai:query`, `ui:commands` |
| Random Note | Command **Open random note** (⌥⇧⌘O), skipping folders from its settings. | `vault:read`, `ui:commands` |

They are copied into the plugins folder on first start, disabled. An
uninstalled example is not reinstalled.

## Where data lives

```
<app data>/plugins/                     (macOS: ~/Library/Application Support/com.ekin.aetheros/plugins)
├── <id>/                               plugin package (manifest.json, main.js, …) — replaced on update
├── .data/<id>/settings.json            values of the manifest settings
├── .data/<id>/storage.json             plugin key/value storage (1 MB cap)
├── .staging/                           scratch space for installs (emptied on start)
└── state.json                          enabled flags, granted permissions, seeded examples
```

Nothing is stored in the vault except what a plugin writes through
`vault:write` / `notes:create`.

## Architecture

```
PluginsView / PluginStatusItems ──usePluginHostBootstrap()──▶ PluginHost (src/lib/plugins/host.ts)
      │                                                         │  one Worker per enabled plugin
      ▼                                                         ▼
usePluginsStore (list, runtime, panels, status, commands)   hardened bootstrap (bootstrap.ts + workerRuntime.js)
      │                                                         │  typed RPC (protocol.ts, api.ts)
      ▼                                                         ▼
ipc/plugins.ts ──▶ commands/plugins_commands.rs ──▶ engine/plugins.rs (manifest validation, install, state,
                                                                      settings, storage, capability checks)
```

- **Host** (`src/lib/plugins/host.ts`): reconciles running workers with the
  store (start enabled plugins, stop disabled ones, restart on code/grant
  changes, do not retry a failed activation until **Retry**), validates and
  permission-checks every call, maps them to Rust commands, registers
  commands (`plugin:<id>:<cmd>`, shortcut collisions refused), forwards
  `note:opened` / `note:saved` / `panel:action` / `settings:changed`.
- **Bootstrap** (`bootstrap.ts`): deletes and locks network, storage,
  worker and notification APIs before the plugin loads; installs a
  host-routed `fetch` shim only for `net:fetch:<host>` grants.
- **Protocol** (`protocol.ts`): request/response with ids and timeouts
  (10 s default; AI 180 s, fetch 30 s, commands 180 s), events, logs,
  strict message parsing, plain-data enforcement.
- **Panels** (`viewTree.ts`, `PluginPanel.tsx`): node types `text`,
  `heading`, `list`, `button`, `badge`, `divider`, `markdown`; unknown
  types/fields are rejected; strings render as React text; Markdown goes
  through `MarkdownRenderer` after images and mermaid are neutralised.
- **Rust** (`engine/plugins.rs`): strict manifest validation (id pattern,
  SemVer, known permissions, host rules, `main` inside the folder, 2 MB
  cap, settings schema, unknown fields), folder/zip install with traversal,
  symlink and size protection, capability checks on vault, notes and fetch
  operations.

## IPC

| Command | Arguments | Returns | Notes |
| --- | --- | --- | --- |
| `cmd_plugins_list` | — | `PluginInfo[]` | Valid and broken packages, sorted by name. |
| `cmd_plugins_install_examples` | — | `string[]` | Ids installed now (idempotent). |
| `cmd_plugins_read_source` | `id` | `string` | Enabled plugins only. |
| `cmd_plugins_set_enabled` | `id, enabled` | `PluginInfo` | Only valid packages can be enabled. |
| `cmd_plugins_set_permissions` | `id, permissions` | `PluginInfo` | Must be a subset of the manifest's. |
| `cmd_plugins_install_from_path` | `path` | `PluginInfo` | Absolute folder or `.zip`; validates before replacing. |
| `cmd_plugins_uninstall` | `id` | — | Removes package, settings, storage, state. |
| `cmd_plugins_get_settings` | `id` | `{ key: value }` | Stored values over manifest defaults. |
| `cmd_plugins_set_settings` | `id, values` | `{ key: value }` | Validated against the manifest. |
| `cmd_plugins_storage_get` | `id, key` | `JSON \| null` | Enabled plugins only. |
| `cmd_plugins_storage_set` | `id, key, value` | — | `null` deletes; 1 MB cap. |
| `cmd_plugins_open_folder` | `id?` | — | Reveals the root or one plugin folder. |
| `cmd_plugins_vault_list` | `id` | `PluginVaultNote[]` | `vault:read`; relative paths. |
| `cmd_plugins_vault_read` | `id, path` | `string` | `vault:read`; path confined to the vault (symlinks too). |
| `cmd_plugins_vault_write` | `id, path, content` | — | `vault:write`; creates folders inside the vault. |
| `cmd_plugins_note_create` | `id, title, content` | `string` | `notes:create`; never clobbers. |
| `cmd_plugins_fetch` | `id, url` | `PluginFetchResponse` | HTTPS GET to a granted host; redirects only to granted hosts. |

## Tests

- Rust (`engine/plugins.rs`, 28 tests): manifest validation, bundled
  examples, folder and zip install, zip path traversal and symlinks,
  reinstall semantics, uninstall, examples seeding, broken packages,
  permission checks for vault/notes/fetch, vault escapes (incl. symlinks),
  settings and storage validation.
- TypeScript: protocol (ids, timeouts, errors, parsing), permissions and
  paths, manifest mirror, view tree validation, bootstrap hardening (string
  and behaviour), worker runtime, host integration with the real examples in
  an in-process worker, the example plugins' helpers, panel rendering
  without HTML injection, the Plugins view flows, and the mock.

## Limitations

- **Desktop CSP** — resolved in v0.2: the Tauri CSP in
  `src-tauri/tauri.conf.json` allows blob workers and blob module imports
  (`worker-src 'self' blob:` and `blob:` in `script-src`), so plugin workers
  start in the desktop app as in the browser preview. Removing either source
  brings back "The webview refused to start the plugin worker".
- Plugins are single-file modules (bundle multi-file code); relative imports
  do not resolve from a blob URL.
- A plugin can still use CPU and memory freely until it is disabled; there
  is no watchdog after activation.
- `ai.query` shares the agent's streaming channel, so plugin queries run one
  at a time and only while the agent panel is idle (the panel shows
  "Thinking…" meanwhile).
- `clipboard.readText` uses the webview clipboard API, which WebKit may gate
  behind a paste prompt.
- `net:fetch` is GET-only with exact host matches (no wildcards, no custom
  ports).
- The bundled examples declare `minAppVersion: "0.2.0"` (the current app
  version); older builds refuse them.
