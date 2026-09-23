//! `note_history` — automatic Git versioning of the Markdown vault.
//!
//! A "Time Machine" for notes: every save lands in a local Git repository at
//! the vault root, so any note can be browsed, diffed and restored without
//! the user ever touching Git.
//!
//! * **Repository.** [`open_vault_repo`] uses the repository at the vault
//!   root when there is one (only ever committing to its current branch —
//!   remotes, branches and config are never touched) and initialises a fresh
//!   one otherwise, together with a small `.gitignore` for editor noise. A
//!   vault that lies *inside* another repository is refused instead of
//!   creating a nested repository that would break the outer one.
//! * **What is versioned.** Markdown notes and common attachment types
//!   ([`is_versioned_path`]); hidden files and folders (`.git`, `.obsidian`,
//!   `.trash`, …) never are, and `.gitignore` rules are honoured.
//! * **When.** A background thread watches the vault with `notify`
//!   (debounced by [`DEBOUNCE`]) and commits the touched files with
//!   `note: <path>` / `notes: N files`; a safety scan every
//!   [`SAFETY_INTERVAL`] catches anything the watcher missed (renamed
//!   folders, changes made while the app was closed). The UI can force a
//!   snapshot with [`NoteHistory::commit_now`].
//! * **How.** Commits are built from `HEAD` plus exactly the changed paths
//!   in an in-memory index, so changes the user staged by hand in an
//!   existing repository are never swept into an automatic commit.
//!
//! The vault path can change at runtime: every operation resolves it anew and
//! the cached repository handle is reopened when the root differs.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use git2::{
    Commit, ErrorCode, Index, IndexEntry, IndexTime, ObjectType, Oid, Patch, Repository,
    RepositoryInitOptions, RepositoryState, Sort, Status, StatusOptions, Tree,
};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::{Deserialize, Serialize};

use super::error::AetherError;
use super::git_repo::{ChangeKind, FileDiff};
use super::vault_reader::VaultReader;

/// Tauri event emitted after every history commit (payload: [`HistoryActivity`]).
pub const HISTORY_COMMIT_EVENT: &str = "history-commit";

/// Quiet period after the last file-system event before a snapshot is taken.
pub const DEBOUNCE: Duration = Duration::from_secs(2);

/// Interval of the safety scan that commits anything the watcher missed.
pub const SAFETY_INTERVAL: Duration = Duration::from_secs(30);

/// Identity used when neither the repository nor the global Git config
/// defines one (same fallback as the IDE's `git_repo`).
const FALLBACK_NAME: &str = "AETHER-OS";
const FALLBACK_EMAIL: &str = "aether@local";

/// Branch name for repositories created by note history.
const INITIAL_BRANCH: &str = "main";

/// Attachments larger than this are not versioned (keeps the repo small).
pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

/// File extensions (lowercase) versioned next to Markdown notes.
const ATTACHMENT_EXTENSIONS: &[&str] = &[
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "bmp",
    "avif",
    "heic",
    "pdf",
    "mp3",
    "wav",
    "m4a",
    "ogg",
    "flac",
    "mp4",
    "mov",
    "webm",
    "canvas",
    "excalidraw",
];

/// Written to fresh repositories that have no `.gitignore` yet.
const DEFAULT_GITIGNORE: &str = "# Written by AETHER-OS note history.\n\
.obsidian/workspace*.json\n\
.trash/\n\
.DS_Store\n";

/// Upper bound of commits inspected when listing the versions of one file.
const MAX_WALK: usize = 20_000;
/// Upper bound when counting commits for the status line.
const MAX_COUNT: usize = 100_000;
/// Files listed per activity entry (the full count is in `file_count`).
const ACTIVITY_FILES_CAP: usize = 20;
/// Default and maximum page sizes for list commands.
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 500;

const SETTINGS_FILE: &str = "settings.json";

/// Persisted user preferences (`<data_dir>/history/settings.json`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistorySettings {
    /// Automatic versioning on/off. On by default.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

impl Default for HistorySettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// State of note history for the status bar and settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryStatus {
    /// Automatic versioning is switched on.
    pub enabled: bool,
    /// The configured vault, `None` when no vault is connected.
    pub vault_path: Option<String>,
    /// Work tree root of the history repository (canonical vault root).
    pub repo_path: Option<String>,
    /// Branch the history commits to.
    pub branch: Option<String>,
    /// Number of commits on that branch (capped at 100 000).
    pub commit_count: usize,
    /// Unix timestamp (seconds) of the newest commit.
    pub last_commit_at: Option<i64>,
    /// The file watcher is active on the current vault.
    pub watching: bool,
    /// Most recent background failure, cleared by the next successful snapshot.
    pub last_error: Option<String>,
}

/// One version of a file: a commit that changed it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteVersion {
    /// Full commit id (40 hex characters).
    pub id: String,
    /// Abbreviated id (7 characters).
    pub short_id: String,
    /// Commit time, Unix seconds.
    pub time: i64,
    /// First line of the commit message.
    pub message: String,
    pub author: String,
    /// Whether the file was created, modified or deleted in this version.
    pub change: ChangeKind,
    /// Lines added compared with the previous version.
    pub summary_added: usize,
    /// Lines removed compared with the previous version.
    pub summary_removed: usize,
}

/// A file touched by a history commit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryFileChange {
    /// Vault-relative path with forward slashes.
    pub rel_path: String,
    /// Absolute path (joined onto the configured vault path, so it matches
    /// the paths returned by `cmd_get_vault_notes`).
    pub path: String,
    pub change: ChangeKind,
}

/// One entry of the vault-wide activity feed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryActivity {
    pub commit_id: String,
    pub short_id: String,
    /// Commit time, Unix seconds.
    pub time: i64,
    /// First line of the commit message.
    pub message: String,
    /// Changed files (at most 20; see `file_count`).
    pub files: Vec<HistoryFileChange>,
    /// Total number of changed files.
    pub file_count: usize,
}

/// Result of restoring a note to an older version.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryRestore {
    /// The content now on disk.
    pub content: String,
    /// The `restore:` commit, `None` when the note already had this content
    /// or automatic versioning is switched off.
    pub commit_id: Option<String>,
}

type VaultPathProvider = Box<dyn Fn() -> Option<String> + Send + Sync>;
type CommitListener = Box<dyn Fn(&HistoryActivity) + Send + Sync>;

/// The cached repository handle and the canonical vault root it belongs to.
struct OpenRepo {
    root: PathBuf,
    repo: Repository,
}

/// Messages for the watcher thread.
enum WatchMsg {
    /// Debounced file-system events (absolute paths).
    Changed(Vec<PathBuf>),
    /// The watcher backend reported an error.
    WatchError(String),
    /// Settings changed: re-evaluate the watch and scan immediately.
    Reconfigure,
    Shutdown,
}

/// A live watch on one vault root; dropping it stops the debouncer.
struct ActiveWatch {
    root: PathBuf,
    _debouncer: Debouncer<RecommendedWatcher>,
}

/// The note history engine held in `AppState`.
pub struct NoteHistory {
    settings_path: PathBuf,
    settings: Mutex<HistorySettings>,
    vault_path: VaultPathProvider,
    repo: Mutex<Option<OpenRepo>>,
    control: Mutex<Option<Sender<WatchMsg>>>,
    watched_root: Mutex<Option<PathBuf>>,
    last_error: Mutex<Option<String>>,
    listener: Mutex<Option<CommitListener>>,
}

/// Lock a mutex, recovering the data if a previous holder panicked. Every
/// critical section here leaves the protected state consistent.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn git_err(context: &str) -> impl Fn(git2::Error) -> AetherError + '_ {
    move |e| AetherError::Vault(format!("{context}: {}", e.message()))
}

impl NoteHistory {
    /// Create the engine. `storage_dir` holds `settings.json`;
    /// `vault_path` returns the current vault root (called on every
    /// background tick, so runtime vault changes are picked up).
    pub fn new(
        storage_dir: &Path,
        vault_path: impl Fn() -> Option<String> + Send + Sync + 'static,
    ) -> Result<Self, AetherError> {
        std::fs::create_dir_all(storage_dir)?;
        let settings_path = storage_dir.join(SETTINGS_FILE);
        let settings = load_settings(&settings_path);
        Ok(Self {
            settings_path,
            settings: Mutex::new(settings),
            vault_path: Box::new(vault_path),
            repo: Mutex::new(None),
            control: Mutex::new(None),
            watched_root: Mutex::new(None),
            last_error: Mutex::new(None),
            listener: Mutex::new(None),
        })
    }

