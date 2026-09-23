# Clipboard history (roadmap 1.3)

## What

A system-wide clipboard manager built into AETHER-OS. Every piece of text,
link, code snippet, color value or image you copy anywhere on the machine is
recorded locally, can be searched, filtered, pinned, re-copied with one
keystroke, and saved to the vault as a note. It replaces standalone tools
like Paste or Maccy.

## Why

Copied snippets are short-lived knowledge: a command you ran, a link a
colleague sent, a color from a design, a screenshot. Keeping them next to the
vault makes them findable later and one step away from becoming a note —
without sending anything to a cloud service.

## How to use

Open **Clipboard** in the rail (System group), press **⌘⇧V** anywhere, or
run *Clipboard: open history* from the palette (⌘K). The search field is
focused, so you can type immediately.

| Key | Action |
| --- | --- |
| ⌘⇧V | Open the history (focuses search) |
| ↑ / ↓ | Move the selection (also while typing in the search field) |
| PageUp / PageDown, Home / End | Jump 10 rows / to the first or last clip |
| ↵ | Copy the selected clip back to the clipboard ("Copied" toast) |
| double-click | Copy a clip |
| P | Pin / unpin the selected clip |
| ⌫ / Delete | Delete the selected clip (Undo in the toast for 5 s) |
| / | Focus the search field |
| Esc | Clear the search (on an empty search: move focus to the list) |

- **Search** is full-text (SQLite FTS5): each word is prefix-matched and
  words are AND-ed; accents are ignored (`apfel` finds `Äpfel`). Words
  without letters or digits (`=>`, `{}`) are matched as substrings.
- **Filters**: All · Text · Links · Code · Images · Colors, plus **Pinned**.
- **Detail pane**: full content — highlighted code, image preview, link with
  *Open link* (system browser), color swatch with HEX / RGB / HSL copy
  buttons. Actions: Copy, Pin, Save as note, Delete.
- **Save as note** asks for a title and creates `clipboard/<title>.md` in the
  vault (never overwrites; `Title 2.md` etc.). Code is fenced with a guessed
  language, links become autolinks, images are copied to
  `attachments/clipboard/clip-<id>.png` and embedded.
- **Pause capture** (header button or *Clipboard: pause / resume capture*)
  stops recording for this session. While paused the clipboard is not read
  at all; whatever you copied during the pause is ignored on resume.
- **Status bar**: clipboard icon with the clip count; shows *Paused* / *Off*
  in the warning color. Click to open the history.
- **Settings → Clipboard**: record on/off, capture images, maximum clips
  (10–10 000, default 500), keep clips for (1 day … 1 year or forever,
  default 30 days), and *Clear history…* (confirmation, optionally keeping
  pinned clips).
- Palette commands: *Clipboard: open history* (⌘⇧V), *pause / resume
  capture*, *clear history…*, *Paste last clip into note* (copies the most
  recent clip back to the clipboard and tells you to press ⌘V in the note),
  and — inside the view — copy / pin / delete selected clip and search.

## How it works

- `ClipboardEngine::launch` (in `lib.rs` setup) opens the history and starts
  one watcher thread that polls the system clipboard via `arboard` every
  700 ms. Text is read first; images are only read when there is no text,
  with exponential back-off (up to ~5.6 s) while an image stays unchanged,
  because decoding a screenshot is far more expensive than reading text.
- Change detection hashes the content (SHA-256). A copy whose hash already
  exists moves that clip to the top and bumps `copy_count` instead of adding
  a duplicate. At start-up, content already on the clipboard is recorded
  only if it is new (no bump for known clips).
- Copies from the UI (`cmd_clipboard_copy`) are recognised by the watcher
  and not recorded twice.
- Classification: **color** (`#rgb[a]`, `#rrggbb[aa]`, `rgb()/rgba()`,
  `hsl()/hsla()`; short all-digit forms like `#123` are issue references),
  **url** (single token, parses with `url`, http(s)/ftp/ws/mailto/file, or
  `www.` links), **code** (≥ 2 non-empty lines, ≥ 25 % of them with code
  signals such as leading keywords, trailing `{ } ; )` or `=>`, `::`, `==`),
  otherwise **text**.
- Ignored: empty / whitespace-only copies, text larger than 2 MB, images
  larger than 40 megapixels.
- Retention runs after every capture and on settings changes: unpinned
  clips not copied within `keep_days` are removed, then everything beyond
  `max_items` unpinned clips (oldest first). **Pinned clips are never
  pruned** and do not count towards the limit.
- Every change emits `clipboard-changed { id, reason }`; the store
  (`src/lib/clipboardStore.ts`) refreshes the stats (status bar) and, while
  the view is mounted, the list.

### Privacy

Nothing leaves the machine. Before anything is stored, text is checked by a
secret heuristic and **silently dropped** (only a session counter is kept,
shown as "N likely secrets skipped") when it:

