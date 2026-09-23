//! First-run onboarding and settings support (feature `onboarding`).
//!
//! Everything the setup wizard and the Settings sections need that the
//! other engines do not already provide:
//!
//! * `<data_dir>/onboarding.json` — wizard state
//!   (`{ completed_at, version_seen, skipped_steps }`).
//! * `<data_dir>/vault_prefs.json` — daily-note folder and filename pattern,
//!   used by the starter vault layout and by the vault reader for quick
//!   capture / "add to today" (default `daily/YYYY-MM-DD.md`).
//! * `<data_dir>/general_prefs.json` — general app preferences (confirm
//!   before quitting while terminal sessions are running).
//! * Starter vault creation (useful notes explaining wikilinks, tags, tasks)
//!   and detection of existing Obsidian / NoPes / plain Markdown vaults.
//! * A small system profile (RAM, cores, arch) for the model recommendation.
//! * Ollama model downloads through `/api/pull` with NDJSON progress parsing,
//!   throttled progress events and cancellation.
//! * Data locations, an application log tail and the "reset app data"
//!   operation, which moves the data directory aside as a dated backup.
//! * The bundled `CHANGELOG.md` for the "What's new" dialog.
//!
//! Paths coming from the UI are untrusted: new vaults must resolve inside the
//! user's home folder, model names are validated before they reach Ollama and
//! only fixed file names inside the data directory are read.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, NaiveDate};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::engine::error::AetherError;

/// Wizard state file inside the app data directory.
pub const STATE_FILE: &str = "onboarding.json";
/// Vault preferences file inside the app data directory.
pub const VAULT_PREFS_FILE: &str = "vault_prefs.json";
/// General preferences file inside the app data directory.
pub const GENERAL_PREFS_FILE: &str = "general_prefs.json";
/// The changelog bundled at compile time (repo root `CHANGELOG.md`).
pub const CHANGELOG: &str = include_str!("../../../CHANGELOG.md");
/// Local Ollama endpoint. Pulls never go anywhere else.
pub const OLLAMA_ENDPOINT: &str = "http://localhost:11434";
/// Tauri event carrying [`PullProgress`] payloads.
pub const PULL_PROGRESS_EVENT: &str = "ollama-pull-progress";
/// Name of the starter vault folder suggested by the wizard.
pub const DEFAULT_VAULT_NAME: &str = "AETHER Vault";

const MAX_SKIPPED_STEPS: usize = 16;
const MAX_STEP_ID_CHARS: usize = 32;
const MAX_VERSION_CHARS: usize = 64;
/// Folders that are never vaults (or are too expensive / privacy-sensitive
/// to scan) when looking for existing vaults.
const SKIP_DIRS: &[&str] = &[
    "Library",
    "Applications",
    "Pictures",
    "Music",
    "Movies",
    "Public",
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "Pods",
    "DerivedData",
    "__pycache__",
    "venv",
];
/// Marker files of code projects; a folder with these is not a notes vault
/// (unless it is an Obsidian/NoPes vault, which is checked first).
const CODE_MARKERS: &[&str] = &[
    ".git",
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
];
/// Minimum number of top-level Markdown files for a "plain" vault.
const PLAIN_MIN_NOTES: usize = 5;
/// Upper bound for reported vaults.
const MAX_DETECTED_VAULTS: usize = 24;
/// Note counting stops here (keeps huge folders fast).
const NOTE_COUNT_CAP: usize = 100_000;
/// Files restored into the fresh data directory when the vault connection
/// is kept during a reset.
const KEEP_FOR_VAULT: &[&str] = &["config.json", VAULT_PREFS_FILE];
/// Minimum interval between two forwarded progress events of one pull.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);
/// How often a running pull checks for cancellation while Ollama is quiet.
const CANCEL_POLL: Duration = Duration::from_millis(250);

// ── Wizard state ────────────────────────────────────────────────

/// Persisted onboarding state (`<data_dir>/onboarding.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OnboardingState {
    /// RFC 3339 time the wizard was finished or skipped; `None` = first run.
    #[serde(default)]
    pub completed_at: Option<String>,
    /// App version whose "What's new" note the user has seen.
    #[serde(default)]
    pub version_seen: Option<String>,
    /// Wizard steps the user skipped (e.g. `"ai"`, `"embeddings"`).
    #[serde(default)]
    pub skipped_steps: Vec<String>,
}

impl OnboardingState {
    /// Validate and normalise a state received from the UI.
    pub fn validated(self) -> Result<Self, AetherError> {
        if let Some(at) = &self.completed_at {
            DateTime::parse_from_rfc3339(at).map_err(|e| {
                AetherError::InvalidInput(format!("completed_at is not an RFC 3339 time: {e}"))
            })?;
        }
        let version_seen = match self.version_seen {
            Some(v) => {
                let v = v.trim().to_owned();
                let valid = !v.is_empty()
                    && v.chars().count() <= MAX_VERSION_CHARS
                    && v.chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
                if !valid {
                    return Err(AetherError::InvalidInput(format!(
                        "version_seen is not a version: {v}"
                    )));
                }
                Some(v)
            }
            None => None,
        };
        let mut seen = HashSet::new();
        let mut skipped_steps = Vec::new();
        for step in self.skipped_steps {
            let step = step.trim().to_owned();
            let valid = !step.is_empty()
                && step.chars().count() <= MAX_STEP_ID_CHARS
                && step
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
            if !valid {
                return Err(AetherError::InvalidInput(format!(
                    "invalid wizard step id: {step}"
                )));
            }
            if seen.insert(step.clone()) {
                skipped_steps.push(step);
            }
        }
        if skipped_steps.len() > MAX_SKIPPED_STEPS {
            return Err(AetherError::InvalidInput(
                "too many skipped wizard steps".to_owned(),
            ));
        }
        Ok(Self {
            completed_at: self.completed_at,
            version_seen,
            skipped_steps,
        })
    }
}

// ── Vault preferences ───────────────────────────────────────────

/// Where daily notes live and how they are named (`vault_prefs.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultPrefs {
    /// Vault-relative folder for daily notes (`""` = vault root).
    pub daily_folder: String,
    /// File name pattern without `.md`; tokens `YYYY`, `MM`, `DD`. `/`
    /// separates sub-folders (`YYYY/MM/YYYY-MM-DD`), created on demand.
    pub daily_filename_pattern: String,
}

impl Default for VaultPrefs {
    /// Matches what the vault reader writes today: `daily/YYYY-MM-DD.md`.
    fn default() -> Self {
        Self {
            daily_folder: "daily".to_owned(),
            daily_filename_pattern: "YYYY-MM-DD".to_owned(),
        }
    }
}

impl VaultPrefs {
    /// Validate and normalise (trim, forward slashes, no trailing slash).
    pub fn validated(self) -> Result<Self, AetherError> {
        let folder = self
            .daily_folder
            .trim()
            .replace('\\', "/")
            .trim_matches('/')
            .to_owned();
        if folder.chars().count() > 120 {
            return Err(AetherError::InvalidInput(
                "daily note folder is too long".to_owned(),
            ));
        }
        if !folder.is_empty() {
            for segment in folder.split('/') {
                let bad = segment.is_empty()
                    || segment == "."
                    || segment == ".."
                    || segment.starts_with('.')
                    || segment.chars().any(|c| {
                        c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')
                    });
                if bad {
                    return Err(AetherError::InvalidInput(format!(
                        "invalid daily note folder: {folder}"
                    )));
                }
            }
        }

        let pattern = self.daily_filename_pattern.trim().to_owned();
        if pattern.is_empty() || pattern.chars().count() > 64 {
            return Err(AetherError::InvalidInput(
                "daily note file name pattern must be 1–64 characters".to_owned(),
            ));
        }
        for token in ["YYYY", "MM", "DD"] {
            if !pattern.contains(token) {
                return Err(AetherError::InvalidInput(format!(
                    "daily note file name pattern must contain {token}"
                )));
            }
        }
        let rest = pattern
            .replace("YYYY", "")
            .replace("MM", "")
            .replace("DD", "");
        if !rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '/'))
        {
            return Err(AetherError::InvalidInput(
                "daily note file name pattern may only contain letters, digits, spaces, '-', '_', '.' and '/'"
                    .to_owned(),
            ));
        }
        // `/` separates sub-folders: every segment must be a plain name.
        if pattern
            .split('/')
            .any(|segment| segment.trim().is_empty() || segment.starts_with('.'))
        {
            return Err(AetherError::InvalidInput(format!(
                "invalid daily note file name pattern: {pattern} (sub-folders must have a name and cannot start with '.')"
            )));
        }
        Ok(Self {
            daily_folder: folder,
            daily_filename_pattern: pattern,
        })
    }

    /// File name (with `.md`) of the daily note for `date`; contains `/` when
    /// the pattern has sub-folders.
    pub fn daily_file_name(&self, date: NaiveDate) -> String {
        let name = self
            .daily_filename_pattern
            .replace("YYYY", &date.format("%Y").to_string())
            .replace("MM", &date.format("%m").to_string())
            .replace("DD", &date.format("%d").to_string());
        format!("{name}.md")
    }

    /// Vault-relative path of the daily note for `date`.
    pub fn daily_rel_path(&self, date: NaiveDate) -> PathBuf {
        let mut path = PathBuf::new();
        if !self.daily_folder.is_empty() {
            path.extend(self.daily_folder.split('/'));
        }
        path.extend(self.daily_file_name(date).split('/'));
        path
    }

    /// Wikilink target of the daily note for `date` (no `.md`).
    fn daily_link(&self, date: NaiveDate) -> String {
        self.daily_rel_path(date)
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches(".md")
            .to_owned()
    }
}

