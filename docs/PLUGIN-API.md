# AETHER-OS Plugin API

Plugins extend AETHER-OS without touching its code. A plugin is a small,
plain-JavaScript ES module that runs in its own **Web Worker**, talks to the
app through a typed message protocol and only gets the capabilities its
manifest requests **and** the user grants. This document is the reference
for plugin authors. The user-facing side (installing, enabling, reviewing
permissions) is described in `docs/features/plugins.md`.

- [1. Quick start](#1-quick-start)
- [2. Package layout](#2-package-layout)
- [3. Manifest reference](#3-manifest-reference)
- [4. Permissions](#4-permissions)
- [5. Lifecycle](#5-lifecycle)
- [6. API reference](#6-api-reference)
- [7. Panels (view tree)](#7-panels-view-tree)
- [8. Events](#8-events)
- [9. Sandbox and limits](#9-sandbox-and-limits)
- [10. Examples](#10-examples)
- [11. Debugging](#11-debugging)

## 1. Quick start

Create a folder with two files:

```
hello-plugin/
├── manifest.json
└── main.js
```

`manifest.json`

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "description": "Says hello to the open note.",
  "author": "You",
  "main": "main.js",
  "minAppVersion": "0.1.0",
  "permissions": ["vault:read", "ui:commands"]
}
```

`main.js`

```js
export async function activate(api) {
  await api.commands.register({
    id: "greet",
    title: "Say hello to this note",
    shortcut: "mod+alt+shift+h",
    run: async () => {
      const note = await api.notes.current();
      await api.ui.toast(note ? `Hello, ${note.name}!` : "Open a note first.");
    },
  });
}
```

Install it: **Plugins → Install plugin** (⌥⇧⌘I), pick the folder (or a
`.zip` of it), review the permissions and enable it. The command now shows
up in the command palette (⌘K) under **Plugins**.

## 2. Package layout

| File | Purpose |
| --- | --- |
| `manifest.json` | Required, at most 64 KB. See §3. |
| `main.js` (or the file named by `main`) | Required. One ES module, at most 2 MB. |
| anything else | Copied along (docs, licence, assets) but not loaded. |

- The entry module is loaded **as a single file** from a blob URL, so
  relative `import`s do not resolve. Bundle multi-file sources into one
  module (esbuild, Rollup, …) before shipping.
- A `.zip` may contain the files at its root or inside one top-level
  folder (what "Compress folder" produces). Hidden files, `__MACOSX/` and
  `node_modules/` are skipped. Archives with symbolic links or entries that
  would escape the plugin folder (`../`, absolute paths, drive letters,
  backslashes) are rejected as a whole.
- Packages are capped at 512 files and 20 MB (extracted).
- Installing a package whose `id` is already installed **updates** it:
  settings and storage are kept, granted permissions are narrowed to what
  the new manifest still requests (new permissions start ungranted).

## 3. Manifest reference

Unknown fields are rejected, so typos fail loudly.

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | string | yes | 3–64 chars of `a-z 0-9 . - _`, starts and ends with a letter or digit, no repeated separators (so no `..`). Reverse-DNS style recommended: `com.example.wordcount`. It is also the folder name. |
| `name` | string | yes | 1–64 characters, shown in the UI. |
| `version` | string | yes | Strict SemVer 2.0 (`1.2.3`, `1.0.0-beta.1`, no `v` prefix). |
| `description` | string | no | Up to 500 characters. |
| `author` | string | no | Up to 100 characters. |
| `main` | string | no | Default `main.js`. Relative path inside the package, `.js`/`.mjs`, no `..`, no hidden segments. |
| `minAppVersion` | string | no | SemVer; the plugin is refused on older AETHER-OS versions. |
| `permissions` | string[] | no | Up to 32 entries from §4, no duplicates. |
| `settings` | object[] | no | Up to 32 settings, see below. |

### Settings

Each entry renders one control in the plugin's settings form. Values are
validated on save and read with `api.settings.get()`.

| Field | Applies to | Notes |
| --- | --- | --- |
| `key` | all | `[A-Za-z][A-Za-z0-9_]*`, max 64, unique. |
| `type` | all | `string`, `number`, `boolean` or `select`. |
| `label` | all | 1–80 characters. |
| `description` | all | Optional hint under the control (≤ 300). |
| `default` | all | Must match the type (and bounds/options). |
| `min`, `max` | `number` | Optional bounds. |
| `options` | `select` | 1–50 `{ "value", "label" }` with unique values. |

Without a `default`, a setting starts as `""`, `min ?? 0`, `false` or the
first option.

```json
"settings": [
  { "key": "wordsPerMinute", "type": "number", "label": "Reading speed", "default": 230, "min": 60, "max": 1000 },
  { "key": "style", "type": "select", "label": "Summary style", "default": "bullets",
    "options": [{ "value": "bullets", "label": "Bullet points" }, { "value": "paragraph", "label": "Short paragraph" }] }
]
```

## 4. Permissions

A plugin starts **disabled with nothing granted**. When the user enables it
they see every requested permission and can switch each one off. Every API
call is checked in the host *and again in Rust*; calling something that was
not granted rejects with
`permission denied: plugin "<id>" has not been granted "<permission>"`.

| Permission | Unlocks | Notes |
| --- | --- | --- |
| `vault:read` | `vault.list`, `vault.read`, `notes.current`, `notes.open`, `ai.query` with `notes`, events `note:opened` / `note:saved` | Read-only access to every note in the vault. |
| `vault:write` | `vault.write` | Create or overwrite any `.md` note inside the vault. |
| `notes:create` | `notes.create` | New notes only, never overwrites. |
| `ui:commands` | `commands.register` / `unregister`, event `command:invoked` | Commands appear in the palette under "Plugins". |
| `ui:panel` | `ui.panel.set`, event `panel:action` | Declarative panel on the Plugins page (§7). |
| `ui:statusbar` | `ui.statusbar.set` | One short text in the status bar. |
| `ai:query` | `ai.query` | Uses the provider and model selected in the agent panel. |
| `clipboard:read` | `clipboard.readText` | Current clipboard text. |
| `net:fetch:<host>` | `net.fetch` and `fetch()` for `https://<host>/…` | One permission per exact host (`net:fetch:api.github.com`). No wildcards, IP addresses, `localhost` or local-only names. |

Always available without a permission: `ui.toast`, `storage.*`,
`settings.get`, `events.on('settings:changed')`.

## 5. Lifecycle

```js
export async function activate(api) { /* required */ }
export async function deactivate() { /* optional */ }
```

`export default { activate, deactivate }` and `export default function activate(api)`
work too.

1. **Start** — when AETHER-OS launches (or the plugin is enabled), the host
   creates a worker from the hardened bootstrap (§9), sends it the module
   source and calls `activate(api)`. It must settle within **10 s**;
   a throw or timeout marks the plugin *Failed* with the message shown on
   its card (**Retry** restarts it).
2. **Running** — the plugin reacts to commands, events and panel clicks.
   Registered commands, panels and status items live exactly as long as the
   worker.
3. **Stop** — on disable, uninstall, reload (⌥⇧⌘R) or when its code or
   grants change, the host calls `deactivate()` (2 s budget) and terminates
   the worker. Everything it contributed disappears.

A plugin whose code, version or granted permissions change is restarted
automatically.

## 6. API reference

Every method returns a Promise. Paths are always **vault-relative with
forward slashes** (`daily/2026-09-22.md`) and must end in `.md`; absolute
paths, `..` and hidden segments are rejected. Arguments are validated and
must be plain data (strings, numbers, booleans, arrays, plain objects).
Unless noted, calls time out after 10 s.

### `api.plugin`

```ts
api.plugin: { id: string; name: string; version: string; permissions: string[] }  // granted permissions
```

### `api.vault` — `vault:read` / `vault:write`

```ts
api.vault.list(): Promise<{ path: string; name: string; mtime: number }[]>
api.vault.read(path: string): Promise<string>              // ≤ 5 MB
api.vault.write(path: string, content: string): Promise<void>  // creates folders; ≤ 5 MB
```

If the written note is open and unchanged in the editor, the editor reloads
it; if it has unsaved edits the user is warned instead.

### `api.notes`

```ts
api.notes.create(title: string, content?: string): Promise<{ path: string }>  // notes:create
api.notes.current(): Promise<{ path: string; name: string; content: string } | null>  // vault:read
api.notes.open(path: string): Promise<void>                                  // vault:read
```

- `create` turns the title into a file name (`"Ideas: v2?"` → `Ideas- v2-.md`),
  accepts `folder/Title` and never overwrites (`Title 2.md`, …).
- `current` includes unsaved edits of the open note.
- `open` shows the note in the editor.

### `api.commands` — `ui:commands`

```ts
api.commands.register({ id, title, shortcut?, run }): Promise<void>
api.commands.unregister(id: string): Promise<void>
```

- `id`: `[A-Za-z0-9._-]{1,64}`, unique within the plugin (re-registering
  replaces). The palette id becomes `plugin:<plugin id>:<id>`.
- `title`: ≤ 80 characters. Up to 20 commands per plugin.
- `shortcut`: optional, same syntax as the app (`mod+alt+shift+o`; `mod` is
  ⌘ on macOS, Ctrl elsewhere). It needs a modifier and must not be taken by
  another command, otherwise the command is registered **without** it and a
  warning appears on the plugin card.
- `run` executes in the worker when the user runs the command (180 s
  budget). A thrown error becomes an error toast "<title> failed".

### `api.ui`

```ts
api.ui.panel.set(tree: ViewNode | ViewNode[] | null): Promise<void>  // ui:panel, see §7
api.ui.panel.clear(): Promise<void>
api.ui.statusbar.set(text: string | null, tooltip?: string | null): Promise<void>  // ui:statusbar; text ≤ 60, tooltip ≤ 300
api.ui.statusbar.clear(): Promise<void>
api.ui.toast(message: string, kind?: "info" | "success" | "error"): Promise<void>  // ≤ 300 chars, 5 per 10 s
```

Toasts always name the plugin ("From the Word Count plugin").

### `api.ai` — `ai:query`

```ts
api.ai.query(prompt: string, options?: { notes?: string[] }): Promise<string>
```

Sends `prompt` (≤ 20 000 characters) to the model selected in the agent
panel, with the given notes (vault-relative, ≤ 50, needs `vault:read`) as
context, and resolves with the full answer. Queries run one at a time and
share the agent's streaming channel: while one runs the agent panel shows
"Thinking…", and a query started while the agent is already answering
rejects with "The AI agent is busy …". Budget: 180 s.

### `api.storage` — no permission

```ts
api.storage.get(key: string): Promise<unknown | null>
api.storage.set(key: string, value: unknown | null): Promise<void>  // null deletes
```

Private JSON key/value storage per plugin (keys ≤ 128 characters, 1 MB in
total). It survives updates and is deleted on uninstall.

### `api.settings` — no permission

```ts
api.settings.get(): Promise<Record<string, string | number | boolean>>
```

Current values for every manifest setting (defaults filled in). Listen to
`settings:changed` to react to edits.

### `api.clipboard` — `clipboard:read`

```ts
api.clipboard.readText(): Promise<string>
```

### `api.net` — `net:fetch:<host>`

```ts
api.net.fetch(url: string): Promise<{
  url: string; status: number; ok: boolean; contentType: string | null;
  body: string; text(): string; json(): unknown;
}>
```

HTTPS GET only, default port, no credentials in the URL, host must match a
granted `net:fetch:<host>` exactly. Redirects are followed (max 5) only to
granted hosts. Bodies are capped at 5 MB, requests at 20 s (30 s budget in
the worker). Plugins with a network grant also get a global `fetch(url)`
that goes through the same path and returns a `Response`; `XMLHttpRequest`,
`WebSocket` and `EventSource` never exist.

### `api.events`

```ts
api.events.on(name: string, handler: (payload) => void): () => void  // returns unsubscribe
```

See §8.

## 7. Panels (view tree)

`api.ui.panel.set()` takes a JSON tree of known node types — never HTML.
The host validates it (unknown types or fields reject the whole call with
`invalid panel: …`) and renders it with the app's own components, so panels
match the theme automatically.

| Node | Fields | Rendering |
| --- | --- | --- |
| `text` | `text` (≤ 2000), `tone?: "default" \| "muted"` | Paragraph, line breaks kept. |
| `heading` | `text`, `level?: 1 \| 2 \| 3` (default 2) | Level 3 is a small uppercase section label. |
| `list` | `items: (string \| { text, meta?, indent? })[]` (≤ 500), `ordered?` | `meta` is right-aligned (counts, dates); `indent` 0–3. |
| `button` | `label` (≤ 80), `actionId` (`[A-Za-z0-9._:-]{1,64}`), `variant?: "secondary" \| "ghost"` | Click sends `panel:action { actionId }`. |
| `badge` | `text` (≤ 80), `variant?: neutral \| accent \| success \| warning \| danger \| info` | Consecutive badges share a row. |
| `divider` | — | Horizontal rule. |
| `markdown` | `content` (≤ 20 000) | GitHub-flavoured Markdown. Raw HTML is shown as text, images are replaced by their alt text, mermaid blocks render as code, `javascript:` links are removed. |

A panel may have up to 200 top-level nodes. `set(null)` (or `clear()`)
removes it.

```js
await api.ui.panel.set([
  { type: "heading", text: "Inbox", level: 2 },
  { type: "badge", text: "3 open", variant: "warning" },
  { type: "list", items: [{ text: "Call the movers", meta: "today" }, "Review tokens"] },
  { type: "button", label: "Refresh", actionId: "refresh" },
]);
api.events.on("panel:action", ({ actionId }) => { if (actionId === "refresh") void render(); });
```

## 8. Events

| Event | Payload | Needs |
| --- | --- | --- |
| `note:opened` | `{ path, name }` | `vault:read` |
| `note:saved` | `{ path, name }` | `vault:read` |
| `command:invoked` | `{ id }` (your command id) | `ui:commands` |
| `panel:action` | `{ actionId }` | `ui:panel` |
| `settings:changed` | `{ settings }` | — |

Events without the permission are simply not delivered. Handler errors are
caught and reported on the plugin card.

## 9. Sandbox and limits

**Where plugins run.** One dedicated module Web Worker per plugin: no DOM,
no access to the app's JavaScript, no Tauri IPC. Before the plugin module
is imported, the bootstrap deletes and locks (along the whole prototype
chain) `fetch`, `XMLHttpRequest`, `WebSocket`, `WebSocketStream`,
`EventSource`, `WebTransport`, `importScripts`, `indexedDB`, `caches`,
`Worker`, `SharedWorker`, `BroadcastChannel`, `Notification`,
`RTCPeerConnection` and `navigator.storage/locks/…`. With a `net:fetch`
grant, `fetch` is replaced by a GET-only shim routed through the host.

**Checks on every call.** The host validates the method, the permission and
the arguments; Rust re-checks the permission (the plugin must be installed,
valid, enabled and granted) and confines paths to the vault or the plugin's
own data. Hosts for `net:fetch` are matched exactly and only over HTTPS.

**Limits at a glance.**

| What | Limit |
| --- | --- |
| Entry module | 2 MB |
| Package | 512 files, 20 MB |
| Activation | 10 s |
| API call | 10 s (AI 180 s, fetch 30 s) |
| Command run | 180 s |
| Commands per plugin | 20 |
| Calls in flight | 64 |
| Call parameters | 1 MB per call (5 MB for note content: `vault.write`, `notes.create`); larger payloads are rejected before validation |
| Call rate | burst of 200 calls, then 100 calls/s per plugin (token bucket); excess calls fail with "Too many API calls — at most 100 per second; retry in N ms" |
| Toasts | 5 per 10 s |
| Storage | 1 MB per plugin |
| Note read/write | 5 MB |
| Fetch response | 5 MB, 20 s, 5 redirects |
| Panel | 200 nodes, 500 list items, 20 000 chars of Markdown |

**What the sandbox does not do.** A worker can still burn CPU or memory
until the user disables the plugin, and dynamic `import()` of remote URLs is
blocked only by the app's Content-Security-Policy (the desktop build), not
by the bootstrap.

## 10. Examples

Three real plugins ship in `plugins/examples/` and are installed on first
run (disabled, except in the browser preview where Word Count starts
enabled):

| Plugin | Permissions | Shows how to |
| --- | --- | --- |
| `word-count` — Word Count | `vault:read`, `ui:statusbar`, `ui:panel` | follow the open note (`note:opened`, `note:saved`), status bar text, a panel with badges/lists/buttons, number and boolean settings |
| `daily-review` — Daily Review | `vault:read`, `vault:write`, `ai:query`, `ui:commands` | a command that reads today's daily note, asks the AI and rewrites the note's `## Review` section; string/select/boolean settings |
| `random-note` — Random Note | `vault:read`, `ui:commands` | a command with a shortcut (⌥⇧⌘O) that opens a note via `api.notes.open` |

Each example exports its pure helpers (`countWords`, `upsertSection`,
`pickRandomNote`, …) so they can be unit-tested; see
`src/lib/plugins/examples.test.ts`.

## 11. Debugging

- **Plugin card** — status (*Running*, *Starting…*, *Failed*, *Disabled*,
  *Broken*), activation errors with **Retry**, the last warning or error
  your plugin reported, its registered commands (run them from the card).
  The host keeps a per-plugin log of the last 20 entries (your `console`
  warnings and errors, worker crashes, malformed messages, and a
  "Rate limited" warning at most every 5 s).
- **DevTools** — worker `console.*` output appears in the webview console;
  the host logs `[plugin <id>] …` lines for errors and warnings.
- **Reload** — ⌥⇧⌘R ("Reload plugins") restarts every plugin after you
  edit its files in place. "Open plugins folder" reveals
  `<app data>/plugins/<id>/`; a symlinked folder there works for
  development (uninstalling unlinks it and leaves your checkout alone).
- **Browser preview** — `npm run dev:mock` runs real plugin workers against
  the mock backend; the install dialog offers demo packages.