- contains a well-known token format anywhere: OpenAI/Anthropic/OpenRouter
  `sk-…`, Stripe `sk_live_…`/`rk_…`, GitHub `ghp_`/`gho_`/`ghs_`/…
  /`github_pat_`, GitLab `glpat-`, Slack `xox?-`, npm `npm_`, Hugging Face
  `hf_`, PyPI `pypi-`, AWS `AKIA…`/`ASIA…`, Google `AIza…`, SendGrid `SG.…`,
  JWTs (`eyJ….….…`), PEM private keys;
- is a Luhn-valid card number (13–19 digits, spaces/dashes allowed);
- is a single token of 32+ characters that looks random: Shannon entropy
  ≥ 3.5 bits/char with digits and few vowels, or a long hex string.
  Exempt: 40-character git commit hashes, UUIDs, URLs, file paths and
  e-mail addresses. 64-character hex strings (SHA-256 checksums) are
  treated as secrets because they are indistinguishable from raw keys.

The heuristic cannot catch everything (e.g. short or dictionary-word
passwords). Pause capture while you handle sensitive data.

## Where data lives

`<app data>/clipboard/` (macOS: `~/Library/Application Support/com.ekin.aetheros/clipboard/`)

| File | Content |
| --- | --- |
| `history.db` | SQLite: `clips(id, kind, content, preview, byte_len, pinned, source_app, copy_count, created_at, last_copied_at, hash)` plus the contentless FTS5 index `clips_fts(content)` kept in sync by triggers (image rows index `image <WxH>`). A drifted index is rebuilt on start. |
| `images/<id>.png` | Full image (content of an image clip = this path, preview = `WxH`) |
| `images/<id>.thumb.png` | ≤ 256 px thumbnail for the list |
| `settings.json` | `{ enabled, max_items, keep_days, capture_images }` — out-of-range values are clamped, unreadable files fall back to defaults |

The pause state is kept in memory only (capture resumes after a restart).

## IPC

| Command | Input | Output |
| --- | --- | --- |
| `cmd_clipboard_list` | `query?`, `kind?` (`text`/`url`/`code`/`image`/`color`/`all`), `pinnedOnly`, `limit?` (default 100, max 500), `offset?` | `ClipItem[]` newest first; `content` shortened to 8 000 chars (`truncated: true`) |
| `cmd_clipboard_get` | `id` | `ClipItem` with full content |
| `cmd_clipboard_copy` | `id` | `ClipItem` (written to the system clipboard, counters bumped) |
| `cmd_clipboard_copy_latest` | none | `ClipItem \| null` (most recent clip copied back) |
| `cmd_clipboard_pin` | `id`, `pinned` | `ClipItem` |
| `cmd_clipboard_delete` | `id` | none |
| `cmd_clipboard_clear` | `keepPinned` | number of clips removed |
| `cmd_clipboard_get_settings` | none | `ClipboardSettings` |
| `cmd_clipboard_set_settings` | `settings` | `ClipboardSettings` (validated: `max_items` 10–10 000, `keep_days` 0–3650) |
| `cmd_clipboard_set_paused` | `paused` | `bool` |
| `cmd_clipboard_stats` | none | `{ total, pinned, images, bytes, paused, enabled, skipped_secrets, watcher_error }` |
| `cmd_clipboard_save_as_note` | `id`, `title` | absolute note path |
| `cmd_clipboard_image` | `id`, `thumbnail` | `data:image/png;base64,…` |

Event: `clipboard-changed` — `{ id: string \| null, reason: "captured" | "copied" | "updated" | "deleted" | "cleared" | "settings" }`.

Clip ids must be UUIDs (anything else is rejected before it reaches SQL or a
file path); image files are always addressed as `<images>/<validated id>.png`.

## Code map

| Layer | Files |
| --- | --- |
| Rust engine | `src-tauri/src/engine/clipboard.rs` (store, classification, secrets, retention, watcher, note export) |
| Rust commands | `src-tauri/src/commands/clipboard_commands.rs` |
| Types / IPC | `src/types/clipboard.ts`, `src/lib/ipc/clipboard.ts` |
| State | `src/lib/clipboardStore.ts` |
| Pure helpers | `src/lib/clipboard/{format,color,highlight,windowing,commands}.ts` |
| UI | `src/components/clipboard/*` (view, list, detail, modals, status item, settings), `src/styles/views/clipboard.css` |
| Mock | `src/lib/mock/clipboard.ts` — 40 seeded clips of every kind, a live "new copy every 20 s" feed (one of them a skipped secret), same validation messages as Rust |

## Limitations

- `source_app` is always empty: the frontmost application is not available
  without platform (Objective-C) bindings, so there is no per-app exclusion.
- Pasteboard "concealed"/"transient" markers set by password managers are
  not visible through `arboard`; the secret heuristic and Pause are the
  safeguards.
- Only plain text and bitmap images are captured — no rich text/HTML,
  file references or multiple items per copy.
- Change detection is polling-based (700 ms; images with back-off), so two
  copies within one poll interval record only the last one.
- The "Paste last clip into note" command puts the latest clip on the
  clipboard; you paste it with ⌘V (it does not type into the editor).
- Deletes are committed 5 s after the Undo toast appears; quitting within
  that window keeps the clip.