    /// Register the callback invoked after every history commit.
    pub fn set_commit_listener(&self, listener: impl Fn(&HistoryActivity) + Send + Sync + 'static) {
        *lock(&self.listener) = Some(Box::new(listener));
    }

    /// Whether automatic versioning is switched on.
    pub fn is_enabled(&self) -> bool {
        lock(&self.settings).enabled
    }

    /// Switch automatic versioning on or off (persisted). Enabling starts
    /// watching and takes a snapshot right away; disabling stops the watcher.
    pub fn set_enabled(&self, enabled: bool) -> Result<(), AetherError> {
        let next = HistorySettings { enabled };
        let json = serde_json::to_string_pretty(&next)
            .map_err(|e| AetherError::Vault(format!("cannot serialize history settings: {e}")))?;
        std::fs::write(&self.settings_path, json)?;
        *lock(&self.settings) = next;
        if let Some(tx) = lock(&self.control).as_ref() {
            let _ = tx.send(WatchMsg::Reconfigure);
        }
        Ok(())
    }

    /// Start the background watcher thread (idempotent). The thread holds
    /// only a weak reference and ends when the engine is dropped or
    /// [`NoteHistory::shutdown`] is called.
    pub fn start(self: &Arc<Self>) -> Result<(), AetherError> {
        let mut control = lock(&self.control);
        if control.is_some() {
            return Ok(());
        }
        let (tx, rx) = mpsc::channel();
        let weak = Arc::downgrade(self);
        let loop_tx = tx.clone();
        std::thread::Builder::new()
            .name("aether-note-history".into())
            .spawn(move || watch_loop(weak, loop_tx, rx))?;
        *control = Some(tx);
        Ok(())
    }

    /// Stop the watcher thread (it finishes its current snapshot first).
    pub fn shutdown(&self) {
        if let Some(tx) = lock(&self.control).take() {
            let _ = tx.send(WatchMsg::Shutdown);
        }
    }

    /// Status for the given vault (`None`: no vault connected). Never fails;
    /// problems are reported in `last_error`.
    pub fn status(&self, vault_path: Option<&str>) -> HistoryStatus {
        let enabled = self.is_enabled();
        let mut status = HistoryStatus {
            enabled,
            vault_path: vault_path.map(str::to_string),
            repo_path: None,
            branch: None,
            commit_count: 0,
            last_commit_at: None,
            watching: false,
            last_error: lock(&self.last_error).clone(),
        };
        let Some(vault_path) = vault_path else {
            return status;
        };
        match self.with_repo(vault_path, enabled, repo_summary) {
            Ok(Some((repo_path, branch, count, last))) => {
                let watching = lock(&self.watched_root)
                    .as_deref()
                    .is_some_and(|watched| Path::new(&repo_path) == watched);
                status.watching = enabled && watching;
                status.repo_path = Some(repo_path);
                status.branch = branch;
                status.commit_count = count;
                status.last_commit_at = last;
            }
            Ok(None) => {}
            Err(e) => status.last_error = Some(e.to_string()),
        }
        status
    }

    /// Versions of one note, newest first. `path` is absolute (inside the
    /// vault) or vault-relative.
    pub fn list_versions(
        &self,
        vault_path: &str,
        path: &str,
        limit: Option<usize>,
    ) -> Result<Vec<NoteVersion>, AetherError> {
        let limit = clamp_limit(limit);
        let result = self.with_repo(vault_path, self.is_enabled(), |repo, root| {
            let rel = note_rel(vault_path, root, path)?;
            file_versions(repo, &rel, limit)
        })?;
        Ok(result.unwrap_or_default())
    }

    /// Content of a note as it was in `commit_id`.
    pub fn read_version(
        &self,
        vault_path: &str,
        path: &str,
        commit_id: &str,
    ) -> Result<String, AetherError> {
        self.with_repo(vault_path, self.is_enabled(), |repo, root| {
            let rel = note_rel(vault_path, root, path)?;
            let commit = resolve_commit(repo, commit_id)?;
            let bytes =
                blob_bytes_at(repo, &commit, &rel)?.ok_or_else(|| missing_in(&rel, &commit))?;
            text_or_binary_error(&rel, bytes)
        })?
        .ok_or_else(no_history)
    }

