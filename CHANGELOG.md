# Changelog

All notable changes to AETHER-OS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/). The "What's new" dialog
in the app shows the section of the running version (or "Unreleased" in
development builds), so keep each entry short and user-facing.

## Unreleased

## 0.2.0 — 2026-09-23

### Design

- New design system: warm graphite surfaces with one quiet accent, IBM Plex
  Sans and JetBrains Mono bundled locally, consistent spacing, radii and
  layered shadows.
- Light and dark themes (⇧⌘L, or follow the system), four accents (Teal,
  Ember, Cobalt, Graphite) and a compact density in Settings → Appearance.
  The terminal, code editor, graph, charts and diagrams follow the theme.
- Every workspace uses the same building blocks: headers, empty states,
  inline errors and toasts.

### Shell

- Navigation rail grouped into Knowledge, Build, Life and System; ⌘\ shows
  labels. Nineteen workspaces, ⌘1–⌘9 for the first nine.
- The titlebar search pill and ⌘K open the new launcher, which replaces the
  command bar.
- Status bar with live items: vault, index, AI providers, clipboard,
  history, due tasks, sync, focus timer, pins, related notes, word count.
- Shortcuts overlay (⌘/) listing every command.
- Settings became a searchable modal with fifteen sections.
- The dashboard is now **Home**; semantic search is now **Universal Search**.

### Features

- **Clipboard history** (⇧⌘V): everything you copy, searchable and
  filterable by text, links, code, images and colours; pin, re-copy, save
  as a note. Likely secrets are never stored; capture can be paused.
- **Launcher and Universal Search**: ⌘K in the app and ⌥Space system-wide
  find commands, notes, projects, files, apps, events, tasks, memory, chats,
  bookmarks and clips. Prefixes `>` `#` `/` `@` `?`, ⌘P go to file, ⇧⌘P run
  a command. The Search view adds category tabs, a preview pane and
  semantic ranking.
- **Note history**: every save becomes a local Git version of the note.
  Browse versions, compare them side by side and restore with one click
  (⇧⌘H); snapshot now with ⌥⌘S.
- **Home, pins and focus**: a real Home with today's note, events and due
  tasks, where to continue, pins and vault health; pins for notes, projects,
  commands, chats and links (⇧⌘D, ⌥⌘B); a Pomodoro timer (⌥⌘T) with focus
  statistics and a distraction-free focus mode (⇧⌘F).
- **Note Tasks** (⌥⌘C): every checkbox from every note as a board, a list
  by due date or grouped by note. Ticking, moving and editing write back to
  the Markdown; compatible with the Obsidian Tasks syntax. ⇧⌘T adds a task
  to today's daily note from anywhere.
- **Smarter agent**: long chats are compacted into a summary instead of
  overflowing the model; related notes and tags are suggested while you
  write (⇧⌘R). The agent can now run shell commands, move and delete notes,
  commit, create tasks and tick off note tasks — anything risky waits for
  your approval, and every action is logged.
- **Plugins**: sandboxed plugins with explicit, revocable permissions,
  panels, commands and status bar items. Word Count, Daily Review and
  Random Note ship as examples.
- **Export and publishing**: a note as standalone HTML or PDF, the vault
  (or a folder, tag or selection) as a static website with backlinks, tags
  and search, or as a Markdown bundle.
- **Sync and backup**: end-to-end encrypted sync between devices through a
  folder you already sync (iCloud Drive, Dropbox, Syncthing, a NAS) — no
  account and no relay server; conflicts are kept side by side. Encrypted,
  verifiable backups, manual or scheduled.
- **Setup and help**: a first-run wizard that connects or creates a vault,
  checks Ollama, recommends and downloads a model for your machine, sets up
  semantic search and tours the key shortcuts. Complete settings (General,
  Vault, AI Providers, Editor, Appearance, Shortcuts, Data & Privacy,
  Updates, About), "Ollama offline" guidance with copyable commands and
  one-click model downloads, an update check with release notes, and this
  "What's new" note after every update.