/// Read `<data_dir>/vault_prefs.json`; defaults when missing, unreadable
/// JSON or invalid (a corrupt file must never break daily notes).
pub fn read_vault_prefs(data_dir: &Path) -> Result<VaultPrefs, AetherError> {
    let path = data_dir.join(VAULT_PREFS_FILE);
    if !path.exists() {
        return Ok(VaultPrefs::default());
    }
    let raw = fs::read_to_string(&path)?;
    Ok(serde_json::from_str::<VaultPrefs>(&raw)
        .ok()
        .and_then(|p| p.validated().ok())
        .unwrap_or_default())
}

// ── General preferences ─────────────────────────────────────────

/// General app preferences (`general_prefs.json`). Missing fields take
/// their defaults, so older files keep working.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GeneralPrefs {
    /// Ask before quitting while terminal sessions are still running.
    pub confirm_quit_with_terminals: bool,
}

impl Default for GeneralPrefs {
    fn default() -> Self {
        Self {
            confirm_quit_with_terminals: true,
        }
    }
}

// ── Engine ──────────────────────────────────────────────────────

/// Persistent onboarding state plus the registry of running model pulls.
pub struct OnboardingEngine {
    data_dir: PathBuf,
    pulls: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

/// A registered model pull. Dropping it unregisters the pull.
pub struct PullRegistration {
    name: String,
    cancel: Arc<AtomicBool>,
    pulls: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl PullRegistration {
    /// The cancellation flag checked by [`pull_model_at`].
    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }
}

impl Drop for PullRegistration {
    fn drop(&mut self) {
        if let Ok(mut pulls) = self.pulls.lock() {
            if pulls
                .get(&self.name)
                .is_some_and(|flag| Arc::ptr_eq(flag, &self.cancel))
            {
                pulls.remove(&self.name);
            }
        }
    }
}

impl OnboardingEngine {
    /// Open the engine on the app data directory (created if missing).
    pub fn new(data_dir: &Path) -> Result<Self, AetherError> {
        fs::create_dir_all(data_dir)?;
        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            pulls: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// The app data directory this engine works in.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Current wizard state; a missing or unreadable file means "first run".
    pub fn get_state(&self) -> Result<OnboardingState, AetherError> {
        let path = self.data_dir.join(STATE_FILE);
        if !path.exists() {
            return Ok(OnboardingState::default());
        }
        let raw = fs::read_to_string(&path)?;
        // A corrupt file must not lock the user out of the app: treat it as
        // a first run so the wizard can write a fresh one.
        Ok(serde_json::from_str::<OnboardingState>(&raw)
            .ok()
            .and_then(|s| s.validated().ok())
            .unwrap_or_default())
    }

    /// Validate and persist the wizard state; returns what was stored.
    pub fn set_state(&self, state: OnboardingState) -> Result<OnboardingState, AetherError> {
        let state = state.validated()?;
        write_json_atomic(&self.data_dir.join(STATE_FILE), &state)?;
        Ok(state)
    }

    /// Current vault preferences (defaults when unset or unreadable).
    pub fn get_vault_prefs(&self) -> Result<VaultPrefs, AetherError> {
        read_vault_prefs(&self.data_dir)
    }

    /// Validate and persist vault preferences; returns what was stored.
    pub fn set_vault_prefs(&self, prefs: VaultPrefs) -> Result<VaultPrefs, AetherError> {
        let prefs = prefs.validated()?;
        write_json_atomic(&self.data_dir.join(VAULT_PREFS_FILE), &prefs)?;
        Ok(prefs)
    }

    /// Current general preferences (defaults when unset or unreadable).
    pub fn get_general_prefs(&self) -> Result<GeneralPrefs, AetherError> {
        let path = self.data_dir.join(GENERAL_PREFS_FILE);
        if !path.exists() {
            return Ok(GeneralPrefs::default());
        }
        let raw = fs::read_to_string(&path)?;
        Ok(serde_json::from_str::<GeneralPrefs>(&raw).unwrap_or_default())
    }

    /// Persist general preferences; returns what was stored.
    pub fn set_general_prefs(&self, prefs: GeneralPrefs) -> Result<GeneralPrefs, AetherError> {
        write_json_atomic(&self.data_dir.join(GENERAL_PREFS_FILE), &prefs)?;
        Ok(prefs)
    }

    /// Register a pull of `name`. Fails when the same model is already
    /// downloading; the returned registration unregisters itself on drop.
    pub fn begin_pull(&self, name: &str) -> Result<PullRegistration, AetherError> {
        let name = validate_model_name(name)?;
        let mut pulls = self
            .pulls
            .lock()
            .map_err(|_| AetherError::AiEngine("pull registry is poisoned".to_owned()))?;
        if pulls.contains_key(&name) {
            return Err(AetherError::InvalidInput(format!(
                "{name} is already downloading"
            )));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        pulls.insert(name.clone(), cancel.clone());
        Ok(PullRegistration {
            name,
            cancel,
            pulls: self.pulls.clone(),
        })
    }

    /// Ask a running pull to stop. Returns whether one was running.
    pub fn cancel_pull(&self, name: &str) -> bool {
        let Ok(pulls) = self.pulls.lock() else {
            return false;
        };
        match pulls.get(name.trim()) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// Models currently downloading.
    #[cfg(test)]
    pub fn active_pulls(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .pulls
            .lock()
            .map(|p| p.keys().cloned().collect())
            .unwrap_or_default();
        names.sort();
        names
    }
}

/// Serialize `value` as pretty JSON and replace `path` atomically.
fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), AetherError> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| AetherError::InvalidInput(format!("cannot serialize settings: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

// ── Vaults: creation and detection ──────────────────────────────

/// What kind of notes folder a vault is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultKind {
    /// Has an `.obsidian/` folder.
    Obsidian,
    /// Has a `.nopes/` folder (NoPes index).
    Nopes,
    /// A folder of Markdown files without app metadata.
    Plain,
}

impl VaultKind {
    fn rank(self) -> u8 {
        match self {
            Self::Nopes => 0,
            Self::Obsidian => 1,
            Self::Plain => 2,
        }
    }
}

/// A vault on disk (detected or freshly created).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultInfo {
    pub path: String,
    /// Folder name.
    pub name: String,
    /// Markdown files, excluding hidden folders.
    pub note_count: usize,
    pub kind: VaultKind,
}

/// A folder to search for vaults, and how deep.
#[derive(Debug, Clone)]
pub struct ScanRoot {
    pub path: PathBuf,
    pub max_depth: usize,
}

/// Folders searched by the wizard: `~/Documents` and `~` (depth 2) plus
/// Obsidian's iCloud container on macOS (depth 1).
pub fn default_scan_roots(home: &Path) -> Vec<ScanRoot> {
    vec![
        ScanRoot {
            path: home.join("Documents"),
            max_depth: 2,
        },
        ScanRoot {
            path: home.to_path_buf(),
            max_depth: 2,
        },
        ScanRoot {
            path: home
                .join("Library")
                .join("Mobile Documents")
                .join("iCloud~md~obsidian")
                .join("Documents"),
            max_depth: 1,
        },
    ]
}

/// Resolve a user-chosen location for a new vault. It must be absolute,
/// free of `.`/`..` components and inside `allowed_root` (the home folder,
/// symlinks resolved), and must not be `allowed_root` itself.
pub fn resolve_new_vault_path(input: &str, allowed_root: &Path) -> Result<PathBuf, AetherError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AetherError::InvalidInput(
            "a folder for the new vault is required".to_owned(),
        ));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(AetherError::InvalidInput(format!(
            "the vault folder must be an absolute path: {trimmed}"
        )));
    }
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(AetherError::InvalidInput(format!(
            "the vault folder must not contain '.' or '..': {trimmed}"
        )));
    }
    let root = fs::canonicalize(allowed_root)?;

    // Canonicalize the deepest existing ancestor, then re-append the rest.
    let mut existing = path.as_path();
    let mut missing: Vec<&std::ffi::OsStr> = Vec::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .ok_or_else(|| AetherError::InvalidInput(format!("invalid vault folder: {trimmed}")))?;
        missing.push(name);
        existing = existing
            .parent()
            .ok_or_else(|| AetherError::InvalidInput(format!("invalid vault folder: {trimmed}")))?;
    }
    let mut resolved = fs::canonicalize(existing)?;
    for part in missing.iter().rev() {
        resolved.push(part);
    }
    if !resolved.starts_with(&root) || resolved == root {
        return Err(AetherError::InvalidInput(format!(
            "the new vault must be a folder inside your home folder ({})",
            root.display()
        )));
    }
    Ok(resolved)
}