    /// Old/new content for the diff view.
    ///
    /// * `to`: a commit, or `None` for the current file on disk.
    /// * `from`: a commit, or `None` for "the version before `to`" — its
    ///   first parent for a commit, `HEAD` for the working copy.
    pub fn diff(
        &self,
        vault_path: &str,
        path: &str,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Result<FileDiff, AetherError> {
        self.with_repo(vault_path, self.is_enabled(), |repo, root| {
            let rel = note_rel(vault_path, root, path)?;
            let new_bytes = match to {
                Some(id) => blob_bytes_at(repo, &resolve_commit(repo, id)?, &rel)?,
                None => read_optional(&root.join(&rel))?,
            };
            let old_bytes = match (from, to) {
                (Some(id), _) => blob_bytes_at(repo, &resolve_commit(repo, id)?, &rel)?,
                (None, Some(id)) => match resolve_commit(repo, id)?.parent(0) {
                    Ok(parent) => blob_bytes_at(repo, &parent, &rel)?,
                    Err(_) => None,
                },
                (None, None) => match head_commit(repo)? {
                    Some(head) => blob_bytes_at(repo, &head, &rel)?,
                    None => None,
                },
            };
            let (old_content, old_binary) = decode(old_bytes);
            let (new_content, new_binary) = decode(new_bytes);
            Ok(FileDiff {
                path: rel,
                old_content,
                new_content,
                is_binary: old_binary || new_binary,
            })
        })?
        .ok_or_else(no_history)
    }

    /// Vault-wide activity feed, newest first.
    pub fn recent(
        &self,
        vault_path: &str,
        limit: Option<usize>,
    ) -> Result<Vec<HistoryActivity>, AetherError> {
        let limit = clamp_limit(limit);
        let result = self.with_repo(vault_path, self.is_enabled(), |repo, _root| {
            let Some(head) = head_commit(repo)? else {
                return Ok(Vec::new());
            };
            let mut walk = repo.revwalk().map_err(git_err("cannot walk history"))?;
            walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
                .map_err(git_err("cannot walk history"))?;
            walk.simplify_first_parent()
                .map_err(git_err("cannot walk history"))?;
            walk.push(head.id())
                .map_err(git_err("cannot walk history"))?;
            let mut out = Vec::with_capacity(limit.min(64));
            for oid in walk.take(limit) {
                let oid = oid.map_err(git_err("history error"))?;
                let commit = repo.find_commit(oid).map_err(git_err("history error"))?;
                out.push(activity_for(repo, &commit, vault_path)?);
            }
            Ok(out)
        })?;
        Ok(result.unwrap_or_default())
    }

    /// Take a snapshot now: of one note (`path`) or of every pending change.
    /// Returns the new commit, `None` when nothing changed.
    pub fn commit_now(
        &self,
        vault_path: &str,
        path: Option<&str>,
    ) -> Result<Option<HistoryActivity>, AetherError> {
        if !self.is_enabled() {
            return Err(AetherError::InvalidInput(
                "note history is turned off — enable it in Settings → History".into(),
            ));
        }
        let activity = self
            .with_repo(vault_path, true, |repo, root| {
                let rels = match path {
                    Some(path) => {
                        let rel = note_rel(vault_path, root, path)?;
                        if !is_versioned_path(&rel) {
                            return Err(AetherError::InvalidInput(format!(
                                "only notes and attachments are versioned: {rel}"
                            )));
                        }
                        BTreeSet::from([rel])
                    }
                    None => pending_changes(repo, root)?,
                };
                snapshot(repo, root, vault_path, &rels, None)
            })?
            .flatten();
        if let Some(activity) = &activity {
            self.notify(activity);
        }
        Ok(activity)
    }

    /// Restore `path` to its content in `commit_id`. The content is written
    /// through [`VaultReader::write_note`] (vault-scoped, like an editor
    /// save) and committed as `restore: <path> to <short id>`.
    pub fn restore(
        &self,
        vault_path: &str,
        path: &str,
        commit_id: &str,
        vault: &VaultReader,
    ) -> Result<HistoryRestore, AetherError> {
        let enabled = self.is_enabled();
        let (restore, activity) = self
            .with_repo(vault_path, enabled, |repo, root| {
                let rel = note_rel(vault_path, root, path)?;
                let commit = resolve_commit(repo, commit_id)?;
                let bytes =
                    blob_bytes_at(repo, &commit, &rel)?.ok_or_else(|| missing_in(&rel, &commit))?;
                let content = text_or_binary_error(&rel, bytes).map_err(|_| {
                    AetherError::InvalidInput(format!(
                        "only text notes can be restored from history: {rel}"
                    ))
                })?;

                // A deleted note may have lost its folder too.
                if let Some(parent) = Path::new(&rel).parent() {
                    if !parent.as_os_str().is_empty() {
                        std::fs::create_dir_all(root.join(parent))?;
                    }
                }
                let target = Path::new(vault_path).join(&rel);
                vault.write_note(&target.to_string_lossy(), &content)?;

                let activity = if enabled {
                    let message = format!("restore: {rel} to {}", short(&commit.id()));
                    snapshot(
                        repo,
                        root,
                        vault_path,
                        &BTreeSet::from([rel]),
                        Some(message),
                    )?
                } else {
                    None
                };
                Ok((
                    HistoryRestore {
                        content,
                        commit_id: activity.as_ref().map(|a| a.commit_id.clone()),
                    },
                    activity,
                ))
            })?
            .ok_or_else(no_history)?;
        if let Some(activity) = &activity {
            self.notify(activity);
        }
        Ok(restore)
    }

    /// Commit everything that changed (the safety scan) or the files behind
    /// a batch of watcher events. Errors are recorded for the status line.
    fn auto_snapshot(&self, events: Option<Vec<PathBuf>>) {
        if !self.is_enabled() {
            return;
        }
        let Some(vault_path) = (self.vault_path)() else {
            return;
        };
        let result = self
            .with_repo(&vault_path, true, |repo, root| {
                let rels = match &events {
                    None => pending_changes(repo, root)?,
                    Some(paths) => {
                        let roots = [root.to_path_buf(), PathBuf::from(&vault_path)];
                        coalesce_changes(&roots, paths.iter().cloned())
                            .into_iter()
                            .filter(|rel| is_candidate(repo, root, rel))
                            .collect()
                    }
                };
                snapshot(repo, root, &vault_path, &rels, None)
            })
            .map(Option::flatten);
        match result {
            Ok(activity) => {
                *lock(&self.last_error) = None;
                if let Some(activity) = activity {
                    self.notify(&activity);
                }
            }
            Err(e) => self.record_error(e.to_string()),
        }
    }

    fn record_error(&self, message: String) {
        *lock(&self.last_error) = Some(message);
    }

    fn notify(&self, activity: &HistoryActivity) {
        if let Some(listener) = lock(&self.listener).as_ref() {
            listener(activity);
        }
    }

    /// Point the watcher at the current vault (or stop it when disabled /
    /// disconnected). Runs on the watcher thread only.
    fn reconcile_watch(&self, active: &mut Option<ActiveWatch>, tx: &Sender<WatchMsg>) {
        let desired = if self.is_enabled() {
            (self.vault_path)().and_then(|raw| std::fs::canonicalize(raw).ok())
        } else {
            None
        };
        if desired.as_deref() == active.as_ref().map(|a| a.root.as_path()) {
            return;
        }
        *active = None;
        *lock(&self.watched_root) = None;
        let Some(root) = desired else {
            return;
        };
        let sender = tx.clone();
        let handler = move |result: DebounceEventResult| {
            let message = match result {
                Ok(events) => WatchMsg::Changed(events.into_iter().map(|e| e.path).collect()),
                Err(e) => WatchMsg::WatchError(format!("vault watcher error: {e}")),
            };
            let _ = sender.send(message);
        };
        match new_debouncer(DEBOUNCE, handler) {
            Ok(mut debouncer) => match debouncer.watcher().watch(&root, RecursiveMode::Recursive) {
                Ok(()) => {
                    *lock(&self.watched_root) = Some(root.clone());
                    *active = Some(ActiveWatch {
                        root,
                        _debouncer: debouncer,
                    });
                }
                Err(e) => self.record_error(format!("cannot watch the vault: {e}")),
            },
            Err(e) => self.record_error(format!("cannot start the vault watcher: {e}")),
        }
    }

    /// Run `f` with the repository of `vault_path`, (re)opening it when the
    /// vault changed. With `create` a missing repository is initialised
    /// (plus an initial snapshot); without it `Ok(None)` is returned.
    fn with_repo<T>(
        &self,
        vault_path: &str,
        create: bool,
        f: impl FnOnce(&Repository, &Path) -> Result<T, AetherError>,
    ) -> Result<Option<T>, AetherError> {
        let root = canonical_root(vault_path)?;
        let mut guard = lock(&self.repo);
        let reusable = guard
            .as_ref()
            .is_some_and(|open| open.root == root && open.repo.path().exists());
        if !reusable {
            *guard = None;
            let Some((repo, created)) = open_vault_repo(&root, create)? else {
                return Ok(None);
            };
            if created {
                let mut rels = pending_changes(&repo, &root)?;
                if root.join(".gitignore").is_file() {
                    rels.insert(".gitignore".to_string());
                }
                let message = format!("notes: initial snapshot ({})", files_label(rels.len()));
                if let Some(activity) = snapshot(&repo, &root, vault_path, &rels, Some(message))? {
                    self.notify(&activity);
                }
            }
            *guard = Some(OpenRepo {
                root: root.clone(),
                repo,
            });
        }
        match guard.as_ref() {
            Some(open) => f(&open.repo, &open.root).map(Some),
            None => Ok(None),
        }
    }
}

impl Drop for NoteHistory {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The watcher thread: keeps a debounced watch on the current vault, commits
/// event batches and runs the periodic safety scan (immediately at start).
fn watch_loop(weak: Weak<NoteHistory>, tx: Sender<WatchMsg>, rx: Receiver<WatchMsg>) {
    let mut active: Option<ActiveWatch> = None;
    let mut next_scan = Instant::now();
    loop {
        {
            let Some(history) = weak.upgrade() else { break };
            history.reconcile_watch(&mut active, &tx);
            if Instant::now() >= next_scan {
                history.auto_snapshot(None);
                next_scan = Instant::now() + SAFETY_INTERVAL;
            }
        }
        let wait = next_scan.saturating_duration_since(Instant::now());
        match rx.recv_timeout(wait) {
            Ok(WatchMsg::Changed(mut paths)) => {
                // Coalesce every batch that queued up while we were busy
                // into a single commit.
                let mut stop = false;
                while let Ok(message) = rx.try_recv() {
                    match message {
                        WatchMsg::Changed(more) => paths.extend(more),
                        WatchMsg::Reconfigure => next_scan = Instant::now(),
                        WatchMsg::WatchError(e) => {
                            if let Some(history) = weak.upgrade() {
                                history.record_error(e);
                            }
                        }
                        WatchMsg::Shutdown => stop = true,
                    }
                }
                if stop {
                    break;
                }
                let Some(history) = weak.upgrade() else { break };
                history.auto_snapshot(Some(paths));
            }
            Ok(WatchMsg::WatchError(e)) => {
                if let Some(history) = weak.upgrade() {
                    history.record_error(e);
                }
            }
            Ok(WatchMsg::Reconfigure) => next_scan = Instant::now(),
            Ok(WatchMsg::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
    drop(active);
    if let Some(history) = weak.upgrade() {
        *lock(&history.watched_root) = None;
    }
}

fn load_settings(path: &Path) -> HistorySettings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn no_history() -> AetherError {
    AetherError::InvalidInput(
        "the vault has no note history yet — turn on automatic versioning".into(),
    )
}

fn missing_in(rel: &str, commit: &Commit<'_>) -> AetherError {
    AetherError::InvalidInput(format!(
        "{rel} does not exist in version {}",
        short(&commit.id())
    ))
}

fn short(oid: &Oid) -> String {
    let mut id = oid.to_string();
    id.truncate(7);
    id
}

fn canonical_root(vault_path: &str) -> Result<PathBuf, AetherError> {
    let root = std::fs::canonicalize(vault_path).map_err(|e| {
        AetherError::Vault(format!("vault path is not accessible: {vault_path}: {e}"))
    })?;
    if !root.is_dir() {
        return Err(AetherError::Vault(format!(
            "vault path is not a folder: {vault_path}"
        )));
    }
    Ok(root)
}

/// Open the repository whose work tree is exactly `root`, or initialise one
/// when `create` is set. Returns the repository and whether it was created.
/// A vault nested inside another repository is refused.
pub fn open_vault_repo(
    root: &Path,
    create: bool,
) -> Result<Option<(Repository, bool)>, AetherError> {
    match Repository::open(root) {
        Ok(repo) => {
            let workdir = repo.workdir().ok_or_else(|| {
                AetherError::InvalidInput("the vault repository is bare (it has no files)".into())
            })?;
            let workdir = std::fs::canonicalize(workdir)?;
            if workdir != root {
                return Err(AetherError::InvalidInput(format!(
                    "the vault repository's work tree is elsewhere: {}",
                    workdir.display()
                )));
            }
            Ok(Some((repo, false)))
        }
        Err(e) if e.code() == ErrorCode::NotFound => {
            if let Ok(outer) = Repository::discover(root) {
                if let Some(outer_root) = outer.workdir() {
                    return Err(AetherError::InvalidInput(format!(
                        "the vault lies inside another Git repository ({}); note history needs the vault folder to be its own repository",
                        outer_root.display()
                    )));
                }
            }
            if !create {
                return Ok(None);
            }
            let mut opts = RepositoryInitOptions::new();
            opts.initial_head(INITIAL_BRANCH).mkpath(false);
            let repo = Repository::init_opts(root, &opts)
                .map_err(git_err("cannot create the vault repository"))?;
            let gitignore = root.join(".gitignore");
            if !gitignore.exists() {
                std::fs::write(&gitignore, DEFAULT_GITIGNORE)?;
            }
            Ok(Some((repo, true)))
        }
        Err(e) => Err(AetherError::Vault(format!(
            "cannot open the vault repository: {}",
            e.message()
        ))),
    }
}

/// True for vault-relative paths that note history versions: Markdown
/// notes and common attachments, outside hidden files and folders.
pub fn is_versioned_path(rel: &str) -> bool {
    if rel.is_empty() || rel.contains('\\') {
        return false;
    }
    if rel
        .split('/')
        .any(|part| part.is_empty() || part.starts_with('.') || part == "..")
    {
        return false;
    }
    let Some((_, ext)) = rel.rsplit_once('.') else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    ext == "md" || ATTACHMENT_EXTENSIONS.contains(&ext.as_str())
}

fn is_note(rel: &str) -> bool {
    rel.to_ascii_lowercase().ends_with(".md")
}

/// Versioned path that is not ignored by `.gitignore` and, for attachments,
/// not larger than [`MAX_ATTACHMENT_BYTES`]. Deleted files qualify so their
/// removal is recorded.
fn is_candidate(repo: &Repository, root: &Path, rel: &str) -> bool {
    if !is_versioned_path(rel) || repo.is_path_ignored(rel).unwrap_or(false) {
        return false;
    }
    if is_note(rel) {
        return true;
    }
    match std::fs::metadata(root.join(rel)) {
        Ok(meta) => meta.len() <= MAX_ATTACHMENT_BYTES,
        Err(_) => true,
    }
}

/// Turn a burst of file-system event paths into the sorted set of distinct
/// vault-relative paths worth committing. Paths outside every root, inside
/// `.git` or hidden folders, and non-note files are dropped.
pub fn coalesce_changes(
    roots: &[PathBuf],
    paths: impl IntoIterator<Item = PathBuf>,
) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for path in paths {
        let Some(rel) = roots.iter().find_map(|root| path.strip_prefix(root).ok()) else {
            continue;
        };
        if let Ok(rel) = normalize_rel(rel) {
            if is_versioned_path(&rel) {
                out.insert(rel);
            }
        }
    }
    out
}

/// Commit message for a set of changed paths: `note: <path>` for one file,
/// `notes: N files` for several.
pub fn commit_message(rels: &BTreeSet<String>) -> String {
    match rels.len() {
        1 => format!(
            "note: {}",
            rels.iter().next().map(String::as_str).unwrap_or("")
        ),
        n => format!("notes: {}", files_label(n)),
    }
}

fn files_label(count: usize) -> String {
    if count == 1 {
        "1 file".to_string()
    } else {
        format!("{count} files")
    }
}

/// Validate a vault-relative path and render it with forward slashes.
/// Rejects traversal, absolute paths, hidden components and non-UTF-8 names.
fn normalize_rel(rel: &Path) -> Result<String, AetherError> {
    let mut parts: Vec<&str> = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_str().ok_or_else(|| {
                    AetherError::InvalidInput(format!("path is not valid UTF-8: {}", rel.display()))
                })?;
                if part.starts_with('.') || part.contains('\\') {
                    return Err(AetherError::InvalidInput(format!(
                        "hidden files are not versioned: {}",
                        rel.display()
                    )));
                }
                parts.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(AetherError::InvalidInput(format!(
                    "path traversal is not allowed: {}",
                    rel.display()
                )));
            }
        }
    }
    if parts.is_empty() {
        return Err(AetherError::InvalidInput(
            "note path must not be empty".into(),
        ));
    }
    Ok(parts.join("/"))
}

/// Resolve a path from the UI (absolute inside the vault, or vault-relative)
/// to a validated vault-relative path.
fn note_rel(vault_path: &str, root: &Path, path: &str) -> Result<String, AetherError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AetherError::InvalidInput(
            "note path must not be empty".into(),
        ));
    }
    let candidate = Path::new(trimmed);
    if !candidate.is_absolute() {
        return normalize_rel(candidate);
    }
    let outside = || AetherError::InvalidInput(format!("path is outside the vault: {trimmed}"));
    if let Ok(rel) = candidate.strip_prefix(vault_path) {
        return normalize_rel(rel);
    }
    if let Ok(rel) = candidate.strip_prefix(root) {
        return normalize_rel(rel);
    }
    // A differently spelled path to the vault (symlinks): canonicalise the
    // deepest existing ancestor and re-attach the rest.
    let mut existing = candidate;
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    while !existing.exists() {
        let name = existing.file_name().ok_or_else(outside)?;
        tail.push(name);
        existing = existing.parent().ok_or_else(outside)?;
    }
    let mut resolved = std::fs::canonicalize(existing).map_err(|_| outside())?;
    for name in tail.into_iter().rev() {
        resolved.push(name);
    }
    let rel = resolved.strip_prefix(root).map_err(|_| outside())?;
    normalize_rel(rel)
}