- **Note properties**: YAML front matter appears as editable key/value
  rows above the note (tags as chips, add and remove properties); edits
  change only the affected line and leave the note body untouched.
- **Quit confirmation**: quitting while terminal sessions run asks first;
  press ⌘Q again to quit anyway, or turn it off in Settings → General.
- **Embedding model** can be changed in Settings → AI Providers; switching
  clears the vector index so the vault is re-indexed with the new model.
- **Pins in the vault sidebar**, above the note tree.
- **Daily notes** follow the folder and file-name pattern from Settings →
  Vault, including sub-folders such as `YYYY/MM/YYYY-MM-DD` — for Quick
  Capture, Home, new note tasks and the agent.
- Opening a note from Note Tasks scrolls to the task and highlights it.

### Fixed

- The note editor could save one note's text into another when you
  switched notes within the autosave delay. Saves now remember which note
  they belong to and are flushed before the note, the view or the window
  changes.
- Notes changed by another feature (a history restore, an agent action, a
  related-note link) are reloaded in the editor instead of being
  overwritten by pending edits.
- Typing in a note with YAML front matter no longer turns the front matter
  into a heading; front matter is kept exactly as written.
- Sync and backup errors now say where they come from (`sync error: …` for
  the folder or transfer, `crypto error: …` for keys and data).
- Version 0.2.0 is reported consistently by the app, the update check and
  the release bundles.
- **Saving a note no longer rewrites what you did not edit.** The editor
  escaped wikilinks (`[[AETHER-OS]]` became `\[\[AETHER-OS\]\]`, breaking
  links, backlinks and the graph), dropped the blank line before task
  lists, merged a heading into the image line above it and added an empty
  `- [ ]` task to lists mixing plain and task items. Now only edited lines
  change, and `[[links]]`, `![[embeds]]`, `#tags`, `==highlights==`,
  `%%comments%%`, `$math$`, footnotes, callouts, HTML comments and numbered
  tasks are saved exactly as written.
- **Wikilinks in the editor.** Typing `[[` opens the note autocomplete
  (fuzzy search, ↑/↓, ↵ or Tab to insert, Esc to close, "Create note …" as
  the last row). Links show as chips that open their note, and
  `![[image.png|300]]` embeds show in the editor.
- Text typed while another note is still opening is saved into the note it
  was typed in, not into the note being opened.

### Removed

- The old command bar and the separate Semantic Search view (both replaced
  by the launcher and Universal Search).

### Infrastructure

- Browser preview: `npm run dev:mock` runs the whole app against a mock
  backend with a demo vault; a test keeps a mock for every backend command.
- Local crash reports and a rotating log (nothing is uploaded), viewable in
  Settings → Data & Privacy.
- CI for every push (format, lint, Rust and frontend tests, build) and
  tagged release builds for macOS, Linux and Windows; `npm run check` runs
  the same gates locally.
- Typed IPC split per domain, a shared SQLite helper, and registries with
  anchors so features plug in without touching each other's code.

### Distribution

- One universal macOS download for Apple Silicon and Intel, ad-hoc signed
  so it opens on other Macs (first launch: right-click → Open, or System
  Settings → Privacy & Security → Open Anyway). Windows installer (per-user
  NSIS with WebView2 bootstrapper and MSI) and Linux AppImage, deb and rpm.
  Every release ships a `SHA256SUMS.txt`.
- Opened from Finder, the Dock or a desktop menu, the app now picks up your
  login shell's `PATH`, so git, language servers and agent commands find
  tools installed with Homebrew, nvm, cargo and friends.
- First launch no longer scans Documents, Desktop and Downloads for vaults
  (that triggered macOS privacy prompts); the setup wizard finds existing
  vaults when you get to that step.
- New terminals open in your home folder with your login shell instead of
  assuming `/bin/zsh` in `/`.
- Opening links, editors, terminals and folders works on Windows and Linux
  as well as macOS; features that only exist on macOS say so instead of
  failing.
- Install guide for every platform in `docs/INSTALL.md`.