/// A free location for a new vault: `~/Documents/AETHER Vault`, or
/// `AETHER Vault 2`, `3`, … when taken (an empty folder counts as free).
pub fn suggest_vault_path(home: &Path) -> PathBuf {
    let documents = home.join("Documents");
    let base = if documents.is_dir() {
        documents
    } else {
        home.to_path_buf()
    };
    let free = |p: &Path| !p.exists() || is_empty_dir(p);
    let first = base.join(DEFAULT_VAULT_NAME);
    if free(&first) {
        return first;
    }
    (2..1000)
        .map(|n| base.join(format!("{DEFAULT_VAULT_NAME} {n}")))
        .find(|p| free(p))
        .unwrap_or(first)
}

fn is_empty_dir(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

/// Create a starter vault at `target` (an empty or new folder): a
/// `Welcome` note, a `README` explaining wikilinks, tags and tasks, today's
/// daily note, an example project and a Markdown cheat sheet, plus the
/// `Projects/` and `Resources/` folders and the daily folder from `prefs`.
/// Never overwrites anything.
pub fn create_starter_vault(
    target: &Path,
    prefs: &VaultPrefs,
    today: NaiveDate,
) -> Result<VaultInfo, AetherError> {
    if target.exists() {
        if !target.is_dir() {
            return Err(AetherError::InvalidInput(format!(
                "a file already exists at {}",
                target.display()
            )));
        }
        if !is_empty_dir(target) {
            return Err(AetherError::InvalidInput(format!(
                "{} already exists and is not empty — choose a new or empty folder",
                target.display()
            )));
        }
    }
    fs::create_dir_all(target)?;
    for dir in ["Projects", "Resources"] {
        fs::create_dir_all(target.join(dir))?;
    }
    if !prefs.daily_folder.is_empty() {
        fs::create_dir_all(target.join(&prefs.daily_folder))?;
    }

    let files = starter_files(prefs, today);
    for (rel, content) in &files {
        let path = target.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(content.as_bytes())?;
    }

    Ok(VaultInfo {
        path: target.to_string_lossy().to_string(),
        name: folder_name(target),
        note_count: files.len(),
        kind: VaultKind::Plain,
    })
}

/// The starter notes (vault-relative path, Markdown content).
pub fn starter_files(prefs: &VaultPrefs, today: NaiveDate) -> Vec<(PathBuf, String)> {
    let date = today.format("%Y-%m-%d").to_string();
    let long_date = today.format("%A, %B %-d, %Y").to_string();
    let daily_link = prefs.daily_link(today);
    let soon = (today + chrono::Duration::days(3))
        .format("%Y-%m-%d")
        .to_string();
    let next_week = (today + chrono::Duration::days(7))
        .format("%Y-%m-%d")
        .to_string();
    let daily_location = if prefs.daily_folder.is_empty() {
        "the vault root".to_owned()
    } else {
        format!("`{}/`", prefs.daily_folder)
    };

    let welcome = format!(
        "---\ntags: [start-here]\ncreated: {date}\n---\n\n\
# Welcome to your vault\n\n\
This folder is your vault: plain Markdown files that AETHER-OS reads, links and searches. \
Everything stays on this machine — you can open the same folder in any editor.\n\n\
## Start here\n\n\
1. Read [[README]] — how links, tags and tasks work in two minutes.\n\
2. Open today's note: [[{daily_link}]].\n\
3. Look at the example project: [[Projects/Getting started]].\n\
4. Keep [[Resources/Markdown cheat sheet]] handy while you write.\n\n\
## Keyboard first\n\n\
| Action | Shortcut |\n| --- | --- |\n\
| Command palette — find anything | ⌘K |\n\
| Quick capture to today's note | ⌘⇧N |\n\
| New note | ⌘N |\n\
| Toggle the AI agent panel | ⌘J |\n\
| All shortcuts | ⌘/ |\n\n\
## Ask your notes\n\n\
Open the agent panel (⌘J) and ask a question. When semantic search is set up, \
AETHER finds the most relevant notes and answers with them as context — locally through Ollama \
unless you pick a cloud model.\n\n\
#start-here\n"
    );

    let readme = format!(
        "---\ntags: [guide]\ncreated: {date}\n---\n\n\
# How this vault works\n\n\
AETHER-OS understands a few simple Markdown conventions. None of them lock you in — \
they are plain text that other tools (Obsidian, NoPes, any editor) read as well.\n\n\
## Links: `[[wikilinks]]`\n\n\
- `[[Welcome]]` links to the note named *Welcome*. Folders are optional: `[[Projects/Getting started]]`.\n\
- `[[Welcome|start page]]` shows *start page* but links to *Welcome*.\n\
- Links are two-way: open the backlinks panel of a note to see every note that points to it.\n\
- The Graph view draws all links as a map of your knowledge.\n\n\
## Tags: `#tags`\n\n\
- Write `#idea`, `#reading` or nested tags like `#project/aether` anywhere in a line.\n\
- Or list them in the frontmatter at the top: `tags: [idea, reading]`.\n\
- Tags are counted in the vault stats and help semantic search group related notes.\n\n\
## Tasks: `- [ ]`\n\n\
- `- [ ] Call the dentist` is an open task, `- [x] Call the dentist` a finished one.\n\
- Add a due date with `📅 {soon}` (or `due: {soon}`).\n\
- Tasks can carry tags: `- [ ] Draft the outline #writing`.\n\n\
Try it — tick these off in the editor:\n\n\
- [ ] Create your first note with ⌘N\n\
- [ ] Capture a thought with ⌘⇧N — it lands in today's note\n\
- [ ] Ask the agent (⌘J) what this vault is about\n\n\
## Daily notes\n\n\
Quick capture (⌘⇧N) and the agent's \"add to today\" action append timestamped bullets to today's daily note \
in {daily_location}. Today's note is [[{daily_link}]].\n\n\
## Flashcards: `front :: back`\n\n\
A line like `Capital of France :: Paris` becomes a flashcard in NoPes.\n\n\
## Frontmatter\n\n\
The block between `---` lines at the top of a note holds metadata (`tags`, `created`, `status`, …).\n"
    );

    let daily = format!(
        "# {date}\n\n\
*{long_date}*\n\n\
## Focus\n\n\
- [ ] Finish setting up AETHER-OS 📅 {date}\n\
- [ ] Move one existing note into this vault\n\n\
## Log\n\n\
- Created this vault. Start with [[Welcome]].\n"
    );

    let project = format!(
        "---\ntags: [project]\nstatus: active\ncreated: {date}\n---\n\n\
# Getting started\n\n\
A project note collects the goal, the next actions and the links that belong together. \
Copy this note for your own projects.\n\n\
## Goal\n\n\
Get comfortable with AETHER-OS in the first week.\n\n\
## Next actions\n\n\
- [ ] Import or write five notes about something you are working on #project\n\
- [ ] Link them to each other with `[[wikilinks]]` 📅 {soon}\n\
- [ ] Index the vault and try a semantic search 📅 {soon}\n\
- [ ] Review the week in a daily note 📅 {next_week}\n\n\
## References\n\n\
- [[README]] — conventions\n\
- [[Resources/Markdown cheat sheet]]\n"
    );

    let cheat_sheet = "---\ntags: [reference]\n---\n\n\
# Markdown cheat sheet\n\n\
| You type | You get |\n| --- | --- |\n\
| `# Heading` / `## Subheading` | Headings |\n\
| `**bold**`, `*italic*`, `~~strike~~` | **bold**, *italic*, ~~strike~~ |\n\
| `- item` / `1. item` | Lists |\n\
| `- [ ] task` | A task |\n\
| `> quote` | A quote |\n\
| `` `code` `` | Inline code |\n\
| `[text](https://example.com)` | An external link |\n\
| `[[Note]]` | A link to another note |\n\
| `![alt](image.png)` | An image from the vault |\n\
| `---` | A divider |\n\n\
## Code blocks\n\n\
Wrap code in three backticks and name the language for highlighting:\n\n\
```ts\nconst greeting = \"hello vault\";\n```\n\n\
## Diagrams\n\n\
Mermaid diagrams render in the preview:\n\n\
```mermaid\nflowchart LR\n  Capture --> Link --> Review\n```\n\n\
## Tables\n\n\
| Column | Another |\n| --- | --- |\n| cell | cell |\n"
        .to_owned();

    vec![
        (PathBuf::from("Welcome.md"), welcome),
        (PathBuf::from("README.md"), readme),
        (prefs.daily_rel_path(today), daily),
        (
            PathBuf::from("Projects").join("Getting started.md"),
            project,
        ),
        (
            PathBuf::from("Resources").join("Markdown cheat sheet.md"),
            cheat_sheet,
        ),
    ]
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Classify a folder: NoPes (`.nopes/`), Obsidian (`.obsidian/`), a plain
/// Markdown folder (≥ 5 top-level `.md` files and no code-project markers),
/// or `None`.
pub fn classify_dir(dir: &Path) -> Option<VaultKind> {
    if dir.join(".nopes").is_dir() {
        return Some(VaultKind::Nopes);
    }
    if dir.join(".obsidian").is_dir() {
        return Some(VaultKind::Obsidian);
    }
    if CODE_MARKERS.iter().any(|m| dir.join(m).exists()) {
        return None;
    }
    let markdown = fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter(|e| is_markdown(&e.file_name().to_string_lossy()))
        .take(PLAIN_MIN_NOTES)
        .count();
    (markdown >= PLAIN_MIN_NOTES).then_some(VaultKind::Plain)
}

fn is_markdown(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".md") && !name.starts_with('.')
}

/// Count Markdown notes below `dir`, skipping hidden folders (like the vault
/// reader does). Stops counting at a large cap.
pub fn count_notes(dir: &Path) -> usize {
    WalkDir::new(dir)
        .max_depth(20)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_markdown(&e.file_name().to_string_lossy()))
        .take(NOTE_COUNT_CAP)
        .count()
}