/// Every versioned path whose working-tree state differs from `HEAD`.
fn pending_changes(repo: &Repository, root: &Path) -> Result<BTreeSet<String>, AetherError> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .exclude_submodules(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(git_err("cannot read the vault status"))?;
    let mut out = BTreeSet::new();
    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_empty() || status.intersects(Status::IGNORED | Status::CONFLICTED) {
            continue;
        }
        let Ok(rel) = entry.path() else { continue };
        if is_candidate(repo, root, rel) {
            out.insert(rel.to_string());
        }
    }
    Ok(out)
}

fn head_commit(repo: &Repository) -> Result<Option<Commit<'_>>, AetherError> {
    match repo.head() {
        Ok(head) => {
            let oid = head
                .target()
                .ok_or_else(|| AetherError::Vault("HEAD does not point at a commit".into()))?;
            repo.find_commit(oid)
                .map(Some)
                .map_err(git_err("broken HEAD"))
        }
        Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => Ok(None),
        Err(e) => Err(AetherError::Vault(format!(
            "cannot resolve HEAD: {}",
            e.message()
        ))),
    }
}

/// Refuse automatic commits while the repository is busy or detached, so a
/// user's merge/rebase or detached checkout is never disturbed.
fn ensure_committable(repo: &Repository) -> Result<(), AetherError> {
    if repo.state() != RepositoryState::Clean {
        return Err(AetherError::InvalidInput(
            "the vault repository is in the middle of a merge or rebase; snapshots resume once it is finished"
                .into(),
        ));
    }
    if repo.head_detached().unwrap_or(false) {
        return Err(AetherError::InvalidInput(
            "the vault repository has a detached HEAD; check out a branch to resume snapshots"
                .into(),
        ));
    }
    Ok(())
}

fn signature(repo: &Repository) -> Result<git2::Signature<'static>, AetherError> {
    if let Ok(sig) = repo.signature() {
        return Ok(sig);
    }
    git2::Signature::now(FALLBACK_NAME, FALLBACK_EMAIL)
        .map_err(git_err("cannot build commit signature"))
}

fn blob_entry(tree: &Tree<'_>, rel: &str) -> Option<(Oid, i32)> {
    let entry = tree.get_path(Path::new(rel)).ok()?;
    if entry.kind() == Some(ObjectType::Blob) {
        Some((entry.id(), entry.filemode()))
    } else {
        None
    }
}

