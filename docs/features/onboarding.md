# Onboarding, Settings & Help (`onboarding`)

## What

- **First-run wizard** — a near full-screen dialog over the shell that gets a
  new user to a working setup in about two minutes: Welcome → Vault → AI
  model → Semantic search → Tour → Done. Each step has a short explanation,
  an illustration built from tokens and icons, a step rail, progress dots and
  Back / Skip / Continue. It can only be dismissed by finishing or through
  "Skip setup" with a confirmation.
- **Complete Settings** — General, Vault, AI Providers, Editor, Appearance
  (design system), Shortcuts, Data & Privacy, Updates and About, plus the
  sections other features register.
- **Guidance instead of silent failures** — a status bar guard ("Ollama
  offline · fix" / "Model missing · fix"), a once-per-session toast and a
  guidance dialog with copyable install/start commands, a retry, one-click
  model downloads and the switch to OpenRouter.
- **Updates** — manual check, optional daily check on launch, a release card
  with Markdown notes, and a "What's new" note shown once after a version
  change (from the bundled `CHANGELOG.md`).

## Why

AETHER-OS needs three things to be useful — a vault, a local model and an
embedding index — and before this feature a new user had to discover all
three by reading errors. The wizard, the guard and the settings make every
prerequisite visible, explain it in one paragraph and fix it with one click.

## How to use

| Action | Where / shortcut |
| --- | --- |
| Run the setup again | Palette (⌘K) → "Help: run setup again", or Settings → General |
| Wizard navigation | ← / → between steps (outside text fields), ⌘↵ continue, Esc asks to skip |
| Fix local AI | Click "Ollama offline · fix" in the status bar, or palette → "Help: fix the local AI setup (Ollama)" |
| What's new | Palette → "Help: what's new", Settings → Updates / General |
| Check for updates | Palette → "Check for updates" (opens Settings → Updates) |
| Keyboard cheat sheet | Palette → "Copy keyboard cheat sheet (Markdown)", or Settings → Shortcuts → Copy / Save as note |
| Data & privacy | Palette → "Data & privacy settings", or ⌘, → Data & Privacy |

The commands live in the "Help" group of the palette and the shortcuts
overlay. They have no key binding of their own (the global combos are
reserved for daily actions).

### Wizard steps

1. **Welcome** — what AETHER-OS is and the privacy promise.
2. **Vault** — detected vaults (Obsidian `.obsidian/`, NoPes `.nopes/`, plain
   folders with ≥ 5 Markdown files; searched in `~/Documents`, `~` at depth 2
   and Obsidian's iCloud folder), "Choose a folder…" (native dialog) or
   "Create a new vault" at `~/Documents/AETHER Vault`. The starter vault
   contains `Welcome.md`, a `README.md` explaining wikilinks, tags, tasks,
   daily notes and flashcards, today's daily note, `Projects/Getting
   started.md` (tasks with due dates) and `Resources/Markdown cheat
   sheet.md`. Continue needs a vault; the step can be skipped.
3. **AI model** — Ollama status, install/start commands when offline, a model
   recommendation by RAM (< 8 GB `llama3.2:1b`, < 16 GB `llama3.2:3b`,
   < 32 GB `qwen2.5:7b`, otherwise `qwen2.5:14b`), downloads with live
   progress, the installed models as default-model chips, or an OpenRouter
   key instead.
4. **Semantic search** — explains embeddings, downloads `nomic-embed-text`
   and indexes the vault.
5. **Tour** — six cards (palette ⌘K, quick capture ⌘⇧N, agent panel ⌘J, IDE,
   terminal, calendar/tasks) with the live shortcut from the command
   registry. "Try it" pauses the wizard, runs the command and shows a
   "Resume setup" pill.
6. **Done** — summary of vault / AI / semantic search, the opt-in for the
   daily update check, "Open Home".

Model downloads live in a store, so they keep running (and show progress
everywhere) while the wizard or settings are closed.

### Settings sections

| Section | Contents |
| --- | --- |
| General (order 42) | Start view, agent panel on start (remember / open / closed), interface language (English, read-only), run setup again, "What's new" toggle |
| Vault | Folder with Browse, status (notes, tasks, tags, links), Reveal in Finder, create a starter vault, find existing vaults, daily-note folder & file-name pattern |
| AI Providers | Default provider, Ollama connection (fixed `http://localhost:11434`), default model from installed models, download any model by name with progress, OpenRouter key (save / test / remove) and default cloud model, embedding model status + download, "Index now" |
| Editor | Note editor text size (13–22 px) and line width (560–1120 px), applied instantly; external editor for projects |
| Shortcuts (70) | Every registry command and editor shortcut, searchable, "only with a shortcut", click to run, copy cheat sheet (Markdown table), save it as a vault note |
| Data & Privacy (80) | Where the data lives (vault, data folder with per-item sizes), what leaves the machine, crash reports (view / copy / delete all), application log (frontend-only filter, copy), reset app data |
| Updates (90) | Installed version, check now, release card with notes and "Open release page", daily check toggle, "What's new" |
| About (1000) | Mark, version, links (GitHub, releases, tutorial), credits of major OSS dependencies with licenses, license note |

**Reset app data** (danger zone, double confirmation: checkbox, then typing
`RESET`) moves the whole data directory to
`<data_dir>-backup-<YYYYMMDD-HHMMSS>`, recreates it empty (optionally copying
back the vault connection `config.json` and `vault_prefs.json`), clears the
`aether-*` localStorage keys and restarts the app. Nothing is deleted and the
vault folder is never touched. In the browser preview the mock is reset and
the page reloads.

## Where data lives

| Data | Location |
| --- | --- |
| Wizard state `{ completed_at, version_seen, skipped_steps }` | `<data_dir>/onboarding.json` |
| Daily-note folder & pattern | `<data_dir>/vault_prefs.json` |
| Start view, agent panel on start, auto update check + last check time, "What's new" toggle, editor font size / line width | localStorage `aether-onboarding-prefs` |
| Editor typography | CSS variables `--editor-font-size` / `--editor-line-width` on `<html>`, read in `src/styles/views/onboarding.css` (`.editor-body`, `.editor-body .ProseMirror`) |
| Changelog | `CHANGELOG.md` at the repo root, compiled in with `include_str!` |

`<data_dir>` is `~/Library/Application Support/com.ekin.aetheros` on macOS.

## IPC

| Command | Input | Output |
| --- | --- | --- |
| `cmd_onboarding_get_state` | — | `OnboardingState` (`completed_at: null` on first run; a corrupt file counts as first run) |
| `cmd_onboarding_set_state` | `onboarding: OnboardingState` | validated `OnboardingState` |
| `cmd_onboarding_create_vault` | `path` (absolute, inside `~`, new or empty) | `VaultInfo { path, name, note_count, kind }` — does not connect it |
| `cmd_onboarding_detect_vaults` | — | `VaultInfo[]` (NoPes → Obsidian → plain, by note count) |
| `cmd_onboarding_suggest_vault_path` | — | free `~/Documents/AETHER Vault[ n]` |
| `cmd_onboarding_system_profile` | — | `{ total_ram_gb, cpu_cores, physical_cores, arch, os }` |
| `cmd_onboarding_pull_model` | `name` | `PullOutcome { name, cancelled }`; streams `ollama-pull-progress { name, status, completed, total }` |
| `cmd_onboarding_cancel_pull` | `name` | `bool` (was running) |
| `cmd_onboarding_get_vault_prefs` / `set_vault_prefs` | `prefs: { daily_folder, daily_filename_pattern }` | `VaultPrefs` |
| `cmd_onboarding_reveal_vault` | — | reveals the connected vault in the file manager |
| `cmd_onboarding_data_locations` | — | `DataLocation[] { name, path, is_dir, size_bytes, description }` |
| `cmd_onboarding_read_app_log` | `maxBytes` (clamped 1 KiB–1 MiB) | `AppLogTail { path, content, size_bytes, truncated }` (whole lines) |
| `cmd_onboarding_read_changelog` | — | bundled `CHANGELOG.md` |
| `cmd_onboarding_reset_app_data` | `keepVault` | `ResetOutcome { backup_path, kept, restarting }`, then `request_restart()` after 1.5 s |

Existing commands used: `cmd_get_health`, `cmd_list_local_models`,
`cmd_list_cloud_models`, `cmd_set_openrouter_key`, `cmd_set_vault_path` (+
vault reloads), `cmd_index_vault`, `cmd_create_note`, `cmd_check_for_updates`,
`cmd_get_app_info`, `cmd_open_app_data_dir`, `cmd_list_crash_reports`,
`cmd_read_crash_report`, `cmd_clear_crash_reports`, `cmd_browser_open`.

### Security

- New vault paths are canonicalised (deepest existing ancestor, symlinks
  resolved), must lie inside the home folder and contain no `.`/`..`;
  existing non-empty folders are refused and files are created with
  `create_new` (never overwritten).
- Model names are validated (`[A-Za-z0-9][A-Za-z0-9._:/-]*`, no `..`/`//`)
  before they reach Ollama; pulls go only to `http://localhost:11434/api/pull`
  (3 s connect / 120 s read timeout, cancellation checked every 250 ms,
  progress events throttled to one per 120 ms plus every status change).
- Only fixed file names inside the data directory are read (`logs/aether.log`,
  `onboarding.json`, `vault_prefs.json`); the reset refuses top-level folders.
- Update checks stay anonymous and are opt-in for the automatic daily check.

## Mock mode

`src/lib/mock/onboarding.ts`: the wizard state starts as a first run so the
wizard shows in the preview; once finished or skipped it is kept in
localStorage (`aether-mock-onboarding`) so reloads do not show it again —
`window.__AETHER_MOCK__.reset()` or "Help: run setup again" brings it back.
Vault detection returns two fake vaults, created vaults are tracked per path,
pulls stream fake progress over ≈ 3 s and the pulled model then appears in
`cmd_list_local_models`; `does-not-exist` fails like an unknown model.

## Tests

- Rust (`engine/onboarding.rs`, 24 tests): state persistence and validation,
  vault prefs, starter vault layout and content, no clobbering, home-folder
  confinement (incl. symlinks), vault classification and detection, system
  profile, model-name validation, NDJSON line parsing and re-assembly,
  throttling, pulls against a fake chunked NDJSON server (success, errors,
  truncated stream, offline, cancel), pull registry, reset/backup, data
  locations, log tail, bundled changelog.
- Vitest: wizard state machine, version compare and launch decision,
  changelog parser, cheat-sheet generator, model helpers, store (prefs, pulls,
  update check), startup sequence, mock handlers, wizard / guard / guide /
  what's-new components and every settings section.

## Limitations

- **Daily-note preferences are forward-looking**: they shape new starter
  vaults only. Quick capture and the agent still write to
  `daily/YYYY-MM-DD.md` (owned by the vault reader).
- **Embedding model is fixed** to `nomic-embed-text` in `cmd_index_vault`;
  Settings shows it read-only rather than offering a choice that would not
  take effect.
- **Not implemented (would be fake today):** "confirm on quit with running
  terminals" (needs a `RunEvent::ExitRequested` hook in `lib.rs` and the
  `core:window:allow-destroy` capability), "show FAB stack" (the shell has no
  floating action buttons since the v0.2 titlebar), spellcheck toggle (the
  editor sets no `spellcheck` attribute to toggle).
- Interface copy is English only; the language row is informational.
- The overlays are mounted through an invisible status bar item
  (`onboarding.host`) because `App.tsx` has no anchor.