/// Find existing vaults below `roots`. A vault's subfolders are not
/// reported separately; hidden and well-known non-vault folders are skipped;
/// duplicates (overlapping roots, symlinks) are removed. Sorted NoPes →
/// Obsidian → plain, then by note count (descending).
pub fn detect_vaults(roots: &[ScanRoot]) -> Vec<VaultInfo> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut found: Vec<VaultInfo> = Vec::new();
    for root in roots {
        if !root.path.is_dir() {
            continue;
        }
        let mut walker = WalkDir::new(&root.path)
            .min_depth(1)
            .max_depth(root.max_depth)
            .follow_links(false)
            .into_iter();
        while let Some(entry) = walker.next() {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                walker.skip_current_dir();
                continue;
            }
            let Some(kind) = classify_dir(entry.path()) else {
                continue;
            };
            walker.skip_current_dir();
            let canonical =
                fs::canonicalize(entry.path()).unwrap_or_else(|_| entry.path().to_path_buf());
            if !seen.insert(canonical.clone()) {
                continue;
            }
            found.push(VaultInfo {
                path: canonical.to_string_lossy().to_string(),
                name,
                note_count: count_notes(&canonical),
                kind,
            });
        }
    }
    found.sort_by(|a, b| {
        a.kind
            .rank()
            .cmp(&b.kind.rank())
            .then(b.note_count.cmp(&a.note_count))
            .then(a.path.cmp(&b.path))
    });
    found.truncate(MAX_DETECTED_VAULTS);
    found
}

// ── System profile ──────────────────────────────────────────────

/// Hardware facts used to recommend a local model.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SystemProfile {
    /// Installed memory in GiB, one decimal.
    pub total_ram_gb: f64,
    /// Logical CPU cores.
    pub cpu_cores: usize,
    pub physical_cores: Option<usize>,
    /// `aarch64`, `x86_64`, …
    pub arch: String,
    /// `macos`, `linux`, `windows`.
    pub os: String,
}

/// Read the system profile of this machine.
pub fn system_profile() -> SystemProfile {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let bytes = sys.total_memory() as f64;
    let total_ram_gb = (bytes / (1024.0 * 1024.0 * 1024.0) * 10.0).round() / 10.0;
    SystemProfile {
        total_ram_gb,
        cpu_cores: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        physical_cores: sys.physical_core_count(),
        arch: std::env::consts::ARCH.to_owned(),
        os: std::env::consts::OS.to_owned(),
    }
}

// ── Ollama pull ─────────────────────────────────────────────────

/// Payload of the `ollama-pull-progress` event.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PullProgress {
    /// Model being pulled.
    pub name: String,
    /// Ollama's status line (`pulling manifest`, `downloading sha256:…`,
    /// `verifying sha256 digest`, `writing manifest`, `success`).
    pub status: String,
    /// Bytes downloaded of the current layer.
    pub completed: Option<u64>,
    /// Size of the current layer in bytes.
    pub total: Option<u64>,
}

/// Result of a finished (or cancelled) pull.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PullOutcome {
    pub name: String,
    /// `true` when the user cancelled the download.
    pub cancelled: bool,
}

#[derive(Deserialize)]
struct PullLine {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    completed: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}

/// Validate an Ollama model name (`llama3.2:3b`, `nomic-embed-text`,
/// `hf.co/org/repo:Q4_K_M`). Returns the trimmed name.
pub fn validate_model_name(name: &str) -> Result<String, AetherError> {
    let name = name.trim();
    let valid = !name.is_empty()
        && name.len() <= 200
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
        && !name.contains("..")
        && !name.contains("//");
    if valid {
        Ok(name.to_owned())
    } else {
        Err(AetherError::InvalidInput(format!(
            "\"{name}\" is not a valid Ollama model name"
        )))
    }
}

fn pull_error_message(name: &str, error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("file does not exist") || lower.contains("not found") {
        format!("Ollama has no model called \"{name}\" — check the name on ollama.com/library")
    } else {
        format!("Ollama could not download {name}: {error}")
    }
}

/// Parse one NDJSON line of Ollama's `/api/pull` stream. Blank lines and
/// lines without a status yield `None`; `{"error": …}` becomes an error.
pub fn parse_pull_line(name: &str, line: &str) -> Result<Option<PullProgress>, AetherError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let parsed: PullLine = serde_json::from_str(trimmed).map_err(|e| {
        AetherError::AiEngine(format!("unexpected download response from Ollama: {e}"))
    })?;
    if let Some(error) = parsed.error {
        return Err(AetherError::AiEngine(pull_error_message(name, &error)));
    }
    Ok(parsed.status.map(|status| PullProgress {
        name: name.to_owned(),
        status,
        completed: parsed.completed,
        total: parsed.total,
    }))
}

/// Splits a byte stream into complete NDJSON lines, whatever the chunking.
#[derive(Debug, Default)]
pub struct NdjsonBuffer {
    pending: Vec<u8>,
}

impl NdjsonBuffer {
    /// Add a chunk; returns every line completed by it.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&line[..line.len() - 1])
                .trim()
                .to_owned();
            if !text.is_empty() {
                lines.push(text);
            }
        }
        lines
    }

    /// The unterminated last line, if any.
    pub fn finish(&mut self) -> Option<String> {
        let text = String::from_utf8_lossy(&self.pending).trim().to_owned();
        self.pending.clear();
        (!text.is_empty()).then_some(text)
    }
}

/// Decides which progress updates are forwarded to the UI: status changes
/// always, byte counters at most every [`PROGRESS_INTERVAL`].
#[derive(Debug, Default)]
pub struct ProgressThrottle {
    last_status: Option<String>,
    last_emit: Option<Instant>,
}

impl ProgressThrottle {
    /// Should `progress` be emitted at `now`?
    pub fn should_emit(&mut self, progress: &PullProgress, now: Instant) -> bool {
        let status_changed = self.last_status.as_deref() != Some(progress.status.as_str());
        let due = match self.last_emit {
            Some(at) => now.duration_since(at) >= PROGRESS_INTERVAL,
            None => true,
        };
        let finished_layer =
            matches!((progress.completed, progress.total), (Some(c), Some(t)) if c >= t);
        if status_changed || due || finished_layer {
            self.last_status = Some(progress.status.clone());
            self.last_emit = Some(now);
            true
        } else {
            false
        }
    }
}