/// Commit the given paths (as they are on disk now) on top of `HEAD`.
/// Unchanged paths are skipped; returns `None` when nothing changed.
fn commit_paths(
    repo: &Repository,
    root: &Path,
    rels: &BTreeSet<String>,
    message: &str,
) -> Result<Option<Oid>, AetherError> {
    if rels.is_empty() {
        return Ok(None);
    }
    ensure_committable(repo)?;
    let head = head_commit(repo)?;
    let head_tree = match &head {
        Some(commit) => Some(commit.tree().map_err(git_err("broken HEAD tree"))?),
        None => None,
    };

    // Build the new tree in a private in-memory index: HEAD plus exactly
    // our paths. The repository's own index (and anything the user staged
    // there) is not part of the commit.
    let mut index = Index::new().map_err(git_err("cannot create index"))?;
    if let Some(tree) = &head_tree {
        index
            .read_tree(tree)
            .map_err(git_err("cannot read HEAD tree"))?;
    }
    let mut changed: Vec<&str> = Vec::new();
    for rel in rels {
        let current = head_tree.as_ref().and_then(|tree| blob_entry(tree, rel));
        let absolute = root.join(rel);
        match std::fs::symlink_metadata(&absolute) {
            Ok(meta) if meta.is_file() => {
                let data = std::fs::read(&absolute)?;
                let oid = Oid::hash_object(ObjectType::Blob, &data)
                    .map_err(git_err("cannot hash file"))?;
                if current.map(|(id, _)| id) == Some(oid) {
                    continue;
                }
                let oid = repo.blob(&data).map_err(git_err("cannot store file"))?;
                let mode = current.map(|(_, mode)| mode as u32).unwrap_or(0o100644);
                index
                    .add(&index_entry(rel, mode, oid, data.len()))
                    .map_err(git_err("cannot stage file"))?;
                changed.push(rel);
            }
            // Directories, symlinks and other special files are not versioned.
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if current.is_some() {
                    index
                        .remove(Path::new(rel), 0)
                        .map_err(git_err("cannot record deletion"))?;
                    changed.push(rel);
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
    if changed.is_empty() {
        return Ok(None);
    }

    let tree_oid = index
        .write_tree_to(repo)
        .map_err(git_err("cannot build tree"))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(git_err("cannot find tree"))?;
    let sig = signature(repo)?;
    let parents: Vec<&Commit<'_>> = head.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(git_err("commit failed"))?;

    // Keep the repository index in step for the committed paths so plain
    // `git status` stays clean. Best effort: the commit already exists, and
    // a locked index (a concurrent `git` process) only affects that view.
    if let Ok(mut repo_index) = repo.index() {
        // Pick up staging done by other processes before writing it back.
        let mut ok = repo_index.read(false).is_ok();
        for rel in &changed {
            let path = Path::new(rel);
            let result = if root.join(rel).is_file() {
                repo_index.add_path(path)
            } else {
                repo_index.remove_path(path)
            };
            ok &= result.is_ok();
        }
        if ok {
            let _ = repo_index.write();
        }
    }
    Ok(Some(oid))
}

fn index_entry(rel: &str, mode: u32, id: Oid, len: usize) -> IndexEntry {
    IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: u32::try_from(len).unwrap_or(u32::MAX),
        id,
        flags: 0,
        flags_extended: 0,
        path: rel.as_bytes().to_vec(),
    }
}

/// Commit `rels` (message defaults to [`commit_message`]) and describe the
/// resulting commit.
fn snapshot(
    repo: &Repository,
    root: &Path,
    vault_path: &str,
    rels: &BTreeSet<String>,
    message: Option<String>,
) -> Result<Option<HistoryActivity>, AetherError> {
    let message = message.unwrap_or_else(|| commit_message(rels));
    let Some(oid) = commit_paths(repo, root, rels, &message)? else {
        return Ok(None);
    };
    let commit = repo.find_commit(oid).map_err(git_err("history error"))?;
    activity_for(repo, &commit, vault_path).map(Some)
}

fn delta_kind(delta: git2::Delta) -> ChangeKind {
    match delta {
        git2::Delta::Added | git2::Delta::Copied | git2::Delta::Untracked => ChangeKind::Added,
        git2::Delta::Deleted => ChangeKind::Deleted,
        git2::Delta::Renamed => ChangeKind::Renamed,
        git2::Delta::Typechange => ChangeKind::TypeChange,
        _ => ChangeKind::Modified,
    }
}

/// Describe a commit for the activity feed (files changed vs. first parent).
fn activity_for(
    repo: &Repository,
    commit: &Commit<'_>,
    vault_path: &str,
) -> Result<HistoryActivity, AetherError> {
    let tree = commit.tree().map_err(git_err("broken commit"))?;
    let parent_tree = match commit.parent(0) {
        Ok(parent) => Some(parent.tree().map_err(git_err("broken commit"))?),
        Err(_) => None,
    };
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(git_err("cannot diff commit"))?;
    let file_count = diff.deltas().len();
    let files = diff
        .deltas()
        .take(ACTIVITY_FILES_CAP)
        .filter_map(|delta| {
            let file = if delta.status() == git2::Delta::Deleted {
                delta.old_file()
            } else {
                delta.new_file()
            };
            let rel = file.path()?.to_str()?.replace('\\', "/");
            Some(HistoryFileChange {
                path: Path::new(vault_path)
                    .join(&rel)
                    .to_string_lossy()
                    .to_string(),
                rel_path: rel,
                change: delta_kind(delta.status()),
            })
        })
        .collect();
    Ok(HistoryActivity {
        commit_id: commit.id().to_string(),
        short_id: short(&commit.id()),
        time: commit.time().seconds(),
        message: commit_summary(commit),
        files,
        file_count,
    })
}

fn commit_summary(commit: &Commit<'_>) -> String {
    commit
        .summary()
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_string()
}

/// Commits that changed `rel` along the first-parent history, newest first.
fn file_versions(
    repo: &Repository,
    rel: &str,
    limit: usize,
) -> Result<Vec<NoteVersion>, AetherError> {
    let Some(head) = head_commit(repo)? else {
        return Ok(Vec::new());
    };
    let mut walk = repo.revwalk().map_err(git_err("cannot walk history"))?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(git_err("cannot walk history"))?;
    walk.simplify_first_parent()
        .map_err(git_err("cannot walk history"))?;
    walk.push(head.id())
        .map_err(git_err("cannot walk history"))?;

    let mut out = Vec::new();
    for oid in walk.take(MAX_WALK) {
        let oid = oid.map_err(git_err("history error"))?;
        let commit = repo.find_commit(oid).map_err(git_err("history error"))?;
        let tree = commit.tree().map_err(git_err("broken commit"))?;
        let new = blob_entry(&tree, rel).map(|(id, _)| id);
        let old = match commit.parent(0) {
            Ok(parent) => {
                let parent_tree = parent.tree().map_err(git_err("broken commit"))?;
                blob_entry(&parent_tree, rel).map(|(id, _)| id)
            }
            Err(_) => None,
        };
        if new == old {
            continue;
        }
        let change = match (old, new) {
            (None, Some(_)) => ChangeKind::Added,
            (Some(_), None) => ChangeKind::Deleted,
            _ => ChangeKind::Modified,
        };
        let (summary_added, summary_removed) = line_stats(repo, old, new)?;
        out.push(NoteVersion {
            id: oid.to_string(),
            short_id: short(&oid),
            time: commit.time().seconds(),
            message: commit_summary(&commit),
            author: commit.author().name().unwrap_or_default().to_string(),
            change,
            summary_added,
            summary_removed,
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// Added/removed line counts between two blobs (either side may be absent).
fn line_stats(
    repo: &Repository,
    old: Option<Oid>,
    new: Option<Oid>,
) -> Result<(usize, usize), AetherError> {
    let load = |oid: Option<Oid>| -> Result<Vec<u8>, AetherError> {
        match oid {
            Some(oid) => Ok(repo
                .find_blob(oid)
                .map_err(git_err("broken blob"))?
                .content()
                .to_vec()),
            None => Ok(Vec::new()),
        }
    };
    let (old, new) = (load(old)?, load(new)?);
    if old.contains(&0) || new.contains(&0) {
        return Ok((0, 0));
    }
    let patch = Patch::from_buffers(&old, None, &new, None, None)
        .map_err(git_err("cannot diff versions"))?;
    let (_, added, removed) = patch
        .line_stats()
        .map_err(git_err("cannot diff versions"))?;
    Ok((added, removed))
}

/// Resolve a (full or abbreviated) hex commit id.
fn resolve_commit<'r>(repo: &'r Repository, id: &str) -> Result<Commit<'r>, AetherError> {
    let id = id.trim();
    if id.len() < 4 || id.len() > 40 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AetherError::InvalidInput(format!(
            "invalid version id: {id}"
        )));
    }
    repo.revparse_single(id)
        .and_then(|object| object.peel_to_commit())
        .map_err(|_| AetherError::InvalidInput(format!("unknown version: {id}")))
}

fn blob_bytes_at(
    repo: &Repository,
    commit: &Commit<'_>,
    rel: &str,
) -> Result<Option<Vec<u8>>, AetherError> {
    let tree = commit.tree().map_err(git_err("broken commit"))?;
    match blob_entry(&tree, rel) {
        Some((oid, _)) => Ok(Some(
            repo.find_blob(oid)
                .map_err(git_err("broken blob"))?
                .content()
                .to_vec(),
        )),
        None => Ok(None),
    }
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, AetherError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// `(text, is_binary)`; binary content (contains NUL) yields no text.
fn decode(bytes: Option<Vec<u8>>) -> (Option<String>, bool) {
    match bytes {
        Some(bytes) if bytes.contains(&0) => (None, true),
        Some(bytes) => (Some(String::from_utf8_lossy(&bytes).into_owned()), false),
        None => (None, false),
    }
}

fn text_or_binary_error(rel: &str, bytes: Vec<u8>) -> Result<String, AetherError> {
    match decode(Some(bytes)) {
        (Some(text), false) => Ok(text),
        _ => Err(AetherError::InvalidInput(format!(
            "{rel} is a binary file and has no text content"
        ))),
    }
}

/// `(repo root, branch, commit count, last commit time)`.
fn repo_summary(
    repo: &Repository,
    root: &Path,
) -> Result<(String, Option<String>, usize, Option<i64>), AetherError> {
    let branch = match repo.head() {
        Ok(head) => head.shorthand().ok().map(str::to_string),
        Err(_) => std::fs::read_to_string(repo.path().join("HEAD"))
            .ok()
            .and_then(|raw| {
                raw.trim()
                    .strip_prefix("ref: refs/heads/")
                    .map(str::to_string)
            }),
    };
    let head = head_commit(repo)?;
    let (count, last) = match &head {
        Some(commit) => {
            let mut walk = repo.revwalk().map_err(git_err("cannot walk history"))?;
            walk.simplify_first_parent()
                .map_err(git_err("cannot walk history"))?;
            walk.push(commit.id())
                .map_err(git_err("cannot walk history"))?;
            (walk.take(MAX_COUNT).count(), Some(commit.time().seconds()))
        }
        None => (0, None),
    };
    Ok((root.to_string_lossy().to_string(), branch, count, last))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A temp vault plus a `VaultReader` configured for it.
    struct Fixture {
        vault: tempfile::TempDir,
        _config: tempfile::TempDir,
        storage: tempfile::TempDir,
        reader: VaultReader,
    }

    impl Fixture {
        fn new() -> Self {
            let vault = tempfile::tempdir().expect("vault dir");
            let config = tempfile::tempdir().expect("config dir");
            let storage = tempfile::tempdir().expect("storage dir");
            let reader = VaultReader::new(config.path()).expect("reader");
            reader
                .set_vault_path(vault.path().to_str().expect("utf-8 path"))
                .expect("set vault");
            Self {
                vault,
                _config: config,
                storage,
                reader,
            }
        }

        fn vault_path(&self) -> String {
            self.vault.path().to_string_lossy().to_string()
        }

        fn write(&self, rel: &str, content: &str) {
            let path = self.vault.path().join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("mkdir");
            }
            fs::write(path, content).expect("write");
        }

        fn history(&self) -> NoteHistory {
            let vault = self.vault_path();
            NoteHistory::new(self.storage.path(), move || Some(vault.clone())).expect("history")
        }

        fn repo(&self) -> Repository {
            Repository::open(self.vault.path()).expect("repo")
        }
    }

    fn head_files(repo: &Repository) -> Vec<String> {
        let tree = repo
            .head()
            .expect("head")
            .peel_to_tree()
            .expect("head tree");
        let mut out = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
            if entry.kind() == Some(ObjectType::Blob) {
                out.push(format!("{dir}{}", entry.name().unwrap_or_default()));
            }
            git2::TreeWalkResult::Ok
        })
        .expect("walk");
        out.sort();
        out
    }

    fn head_message(repo: &Repository) -> String {
        repo.head()
            .expect("head")
            .peel_to_commit()
            .expect("commit")
            .summary()
            .ok()
            .flatten()
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn initialises_a_fresh_vault_with_gitignore_and_initial_snapshot() {
        let fx = Fixture::new();
        fx.write("Welcome.md", "# Welcome\n");
        fx.write("projects/Plan.md", "# Plan\n");
        fx.write("assets/diagram.png", "\u{89}PNG fake");
        fx.write("notes.txt", "junk");
        fx.write(".obsidian/workspace.json", "{}");
        fx.write(".DS_Store", "junk");

        let history = fx.history();
        let status = history.status(Some(&fx.vault_path()));
        assert!(status.enabled);
        assert_eq!(status.commit_count, 1);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(status.last_error.is_none(), "{:?}", status.last_error);
        let canonical = fs::canonicalize(fx.vault.path()).expect("canonical");
        assert_eq!(
            status.repo_path.as_deref(),
            Some(canonical.to_string_lossy().as_ref())
        );

        let gitignore = fs::read_to_string(fx.vault.path().join(".gitignore")).expect("gitignore");
        assert!(gitignore.contains(".obsidian/workspace*.json"));
        assert!(gitignore.contains(".trash/"));
        assert!(gitignore.contains(".DS_Store"));

        let repo = fx.repo();
        assert_eq!(
            head_files(&repo),
            vec![
                ".gitignore",
                "Welcome.md",
                "assets/diagram.png",
                "projects/Plan.md"
            ]
        );
        assert!(head_message(&repo).starts_with("notes: initial snapshot"));
    }

    #[test]
    fn reuses_an_existing_repository_without_touching_branches_or_remotes() {
        let fx = Fixture::new();
        let base = {
            let repo = Repository::init(fx.vault.path()).expect("init");
            repo.remote("origin", "https://example.com/vault.git")
                .expect("remote");
            fx.write("a.md", "one\n");
            let mut index = repo.index().expect("index");
            index.add_path(Path::new("a.md")).expect("add");
            index.write().expect("write index");
            let tree = repo
                .find_tree(index.write_tree().expect("tree"))
                .expect("find tree");
            let sig = git2::Signature::now("Tester", "tester@example.com").expect("sig");
            let base = repo
                .commit(Some("HEAD"), &sig, &sig, "user commit", &tree, &[])
                .expect("commit");
            let commit = repo.find_commit(base).expect("find");
            repo.branch("work", &commit, false).expect("branch");
            repo.set_head("refs/heads/work").expect("switch");

            // A file the user staged by hand must not be swept into our commit.
            fx.write("staged.md", "user staged\n");
            let mut index = repo.index().expect("index");
            index.add_path(Path::new("staged.md")).expect("stage");
            index.write().expect("write index");
            base
        };

        let history = fx.history();
        fx.write("a.md", "one\ntwo\n");
        let activity = history
            .commit_now(&fx.vault_path(), Some("a.md"))
            .expect("commit")
            .expect("a change");
        assert_eq!(activity.message, "note: a.md");

        let repo = fx.repo();
        assert!(!fx.vault.path().join(".gitignore").exists());
        assert_eq!(repo.remotes().expect("remotes").len(), 1);
        assert_eq!(
            repo.head().expect("head").shorthand().expect("name"),
            "work"
        );
        let head = repo.head().expect("head").peel_to_commit().expect("commit");
        assert_eq!(head.parent_id(0).expect("parent"), base);
        assert_eq!(head_files(&repo), vec!["a.md"]);
        // The user's staged file is still staged, untouched.
        let status = repo.status_file(Path::new("staged.md")).expect("status");
        assert!(status.contains(Status::INDEX_NEW));
    }

    #[test]
    fn commits_on_write_and_skips_unchanged_snapshots() {
        let fx = Fixture::new();
        fx.write("Daily.md", "# Today\n");
        let history = fx.history();
        let vault = fx.vault_path();
        assert_eq!(history.status(Some(&vault)).commit_count, 1);

        let note = fx.vault.path().join("Daily.md");
        fx.reader
            .write_note(note.to_str().expect("utf-8"), "# Today\n- wrote tests\n")
            .expect("editor save");
        let activity = history
            .commit_now(&vault, None)
            .expect("snapshot")
            .expect("a change");
        assert_eq!(activity.message, "note: Daily.md");
        assert_eq!(activity.file_count, 1);
        assert_eq!(activity.files[0].rel_path, "Daily.md");
        assert_eq!(activity.files[0].change, ChangeKind::Modified);
        assert_eq!(activity.files[0].path, note.to_string_lossy().to_string());

        assert!(history
            .commit_now(&vault, None)
            .expect("snapshot")
            .is_none());
        assert_eq!(history.status(Some(&vault)).commit_count, 2);

        fx.write("One.md", "1");
        fx.write("Two.md", "2");
        let many = history
            .commit_now(&vault, None)
            .expect("snapshot")
            .expect("changes");
        assert_eq!(many.message, "notes: 2 files");
    }

    #[test]
    fn lists_versions_of_one_note_with_line_stats() {
        let fx = Fixture::new();
        let history = fx.history();
        let vault = fx.vault_path();
        history.status(Some(&vault));

        fx.write("Plan.md", "a\nb\n");
        history.commit_now(&vault, None).expect("v1");
        fx.write("Other.md", "unrelated\n");
        history.commit_now(&vault, None).expect("other");
        fx.write("Plan.md", "a\nB\nc\n");
        history.commit_now(&vault, None).expect("v2");
        fs::remove_file(fx.vault.path().join("Plan.md")).expect("delete");
        history.commit_now(&vault, None).expect("v3");

        let abs = fx.vault.path().join("Plan.md");
        let versions = history
            .list_versions(&vault, abs.to_str().expect("utf-8"), None)
            .expect("versions");
        assert_eq!(versions.len(), 3);
        assert_eq!(versions[0].change, ChangeKind::Deleted);
        assert_eq!(versions[0].summary_removed, 3);
        assert_eq!(versions[1].change, ChangeKind::Modified);
        assert_eq!(
            (versions[1].summary_added, versions[1].summary_removed),
            (2, 1)
        );
        assert_eq!(versions[2].change, ChangeKind::Added);
        assert_eq!(
            (versions[2].summary_added, versions[2].summary_removed),
            (2, 0)
        );
        assert_eq!(versions[2].short_id, &versions[2].id[..7]);
        assert!(versions.iter().all(|v| v.message.contains("Plan.md")));

        let limited = history
            .list_versions(&vault, "Plan.md", Some(1))
            .expect("limited");
        assert_eq!(limited.len(), 1);
    }

    #[test]
    fn reads_old_content_and_diffs_versions() {
        let fx = Fixture::new();
        let history = fx.history();
        let vault = fx.vault_path();
        fx.write("Note.md", "first\n");
        history.status(Some(&vault));
        fx.write("Note.md", "second\n");
        history.commit_now(&vault, None).expect("v2");
        fx.write("Note.md", "third (unsaved in history)\n");

        let versions = history
            .list_versions(&vault, "Note.md", None)
            .expect("versions");
        assert_eq!(versions.len(), 2);
        let (v2, v1) = (&versions[0], &versions[1]);
        assert_eq!(
            history
                .read_version(&vault, "Note.md", &v1.id)
                .expect("read"),
            "first\n"
        );
        assert_eq!(
            history
                .read_version(&vault, "Note.md", &v2.short_id)
                .expect("read short id"),
            "second\n"
        );

        let diff = history
            .diff(&vault, "Note.md", None, Some(&v2.id))
            .expect("diff vs parent");
        assert_eq!(diff.old_content.as_deref(), Some("first\n"));
        assert_eq!(diff.new_content.as_deref(), Some("second\n"));
        assert!(!diff.is_binary);

        let working = history
            .diff(&vault, "Note.md", None, None)
            .expect("working copy vs HEAD");
        assert_eq!(working.old_content.as_deref(), Some("second\n"));
        assert_eq!(
            working.new_content.as_deref(),
            Some("third (unsaved in history)\n")
        );

        let explicit = history
            .diff(&vault, "Note.md", Some(&v1.id), None)
            .expect("v1 vs working copy");
        assert_eq!(explicit.old_content.as_deref(), Some("first\n"));

        let first = history
            .diff(&vault, "Note.md", None, Some(&v1.id))
            .expect("root commit");
        assert!(first.old_content.is_none());

        assert!(history.read_version(&vault, "Note.md", "zzzz").is_err());
        assert!(history.read_version(&vault, "Note.md", "deadbeef").is_err());
        assert!(history.read_version(&vault, "Missing.md", &v1.id).is_err());
    }

    #[test]
    fn restore_writes_the_old_content_and_commits() {
        let fx = Fixture::new();
        let history = fx.history();
        let vault = fx.vault_path();
        fx.write("Idea.md", "original\n");
        history.status(Some(&vault));
        fx.write("Idea.md", "rewritten\n");
        history.commit_now(&vault, None).expect("v2");

        let versions = history.list_versions(&vault, "Idea.md", None).expect("v");
        let original = versions.last().expect("original").clone();
        let result = history
            .restore(&vault, "Idea.md", &original.id, &fx.reader)
            .expect("restore");
        assert_eq!(result.content, "original\n");
        assert_eq!(
            fs::read_to_string(fx.vault.path().join("Idea.md")).expect("read"),
            "original\n"
        );
        assert!(result.commit_id.is_some());
        assert_eq!(
            head_message(&fx.repo()),
            format!("restore: Idea.md to {}", original.short_id)
        );
        assert_eq!(
            history
                .list_versions(&vault, "Idea.md", None)
                .expect("v")
                .len(),
            3
        );

        // Restoring to identical content makes no empty commit.
        let again = history
            .restore(&vault, "Idea.md", &original.id, &fx.reader)
            .expect("restore again");
        assert!(again.commit_id.is_none());
    }

    #[test]
    fn restore_recreates_a_deleted_note_and_its_folder() {
        let fx = Fixture::new();
        let history = fx.history();
        let vault = fx.vault_path();
        fx.write("archive/Old.md", "keep me\n");
        history.status(Some(&vault));
        fs::remove_dir_all(fx.vault.path().join("archive")).expect("rm");
        let deleted = history
            .commit_now(&vault, None)
            .expect("snapshot")
            .expect("deletion");
        assert_eq!(deleted.files[0].change, ChangeKind::Deleted);
        assert!(!head_files(&fx.repo()).contains(&"archive/Old.md".to_string()));

        let versions = history
            .list_versions(&vault, "archive/Old.md", None)
            .expect("versions");
        assert_eq!(versions[0].change, ChangeKind::Deleted);
        // The deletion itself has no content to restore.
        assert!(history
            .restore(&vault, "archive/Old.md", &versions[0].id, &fx.reader)
            .is_err());
        history
            .restore(&vault, "archive/Old.md", &versions[1].id, &fx.reader)
            .expect("restore");
        assert_eq!(
            fs::read_to_string(fx.vault.path().join("archive/Old.md")).expect("read"),
            "keep me\n"
        );
    }

    #[test]
    fn ignores_hidden_and_non_note_files() {
        assert!(is_versioned_path("Welcome.md"));
        assert!(is_versioned_path("daily/2026-09-22.MD"));
        assert!(is_versioned_path("assets/photo.JPG"));
        assert!(is_versioned_path("board.canvas"));
        assert!(!is_versioned_path("notes.txt"));
        assert!(!is_versioned_path("Makefile"));
        assert!(!is_versioned_path(".git/HEAD"));
        assert!(!is_versioned_path(".obsidian/workspace.md"));
        assert!(!is_versioned_path("folder/.hidden.md"));
        assert!(!is_versioned_path(".trash/old.md"));
        assert!(!is_versioned_path("../escape.md"));
        assert!(!is_versioned_path(""));

        let fx = Fixture::new();
        fx.write("keep.md", "yes");
        fx.write("script.sh", "no");
        fx.write(".trash/gone.md", "no");
        fx.write("ignored/secret.md", "no");
        fx.write(".gitignore", "ignored/\n");
        let history = fx.history();
        history.status(Some(&fx.vault_path()));
        assert_eq!(head_files(&fx.repo()), vec![".gitignore", "keep.md"]);

        fx.write("script.sh", "still no");
        fx.write("ignored/secret.md", "still no");
        assert!(history
            .commit_now(&fx.vault_path(), None)
            .expect("snapshot")
            .is_none());
        assert!(history
            .commit_now(&fx.vault_path(), Some("script.sh"))
            .is_err());
    }

    #[test]
    fn large_attachments_are_skipped() {
        let fx = Fixture::new();
        let history = fx.history();
        history.status(Some(&fx.vault_path()));
        let big = fx.vault.path().join("video.mp4");
        let file = fs::File::create(&big).expect("create");
        file.set_len(MAX_ATTACHMENT_BYTES + 1).expect("grow");
        fx.write("small.png", "tiny");
        let activity = history
            .commit_now(&fx.vault_path(), None)
            .expect("snapshot")
            .expect("small file");
        assert_eq!(activity.message, "note: small.png");
    }

    #[test]
    fn coalesces_bursts_of_watcher_events() {
        let root = PathBuf::from("/vault");
        let alias = PathBuf::from("/private/vault");
        let events = vec![
            root.join("a.md"),
            root.join("a.md"),
            alias.join("a.md"),
            root.join("sub/b.md"),
            root.join(".git/index"),
            root.join(".git/objects/ab/cdef"),
            root.join(".obsidian/workspace.json"),
            root.join("sub"),
            root.join("image.png"),
            root.join("notes.txt"),
            PathBuf::from("/elsewhere/c.md"),
        ];
        let rels = coalesce_changes(&[root, alias], events);
        assert_eq!(
            rels.into_iter().collect::<Vec<_>>(),
            vec!["a.md", "image.png", "sub/b.md"]
        );
    }

    #[test]
    fn commit_messages_name_one_file_or_count_many() {
        assert_eq!(
            commit_message(&BTreeSet::from(["inbox/Idea.md".to_string()])),
            "note: inbox/Idea.md"
        );
        assert_eq!(
            commit_message(&BTreeSet::from(["a.md".to_string(), "b.md".to_string()])),
            "notes: 2 files"
        );
    }

    #[test]
    fn disabled_history_makes_no_commits_and_persists() {
        let fx = Fixture::new();
        fx.write("a.md", "a");
        let history = fx.history();
        history.set_enabled(false).expect("disable");
        let vault = fx.vault_path();

        let status = history.status(Some(&vault));
        assert!(!status.enabled);
        assert!(status.repo_path.is_none());
        assert!(!fx.vault.path().join(".git").exists());

        history.auto_snapshot(None);
        assert!(!fx.vault.path().join(".git").exists());
        assert!(history.commit_now(&vault, None).is_err());
        assert!(history.recent(&vault, None).expect("recent").is_empty());
        assert!(history
            .list_versions(&vault, "a.md", None)
            .expect("list")
            .is_empty());

        let reloaded = fx.history();
        assert!(!reloaded.is_enabled());
        reloaded.set_enabled(true).expect("enable");
        assert!(fx.history().is_enabled());
        assert_eq!(reloaded.status(Some(&vault)).commit_count, 1);
    }

    #[test]
    fn disabled_history_still_reads_an_existing_repository() {
        let fx = Fixture::new();
        fx.write("a.md", "a");
        let history = fx.history();
        let vault = fx.vault_path();
        history.status(Some(&vault));
        history.set_enabled(false).expect("disable");
        fx.write("a.md", "changed");
        history.auto_snapshot(None);

        let status = history.status(Some(&vault));
        assert_eq!(status.commit_count, 1);
        assert_eq!(
            history
                .list_versions(&vault, "a.md", None)
                .expect("list")
                .len(),
            1
        );
        let version = history.list_versions(&vault, "a.md", None).expect("list")[0].clone();
        let restored = history
            .restore(&vault, "a.md", &version.id, &fx.reader)
            .expect("restore");
        assert!(restored.commit_id.is_none());
        assert_eq!(status.commit_count, fx_commit_count(&fx));
    }

    fn fx_commit_count(fx: &Fixture) -> usize {
        let repo = fx.repo();
        let mut walk = repo.revwalk().expect("walk");
        walk.push_head().expect("head");
        walk.count()
    }

    #[test]
    fn rejects_paths_outside_the_vault() {
        let fx = Fixture::new();
        fx.write("a.md", "a");
        let history = fx.history();
        let vault = fx.vault_path();
        history.status(Some(&vault));
        for path in [
            "../escape.md",
            "/etc/passwd",
            ".git/config",
            "sub/../../x.md",
            "",
        ] {
            assert!(
                history.list_versions(&vault, path, None).is_err(),
                "{path} must be rejected"
            );
        }
        assert!(history.commit_now(&vault, Some("/tmp/other.md")).is_err());
    }

    #[test]
    fn refuses_a_vault_nested_in_another_repository() {
        let outer = tempfile::tempdir().expect("outer");
        Repository::init(outer.path()).expect("init outer");
        let vault = outer.path().join("vault");
        fs::create_dir(&vault).expect("mkdir");
        fs::write(vault.join("a.md"), "a").expect("write");
        let storage = tempfile::tempdir().expect("storage");
        let vault_str = vault.to_string_lossy().to_string();
        let provider = vault_str.clone();
        let history =
            NoteHistory::new(storage.path(), move || Some(provider.clone())).expect("history");
        let status = history.status(Some(&vault_str));
        assert!(status.repo_path.is_none());
        assert!(status
            .last_error
            .as_deref()
            .is_some_and(|e| e.contains("inside another Git repository")));
        assert!(!vault.join(".git").exists());
    }

    #[test]
    fn recent_activity_lists_commits_with_files() {
        let fx = Fixture::new();
        fx.write("a.md", "a");
        let history = fx.history();
        let vault = fx.vault_path();
        history.status(Some(&vault));
        fx.write("b.md", "b");
        history.commit_now(&vault, None).expect("b");
        fs::remove_file(fx.vault.path().join("a.md")).expect("rm");
        history.commit_now(&vault, None).expect("rm a");

        let recent = history.recent(&vault, Some(10)).expect("recent");
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].message, "note: a.md");
        assert_eq!(recent[0].files[0].change, ChangeKind::Deleted);
        assert_eq!(recent[1].files[0].rel_path, "b.md");
        assert!(recent[2].message.starts_with("notes: initial snapshot"));
        assert_eq!(history.recent(&vault, Some(1)).expect("one").len(), 1);
    }

    #[test]
    fn follows_the_vault_when_its_path_changes() {
        let first = Fixture::new();
        let second = Fixture::new();
        first.write("a.md", "a");
        second.write("b.md", "b");
        let history = first.history();
        let s1 = history.status(Some(&first.vault_path()));
        let s2 = history.status(Some(&second.vault_path()));
        assert_ne!(s1.repo_path, s2.repo_path);
        assert_eq!(head_files(&second.repo()), vec![".gitignore", "b.md"]);
    }

    #[test]
    fn commit_listener_receives_snapshots() {
        let fx = Fixture::new();
        let history = fx.history();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = seen.clone();
        history.set_commit_listener(move |activity| {
            sink.lock().expect("sink").push(activity.message.clone());
        });
        fx.write("a.md", "a");
        history.status(Some(&fx.vault_path()));
        fx.write("a.md", "b");
        history.commit_now(&fx.vault_path(), None).expect("commit");
        let seen = seen.lock().expect("seen").clone();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[1], "note: a.md");
    }

    #[test]
    fn watcher_commits_saved_notes_in_the_background() {
        let fx = Fixture::new();
        fx.write("a.md", "a");
        let history = Arc::new(fx.history());
        history.start().expect("start");
        let vault = fx.vault_path();

        // The first loop iteration takes the initial snapshot.
        let wait_for = |predicate: &dyn Fn(&HistoryStatus) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let status = history.status(Some(&vault));
                if predicate(&status) {
                    return status;
                }
                assert!(Instant::now() < deadline, "timed out: {status:?}");
                std::thread::sleep(Duration::from_millis(150));
            }
        };
        wait_for(&|s| s.commit_count >= 1 && s.watching);
        // Let the start-up safety scan finish; the next one is 30 s away, so
        // a commit within the deadline below can only come from the watcher.
        std::thread::sleep(Duration::from_secs(1));

        let written = Instant::now();
        fx.write("fresh.md", "written by the editor");
        let status = wait_for(&|s| s.commit_count >= 2);
        assert!(status.watching);
        assert!(written.elapsed() < SAFETY_INTERVAL);
        assert_eq!(head_message(&fx.repo()), "note: fresh.md");

        history.shutdown();
    }
}