/// Pull `name` from the Ollama instance at `endpoint`, calling `on_progress`
/// for (throttled) progress updates. Checks `cancel` at least every 250 ms.
pub async fn pull_model_at<F>(
    endpoint: &str,
    name: &str,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<PullOutcome, AetherError>
where
    F: FnMut(PullProgress) + Send,
{
    let name = validate_model_name(name)?;
    let cancelled = || PullOutcome {
        name: name.clone(),
        cancelled: true,
    };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .read_timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| AetherError::AiEngine(format!("cannot create HTTP client: {e}")))?;
    let response = client
        .post(format!("{endpoint}/api/pull"))
        .json(&serde_json::json!({ "model": name, "name": name, "stream": true }))
        .send()
        .await
        .map_err(|_| {
            AetherError::AiEngine(
                "Ollama is not reachable on localhost:11434. Start it with: ollama serve"
                    .to_owned(),
            )
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<PullLine>(&body)
            .ok()
            .and_then(|l| l.error)
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(AetherError::AiEngine(pull_error_message(&name, &detail)));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = NdjsonBuffer::default();
    let mut throttle = ProgressThrottle::default();
    let mut succeeded = false;
    let mut handle = |line: &str,
                      succeeded: &mut bool,
                      throttle: &mut ProgressThrottle|
     -> Result<(), AetherError> {
        if let Some(progress) = parse_pull_line(&name, line)? {
            if progress.status == "success" {
                *succeeded = true;
            }
            if throttle.should_emit(&progress, Instant::now()) {
                on_progress(progress);
            }
        }
        Ok(())
    };

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(cancelled());
        }
        let next = match tokio::time::timeout(CANCEL_POLL, stream.next()).await {
            Ok(next) => next,
            Err(_) => continue,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| {
            AetherError::AiEngine(format!(
                "the connection to Ollama was lost while downloading {name}: {e}"
            ))
        })?;
        for line in buffer.push(&chunk) {
            handle(&line, &mut succeeded, &mut throttle)?;
        }
    }
    if let Some(line) = buffer.finish() {
        handle(&line, &mut succeeded, &mut throttle)?;
    }
    if cancel.load(Ordering::SeqCst) {
        return Ok(cancelled());
    }
    if !succeeded {
        return Err(AetherError::AiEngine(format!(
            "Ollama stopped before {name} finished downloading — try again"
        )));
    }
    Ok(PullOutcome {
        name,
        cancelled: false,
    })
}

// ── Data directory: locations, log, reset ──────────────────────

/// One top-level entry of the app data directory.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DataLocation {
    /// File or folder name.
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Total size in bytes (recursive for folders).
    pub size_bytes: u64,
    /// What AETHER-OS keeps there.
    pub description: String,
}

fn describe_entry(name: &str) -> &'static str {
    match name {
        "config.json" => "Vault connection (which folder AETHER-OS reads)",
        "ai" => "AI provider settings, including the OpenRouter key",
        "vectors" => "Semantic search index (embeddings of your notes)",
        "aether" => "Saved AI answers (AI Notes)",
        "memory" => "Agent memory facts and recent conversations",
        "calendar" => "Calendar events and reminder settings",
        "tasks" => "Task projects and issues",
        "logs" => "Application log (rotates at 5 MB, keeps 3 old files)",
        "crash-reports" => "Local crash reports",
        STATE_FILE => "Setup wizard progress",
        VAULT_PREFS_FILE => "Daily note folder and file name pattern",
        GENERAL_PREFS_FILE => "General preferences (quit confirmation)",
        "clipboard" => "Clipboard history",
        "search" => "Universal search index",
        "history" => "Note version history",
        "home" | "focus" => "Home dashboard pins and focus sessions",
        "vaulttasks" => "Vault task index",
        "intel" => "AI suggestions and approvals",
        "plugins" => "Installed plugins",
        "export" => "Export and publish settings",
        "sync" | "backup" => "Backup and sync settings",
        _ => "Created by AETHER-OS",
    }
}

fn dir_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Top-level files and folders of the data directory with sizes and a short
/// description, folders first, then by name.
pub fn data_locations(data_dir: &Path) -> Result<Vec<DataLocation>, AetherError> {
    let mut out = Vec::new();
    for entry in fs::read_dir(data_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".DS_Store" || name.ends_with(".tmp") {
            continue;
        }
        let file_type = entry.file_type()?;
        let path = entry.path();
        let size_bytes = if file_type.is_dir() {
            dir_size(&path)
        } else {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        };
        out.push(DataLocation {
            description: describe_entry(&name).to_owned(),
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
            size_bytes,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// The end of the application log.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppLogTail {
    pub path: String,
    /// The last lines of the log (whole lines only).
    pub content: String,
    /// Size of the whole log file in bytes.
    pub size_bytes: u64,
    /// `true` when older lines were cut off.
    pub truncated: bool,
}

/// Read up to `max_bytes` (clamped to 1 KiB–1 MiB) from the end of
/// `<data_dir>/logs/aether.log`. A missing log yields empty content.
pub fn read_log_tail(data_dir: &Path, max_bytes: u64) -> Result<AppLogTail, AetherError> {
    let path = data_dir.join("logs").join("aether.log");
    let display = path.to_string_lossy().to_string();
    if !path.is_file() {
        return Ok(AppLogTail {
            path: display,
            content: String::new(),
            size_bytes: 0,
            truncated: false,
        });
    }
    let max = max_bytes.clamp(1024, 1024 * 1024);
    let mut file = fs::File::open(&path)?;
    let size = file.metadata()?.len();
    let truncated = size > max;
    if truncated {
        file.seek(SeekFrom::Start(size - max))?;
    }
    let mut bytes = Vec::with_capacity(max.min(size) as usize);
    file.take(max).read_to_end(&mut bytes)?;
    let mut content = String::from_utf8_lossy(&bytes).to_string();
    if truncated {
        // Drop the partial first line.
        content = match content.find('\n') {
            Some(pos) => content[pos + 1..].to_owned(),
            None => String::new(),
        };
    }
    // Lines written before redaction existed must not leak either.
    let content = crate::engine::diagnostics::redact_secrets(&content).into_owned();
    Ok(AppLogTail {
        path: display,
        content,
        size_bytes: size,
        truncated,
    })
}

/// Result of [`reset_app_data`].
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ResetOutcome {
    /// Where the previous data directory now lives.
    pub backup_path: String,
    /// Files copied back into the fresh data directory.
    pub kept: Vec<String>,
    /// Whether the app restarts on its own.
    pub restarting: bool,
}

/// Move `data_dir` to `<data_dir>-backup-<YYYYMMDD-HHMMSS>` (with a counter
/// if taken) and recreate it empty. With `keep_vault`, the vault connection
/// (`config.json`) and vault preferences are copied back. The vault folder
/// itself is never touched. Returns the backup path and the kept files.
pub fn reset_app_data(
    data_dir: &Path,
    keep_vault: bool,
    now: DateTime<Local>,
) -> Result<(PathBuf, Vec<String>), AetherError> {
    if !data_dir.is_dir() {
        return Err(AetherError::InvalidInput(format!(
            "app data directory not found: {}",
            data_dir.display()
        )));
    }
    let name = data_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| AetherError::InvalidInput("refusing to reset this folder".to_owned()))?;
    let parent = data_dir
        .parent()
        .filter(|p| p.components().count() >= 2)
        .ok_or_else(|| {
            AetherError::InvalidInput(format!(
                "refusing to reset a top-level folder: {}",
                data_dir.display()
            ))
        })?;

    let stamp = now.format("%Y%m%d-%H%M%S").to_string();
    let base = parent.join(format!("{name}-backup-{stamp}"));
    let mut backup = base.clone();
    let mut n = 2;
    while backup.exists() {
        backup = PathBuf::from(format!("{}-{n}", base.display()));
        n += 1;
    }
    fs::rename(data_dir, &backup)?;
    fs::create_dir_all(data_dir)?;

    let mut kept = Vec::new();
    if keep_vault {
        for file in KEEP_FOR_VAULT {
            let from = backup.join(file);
            if from.is_file() {
                fs::copy(&from, data_dir.join(file))?;
                kept.push((*file).to_owned());
            }
        }
    }
    Ok((backup, kept))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::net::TcpListener;
    use tempfile::tempdir;

    fn day(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("valid date")
    }

    // ── state ──

    #[test]
    fn state_defaults_to_first_run_and_round_trips() {
        let dir = tempdir().expect("tmp");
        let engine = OnboardingEngine::new(dir.path()).expect("engine");
        assert_eq!(engine.get_state().expect("get"), OnboardingState::default());

        let stored = engine
            .set_state(OnboardingState {
                completed_at: Some("2026-09-22T10:00:00+02:00".to_owned()),
                version_seen: Some(" 0.2.0 ".to_owned()),
                skipped_steps: vec!["ai".into(), "embeddings".into(), "ai".into()],
            })
            .expect("set");
        assert_eq!(stored.version_seen.as_deref(), Some("0.2.0"));
        assert_eq!(stored.skipped_steps, vec!["ai", "embeddings"]);

        let reopened = OnboardingEngine::new(dir.path()).expect("reopen");
        assert_eq!(reopened.get_state().expect("get"), stored);
        assert!(dir.path().join(STATE_FILE).is_file());
        assert!(!dir.path().join("onboarding.json.tmp").exists());
    }

    #[test]
    fn invalid_state_is_rejected_and_corrupt_files_mean_first_run() {
        let dir = tempdir().expect("tmp");
        let engine = OnboardingEngine::new(dir.path()).expect("engine");
        let bad_time = OnboardingState {
            completed_at: Some("yesterday".into()),
            ..Default::default()
        };
        assert!(engine.set_state(bad_time).is_err());
        let bad_step = OnboardingState {
            skipped_steps: vec!["../etc".into()],
            ..Default::default()
        };
        assert!(engine.set_state(bad_step).is_err());
        let bad_version = OnboardingState {
            version_seen: Some("1.0 beta; rm".into()),
            ..Default::default()
        };
        assert!(engine.set_state(bad_version).is_err());

        fs::write(dir.path().join(STATE_FILE), "{ not json").expect("write");
        assert_eq!(engine.get_state().expect("get"), OnboardingState::default());
    }

    // ── vault prefs ──

    #[test]
    fn vault_prefs_default_validate_and_persist() {
        let dir = tempdir().expect("tmp");
        let engine = OnboardingEngine::new(dir.path()).expect("engine");
        assert_eq!(
            engine.get_vault_prefs().expect("get"),
            VaultPrefs::default()
        );

        let stored = engine
            .set_vault_prefs(VaultPrefs {
                daily_folder: "/Journal/Daily/".into(),
                daily_filename_pattern: "DD.MM.YYYY".into(),
            })
            .expect("set");
        assert_eq!(stored.daily_folder, "Journal/Daily");
        assert_eq!(stored.daily_file_name(day(2026, 9, 2)), "02.09.2026.md");
        assert_eq!(engine.get_vault_prefs().expect("get"), stored);

        for (folder, pattern) in [
            ("../outside", "YYYY-MM-DD"),
            (".hidden", "YYYY-MM-DD"),
            ("daily", "YYYY-MM"),
            ("daily", "YYYY/../MM-DD"),
            ("daily", "/YYYY-MM-DD"),
            ("daily", "YYYY//MM-DD"),
            ("daily", "YYYY/.MM-DD"),
            ("daily", "YYYY\\MM\\DD"),
            ("a:b", "YYYY-MM-DD"),
        ] {
            let result = VaultPrefs {
                daily_folder: folder.into(),
                daily_filename_pattern: pattern.into(),
            }
            .validated();
            assert!(result.is_err(), "{folder} / {pattern} must be rejected");
        }
        let root = VaultPrefs {
            daily_folder: "".into(),
            daily_filename_pattern: "YYYY-MM-DD".into(),
        }
        .validated()
        .expect("root folder is allowed");
        assert_eq!(
            root.daily_rel_path(day(2026, 1, 5)),
            PathBuf::from("2026-01-05.md")
        );
    }

    #[test]
    fn vault_prefs_accept_nested_patterns() {
        let nested = VaultPrefs {
            daily_folder: "Journal".into(),
            daily_filename_pattern: " YYYY/MM/YYYY-MM-DD ".into(),
        }
        .validated()
        .expect("nested pattern is allowed");
        assert_eq!(nested.daily_filename_pattern, "YYYY/MM/YYYY-MM-DD");
        assert_eq!(
            nested.daily_rel_path(day(2026, 9, 23)),
            PathBuf::from("Journal")
                .join("2026")
                .join("09")
                .join("2026-09-23.md")
        );
        assert_eq!(
            nested.daily_link(day(2026, 9, 23)),
            "Journal/2026/09/2026-09-23"
        );

        let by_day = VaultPrefs {
            daily_folder: "".into(),
            daily_filename_pattern: "YYYY/MM/DD".into(),
        }
        .validated()
        .expect("YYYY/MM/DD is allowed");
        assert_eq!(
            by_day.daily_rel_path(day(2026, 1, 5)),
            PathBuf::from("2026").join("01").join("05.md")
        );
    }

    // ── general prefs ──

    #[test]
    fn general_prefs_default_to_confirming_and_persist() {
        let dir = tempdir().expect("tmp");
        let engine = OnboardingEngine::new(dir.path()).expect("engine");
        assert!(
            engine
                .get_general_prefs()
                .expect("get")
                .confirm_quit_with_terminals
        );

        let stored = engine
            .set_general_prefs(GeneralPrefs {
                confirm_quit_with_terminals: false,
            })
            .expect("set");
        assert!(!stored.confirm_quit_with_terminals);
        let reopened = OnboardingEngine::new(dir.path()).expect("engine");
        assert_eq!(reopened.get_general_prefs().expect("get"), stored);

        // Missing fields and corrupt files fall back to the defaults.
        fs::write(dir.path().join(GENERAL_PREFS_FILE), "{}").expect("write");
        assert_eq!(
            engine.get_general_prefs().expect("get"),
            GeneralPrefs::default()
        );
        fs::write(dir.path().join(GENERAL_PREFS_FILE), "{ nope").expect("write");
        assert_eq!(
            engine.get_general_prefs().expect("get"),
            GeneralPrefs::default()
        );
    }

    // ── starter vault ──

    #[test]
    fn creates_the_starter_vault_layout() {
        let home = tempdir().expect("home");
        let target = resolve_new_vault_path(
            &home
                .path()
                .join("Documents")
                .join("AETHER Vault")
                .to_string_lossy(),
            home.path(),
        )
        .expect("resolve");
        let info = create_starter_vault(&target, &VaultPrefs::default(), day(2026, 9, 22))
            .expect("create");

        assert_eq!(info.name, "AETHER Vault");
        assert_eq!(info.kind, VaultKind::Plain);
        assert_eq!(info.note_count, 5);
        for rel in [
            "Welcome.md",
            "README.md",
            "daily/2026-09-22.md",
            "Projects/Getting started.md",
            "Resources/Markdown cheat sheet.md",
        ] {
            assert!(target.join(rel).is_file(), "missing {rel}");
        }
        assert!(target.join("Projects").is_dir());
        assert!(target.join("Resources").is_dir());
        assert_eq!(count_notes(&target), 5);

        let welcome = fs::read_to_string(target.join("Welcome.md")).expect("welcome");
        assert!(welcome.contains("[[README]]"));
        assert!(welcome.contains("[[daily/2026-09-22]]"));
        let readme = fs::read_to_string(target.join("README.md")).expect("readme");
        for needle in ["[[wikilinks]]", "#tags", "- [ ]", "📅 2026-09-25"] {
            assert!(readme.contains(needle), "README lacks {needle}");
        }
        let project =
            fs::read_to_string(target.join("Projects/Getting started.md")).expect("project");
        assert!(project.contains("📅 2026-09-29"));
    }

    #[test]
    fn starter_vault_uses_the_daily_prefs_and_never_clobbers() {
        let home = tempdir().expect("home");
        let prefs = VaultPrefs {
            daily_folder: "Journal".into(),
            daily_filename_pattern: "YYYY.MM.DD".into(),
        };
        let target = home.path().join("Notes");
        create_starter_vault(&target, &prefs, day(2026, 3, 4)).expect("create");
        assert!(target.join("Journal/2026.03.04.md").is_file());
        let welcome = fs::read_to_string(target.join("Welcome.md")).expect("welcome");
        assert!(welcome.contains("[[Journal/2026.03.04]]"));

        let err = create_starter_vault(&target, &prefs, day(2026, 3, 4)).expect_err("non-empty");
        assert!(err.to_string().contains("not empty"));

        let file = home.path().join("file.md");
        fs::write(&file, "x").expect("write");
        assert!(create_starter_vault(&file, &prefs, day(2026, 3, 4)).is_err());

        let empty = home.path().join("Empty");
        fs::create_dir(&empty).expect("mkdir");
        create_starter_vault(&empty, &prefs, day(2026, 3, 4)).expect("empty folders are fine");
    }

    #[test]
    fn new_vault_paths_must_stay_inside_home() {
        let home = tempdir().expect("home");
        let outside = tempdir().expect("outside");
        let ok = resolve_new_vault_path(
            &home.path().join("Documents/Vault").to_string_lossy(),
            home.path(),
        )
        .expect("inside");
        assert!(ok.ends_with("Documents/Vault"));

        for bad in [
            String::new(),
            "relative/vault".to_owned(),
            home.path().join("../escape").to_string_lossy().to_string(),
            outside.path().join("Vault").to_string_lossy().to_string(),
            home.path().to_string_lossy().to_string(),
        ] {
            assert!(
                resolve_new_vault_path(&bad, home.path()).is_err(),
                "{bad} must be rejected"
            );
        }

        #[cfg(unix)]
        {
            let link = home.path().join("link");
            std::os::unix::fs::symlink(outside.path(), &link).expect("symlink");
            assert!(
                resolve_new_vault_path(&link.join("Vault").to_string_lossy(), home.path()).is_err(),
                "symlinks out of home must be rejected"
            );
        }
    }

    #[test]
    fn suggests_a_free_vault_folder() {
        let home = tempdir().expect("home");
        assert_eq!(
            suggest_vault_path(home.path()),
            home.path().join(DEFAULT_VAULT_NAME)
        );
        fs::create_dir(home.path().join("Documents")).expect("docs");
        let first = home.path().join("Documents").join(DEFAULT_VAULT_NAME);
        assert_eq!(suggest_vault_path(home.path()), first);
        fs::create_dir(&first).expect("mkdir");
        assert_eq!(
            suggest_vault_path(home.path()),
            first,
            "empty folder is free"
        );
        fs::write(first.join("note.md"), "x").expect("write");
        assert_eq!(
            suggest_vault_path(home.path()),
            home.path().join("Documents").join("AETHER Vault 2")
        );
    }

    // ── detection ──

    fn touch_notes(dir: &Path, n: usize) {
        fs::create_dir_all(dir).expect("mkdir");
        for i in 0..n {
            fs::write(dir.join(format!("note {i}.md")), "# note").expect("write");
        }
    }

    #[test]
    fn classifies_vault_kinds() {
        let root = tempdir().expect("root");
        let obsidian = root.path().join("Obsidian");
        touch_notes(&obsidian, 1);
        fs::create_dir(obsidian.join(".obsidian")).expect("mkdir");
        let nopes = root.path().join("Nopes");
        fs::create_dir_all(nopes.join(".nopes")).expect("mkdir");
        let plain = root.path().join("Plain");
        touch_notes(&plain, 5);
        let few = root.path().join("Few");
        touch_notes(&few, 4);
        let code = root.path().join("Code");
        touch_notes(&code, 8);
        fs::write(code.join("package.json"), "{}").expect("write");

        assert_eq!(classify_dir(&obsidian), Some(VaultKind::Obsidian));
        assert_eq!(classify_dir(&nopes), Some(VaultKind::Nopes));
        assert_eq!(classify_dir(&plain), Some(VaultKind::Plain));
        assert_eq!(classify_dir(&few), None);
        assert_eq!(classify_dir(&code), None);
    }

    #[test]
    fn detects_vaults_without_nested_duplicates_or_hidden_folders() {
        let home = tempdir().expect("home");
        let docs = home.path().join("Documents");
        let obsidian = docs.join("Research");
        touch_notes(&obsidian.join("Papers"), 3);
        touch_notes(&obsidian, 2);
        fs::create_dir_all(obsidian.join(".obsidian")).expect("mkdir");
        // A nested "plain" folder inside the Obsidian vault is not reported.
        touch_notes(&obsidian.join("Inbox"), 6);
        let plain = docs.join("Notes").join("Zettel");
        touch_notes(&plain, 7);
        touch_notes(&home.path().join(".hidden").join("Secret"), 9);
        touch_notes(&home.path().join("Library").join("Stuff"), 9);
        // Too deep for depth 2 below Documents.
        touch_notes(&docs.join("a").join("b").join("c"), 9);

        let found = detect_vaults(&default_scan_roots(home.path()));
        let names: Vec<(&str, VaultKind, usize)> = found
            .iter()
            .map(|v| (v.name.as_str(), v.kind, v.note_count))
            .collect();
        assert_eq!(
            names,
            vec![
                ("Research", VaultKind::Obsidian, 11),
                ("Zettel", VaultKind::Plain, 7)
            ]
        );
    }

    #[test]
    fn detects_nothing_in_missing_roots() {
        let found = detect_vaults(&[ScanRoot {
            path: PathBuf::from("/definitely/not/here"),
            max_depth: 2,
        }]);
        assert!(found.is_empty());
    }

    // ── system profile ──

    #[test]
    fn reads_a_plausible_system_profile() {
        let profile = system_profile();
        assert!(profile.total_ram_gb > 0.0);
        assert!(profile.cpu_cores >= 1);
        assert!(!profile.arch.is_empty());
        assert_eq!(profile.os, std::env::consts::OS);
    }

    // ── pull parsing ──

    #[test]
    fn validates_model_names() {
        for ok in ["llama3.2:3b", "nomic-embed-text", "hf.co/org/repo:Q4_K_M"] {
            assert_eq!(validate_model_name(ok).expect(ok), ok);
        }
        for bad in ["", " ", "-rf", "a b", "../x", "a//b", "x;rm", "ü"] {
            assert!(
                validate_model_name(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn parses_pull_progress_lines() {
        let p = parse_pull_line(
            "m",
            r#"{"status":"downloading sha256:abc","digest":"sha256:abc","total":100,"completed":40}"#,
        )
        .expect("parse")
        .expect("progress");
        assert_eq!(
            p,
            PullProgress {
                name: "m".into(),
                status: "downloading sha256:abc".into(),
                completed: Some(40),
                total: Some(100),
            }
        );
        let manifest = parse_pull_line("m", r#"{"status":"pulling manifest"}"#)
            .expect("parse")
            .expect("progress");
        assert_eq!(manifest.completed, None);
        assert_eq!(parse_pull_line("m", "   ").expect("blank"), None);
        assert_eq!(parse_pull_line("m", "{}").expect("no status"), None);

        let err = parse_pull_line(
            "nope",
            r#"{"error":"pull model manifest: file does not exist"}"#,
        )
        .expect_err("error line");
        assert!(err.to_string().contains("no model called \"nope\""));
        assert!(parse_pull_line("m", "not json").is_err());
    }

    #[test]
    fn ndjson_buffer_reassembles_split_lines() {
        let mut buffer = NdjsonBuffer::default();
        assert!(buffer.push(b"{\"status\":\"pul").is_empty());
        assert_eq!(
            buffer.push(b"ling manifest\"}\n{\"status\":\"a\"}\n\n{\"sta"),
            vec![r#"{"status":"pulling manifest"}"#, r#"{"status":"a"}"#]
        );
        assert_eq!(buffer.push(b"tus\":\"b\"}"), Vec::<String>::new());
        assert_eq!(buffer.finish().as_deref(), Some(r#"{"status":"b"}"#));
        assert_eq!(buffer.finish(), None);
    }

    #[test]
    fn throttles_byte_progress_but_not_status_changes() {
        let mut throttle = ProgressThrottle::default();
        let at = Instant::now();
        let progress = |status: &str, completed: u64| PullProgress {
            name: "m".into(),
            status: status.into(),
            completed: Some(completed),
            total: Some(100),
        };
        assert!(throttle.should_emit(&progress("downloading", 1), at));
        assert!(!throttle.should_emit(&progress("downloading", 2), at + Duration::from_millis(10)));
        assert!(throttle.should_emit(&progress("downloading", 3), at + Duration::from_millis(200)));
        assert!(throttle.should_emit(&progress("verifying", 3), at + Duration::from_millis(201)));
        assert!(
            throttle.should_emit(&progress("verifying", 100), at + Duration::from_millis(202)),
            "a finished layer is always reported"
        );
    }

    /// Serve one streamed NDJSON response (chunked, split mid-line) on a
    /// random local port and return the endpoint.
    fn serve_ndjson(status_line: &'static str, chunks: Vec<&'static str>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let head = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(head.as_bytes());
                for chunk in chunks {
                    let _ =
                        stream.write_all(format!("{:x}\r\n{chunk}\r\n", chunk.len()).as_bytes());
                    let _ = stream.flush();
                    std::thread::sleep(Duration::from_millis(5));
                }
                let _ = stream.write_all(b"0\r\n\r\n");
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn pulls_against_a_fake_ndjson_stream() {
        let endpoint = serve_ndjson(
            "200 OK",
            vec![
                "{\"status\":\"pulling manifest\"}\n{\"status\":\"downloading sha256:1\",\"total\":200,",
                "\"completed\":50}\n{\"status\":\"downloading sha256:1\",\"total\":200,\"completed\":200}\n",
                "{\"status\":\"verifying sha256 digest\"}\n{\"status\":\"writing manifest\"}\n",
                "{\"status\":\"success\"}",
            ],
        );
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        let outcome = pull_model_at(&endpoint, "tiny:1b", &cancel, |p| events.push(p))
            .await
            .expect("pull");
        assert_eq!(
            outcome,
            PullOutcome {
                name: "tiny:1b".into(),
                cancelled: false
            }
        );
        let statuses: Vec<&str> = events.iter().map(|e| e.status.as_str()).collect();
        assert_eq!(statuses.first(), Some(&"pulling manifest"));
        assert_eq!(statuses.last(), Some(&"success"));
        assert!(events
            .iter()
            .any(|e| e.completed == Some(200) && e.total == Some(200)));
        assert!(events.iter().all(|e| e.name == "tiny:1b"));
    }

    #[tokio::test]
    async fn pull_errors_are_readable() {
        let endpoint = serve_ndjson(
            "200 OK",
            vec!["{\"status\":\"pulling manifest\"}\n{\"error\":\"pull model manifest: file does not exist\"}\n"],
        );
        let cancel = AtomicBool::new(false);
        let err = pull_model_at(&endpoint, "nope", &cancel, |_| ())
            .await
            .expect_err("unknown model");
        assert!(
            err.to_string().contains("no model called \"nope\""),
            "{err}"
        );

        let endpoint = serve_ndjson(
            "500 Internal Server Error",
            vec!["{\"error\":\"disk full\"}"],
        );
        let err = pull_model_at(&endpoint, "big", &cancel, |_| ())
            .await
            .expect_err("server error");
        assert!(err.to_string().contains("disk full"), "{err}");

        let endpoint = serve_ndjson("200 OK", vec!["{\"status\":\"pulling manifest\"}\n"]);
        let err = pull_model_at(&endpoint, "cut", &cancel, |_| ())
            .await
            .expect_err("truncated stream");
        assert!(err.to_string().contains("stopped before"), "{err}");
    }

    #[tokio::test]
    async fn offline_ollama_and_bad_names_fail_fast() {
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        let cancel = AtomicBool::new(false);
        let err = pull_model_at(&format!("http://127.0.0.1:{port}"), "m", &cancel, |_| ())
            .await
            .expect_err("offline");
        assert!(err.to_string().contains("ollama serve"), "{err}");
        let err = pull_model_at("http://127.0.0.1:9", "bad name", &cancel, |_| ())
            .await
            .expect_err("invalid");
        assert!(matches!(err, AetherError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn cancelled_pulls_report_cancelled() {
        let endpoint = serve_ndjson(
            "200 OK",
            vec![
                "{\"status\":\"pulling manifest\"}\n",
                "{\"status\":\"success\"}\n",
            ],
        );
        let cancel = AtomicBool::new(true);
        let outcome = pull_model_at(&endpoint, "m", &cancel, |_| ())
            .await
            .expect("cancel");
        assert!(outcome.cancelled);
    }

    #[test]
    fn pull_registry_rejects_duplicates_and_cancels() {
        let dir = tempdir().expect("tmp");
        let engine = OnboardingEngine::new(dir.path()).expect("engine");
        let first = engine.begin_pull("llama3.2:3b").expect("begin");
        assert!(engine.begin_pull("llama3.2:3b").is_err());
        assert_eq!(engine.active_pulls(), vec!["llama3.2:3b"]);
        assert!(engine.cancel_pull("llama3.2:3b"));
        assert!(first.cancel_flag().load(Ordering::SeqCst));
        drop(first);
        assert!(engine.active_pulls().is_empty());
        assert!(!engine.cancel_pull("llama3.2:3b"));
        assert!(engine.begin_pull("bad name").is_err());
    }

    // ── data dir ──

    #[test]
    fn reset_moves_the_data_dir_and_keeps_the_vault_connection() {
        let root = tempdir().expect("root");
        let data = root.path().join("Application Support").join("com.test.app");
        fs::create_dir_all(data.join("memory")).expect("mkdir");
        fs::write(data.join("memory/facts.json"), "[]").expect("write");
        fs::write(data.join("config.json"), r#"{"vault_path":"/v"}"#).expect("write");
        fs::write(data.join(STATE_FILE), "{}").expect("write");

        let now = Local
            .with_ymd_and_hms(2026, 9, 22, 23, 15, 0)
            .single()
            .expect("time");
        let (backup, kept) = reset_app_data(&data, true, now).expect("reset");
        assert_eq!(
            backup,
            root.path()
                .join("Application Support")
                .join("com.test.app-backup-20260922-231500")
        );
        assert!(backup.join("memory/facts.json").is_file());
        assert!(backup.join(STATE_FILE).is_file());
        assert_eq!(kept, vec!["config.json"]);
        assert!(data.join("config.json").is_file());
        assert!(!data.join("memory").exists());
        assert!(!data.join(STATE_FILE).exists());

        // Second reset in the same second gets a counter; nothing is kept.
        fs::write(data.join("x.json"), "1").expect("write");
        let (second, kept) = reset_app_data(&data, false, now).expect("reset again");
        assert!(second
            .to_string_lossy()
            .ends_with("-backup-20260922-231500-2"));
        assert!(kept.is_empty());
        assert!(fs::read_dir(&data).expect("read").next().is_none());

        assert!(reset_app_data(&root.path().join("missing"), false, now).is_err());
    }

    #[test]
    fn lists_data_locations_with_sizes() {
        let dir = tempdir().expect("tmp");
        fs::create_dir_all(dir.path().join("memory")).expect("mkdir");
        fs::write(dir.path().join("memory/a.json"), "12345").expect("write");
        fs::write(dir.path().join("config.json"), "{}").expect("write");
        fs::write(dir.path().join(".DS_Store"), "x").expect("write");
        let locations = data_locations(dir.path()).expect("list");
        let names: Vec<&str> = locations.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, vec!["memory", "config.json"]);
        assert_eq!(locations[0].size_bytes, 5);
        assert!(locations[0].is_dir);
        assert!(locations[1].description.contains("Vault"));
    }

    #[test]
    fn reads_the_log_tail_by_whole_lines() {
        let dir = tempdir().expect("tmp");
        let empty = read_log_tail(dir.path(), 4096).expect("missing log");
        assert!(empty.content.is_empty());
        assert_eq!(empty.size_bytes, 0);

        fs::create_dir_all(dir.path().join("logs")).expect("mkdir");
        let lines: Vec<String> = (0..200)
            .map(|i| format!("line {i:03} {}", "x".repeat(20)))
            .collect();
        fs::write(dir.path().join("logs/aether.log"), lines.join("\n") + "\n").expect("write");
        let tail = read_log_tail(dir.path(), 1024).expect("tail");
        assert!(tail.truncated);
        assert!(tail.content.ends_with("line 199 xxxxxxxxxxxxxxxxxxxx\n"));
        assert!(tail.content.starts_with("line "), "starts at a whole line");
        assert!(tail.content.len() <= 1024);

        let full = read_log_tail(dir.path(), 10 * 1024 * 1024).expect("full");
        assert!(!full.truncated);
        assert!(full.content.starts_with("line 000"));
    }

    #[test]
    fn the_log_tail_never_shows_api_keys() {
        let dir = tempdir().expect("tmp");
        fs::create_dir_all(dir.path().join("logs")).expect("mkdir");
        let key = "sk-or-v1-00112233445566778899aabbccddeeff";
        fs::write(
            dir.path().join("logs/aether.log"),
            format!("old line with {key}\n"),
        )
        .expect("write");
        let tail = read_log_tail(dir.path(), 4096).expect("tail");
        assert!(!tail.content.contains(key), "{}", tail.content);
        assert!(tail.content.contains("sk-[REDACTED]"));
    }

    #[test]
    fn bundles_the_changelog() {
        assert!(CHANGELOG.contains("## Unreleased"));
    }
}
