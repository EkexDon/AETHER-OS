//! Encrypted backup & folder sync (roadmap 5.3, without a cloud account).
//!
//! The vault — and optionally the app data (memory facts, calendar, tasks,
//! AETHER notes) — is synced end-to-end encrypted through **any folder the
//! user already has** (iCloud Drive, Dropbox, Syncthing, a USB stick, a NAS
//! share). Other devices running AETHER-OS decrypt with the same passphrase.
//! One-click encrypted backups (`.aetherbak`) can be verified and restored.
//! No relay server, no account; the on-disk format is documented in
//! [`crypto`], [`folder_sync`] and [`snapshot`] so a future relay can reuse
//! it unchanged.
//!
//! Local files (`<data_dir>/sync/`):
//!
//! ```text
//! settings.json   SyncSettings (device id + name, folder, schedule)
//! keyinfo.json    cached key parameters (salt, KDF, verifier) — no secrets
//! key.bin         the master key, ONLY when "remember on this device" is on (0600)
//! state.json      last common versions, hash cache, timestamps
//! trash/          app-data files removed by sync
//! conflict-copies/  app-data conflict copies
//! ```
//!
//! The passphrase is never stored. The derived key lives in memory
//! (zeroized on lock and when the engine is dropped) unless the user opts in
//! to remembering it.

pub mod conflict;
pub mod crypto;
pub mod folder_sync;
pub mod snapshot;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use self::conflict::{ConflictRecord, KeepChoice};
use self::crypto::{EnvelopeKind, HeaderFields, KdfParams, KeySet, MasterKey};
use self::folder_sync::{
    now_ms, rfc3339, CachedIndex, KeyInfo, LocalState, Roots, RoundContext, SyncIssue, SyncReport,
    SyncStore,
};
use self::snapshot::{
    BackupAuthor, BackupInfo, BackupPreview, BackupReport, BackupVerifyReport, RestoreMode,
    RestoreReport, RestoreTarget,
};
use crate::engine::error::AetherError;
use crate::engine::vault_reader::VaultReader;

const SETTINGS_FILE: &str = "settings.json";
const STATE_FILE: &str = "state.json";
const KEYINFO_FILE: &str = "keyinfo.json";
const KEY_FILE: &str = "key.bin";
/// Background loop granularity.
const TICK: Duration = Duration::from_secs(5);
/// Default folder-sync interval.
pub const DEFAULT_INTERVAL_SECONDS: u64 = 60;
const MIN_INTERVAL_SECONDS: u64 = 15;
const MAX_INTERVAL_SECONDS: u64 = 86_400;
const MAX_BACKUP_EVERY_HOURS: u32 = 24 * 30;
const BACKUP_RETRY: Duration = Duration::from_secs(15 * 60);
const MAX_DIFF_BYTES: u64 = 2 * 1024 * 1024;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Bad input from the UI (settings values, paths, ids).
fn invalid(msg: impl Into<String>) -> AetherError {
    AetherError::InvalidInput(msg.into())
}

/// The sync state or folder does not allow the operation, or stored sync
/// data is inconsistent.
fn sync_err(msg: impl Into<String>) -> AetherError {
    AetherError::Sync(msg.into())
}

/// Key material or passphrase problems.
fn crypto_err(msg: impl Into<String>) -> AetherError {
    AetherError::Crypto(msg.into())
}

// ── Public data types (IPC) ────────────────────────────────────────────

fn default_true() -> bool {
    true
}
fn default_interval() -> u64 {
    DEFAULT_INTERVAL_SECONDS
}
fn default_keep() -> u32 {
    snapshot::DEFAULT_KEEP
}

/// Persistent sync & backup settings (`<data_dir>/sync/settings.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncSettings {
    /// Background folder sync on/off.
    #[serde(default)]
    pub enabled: bool,
    /// The shared folder (the store lives in `<sync_dir>/aether-sync/v1`).
    #[serde(default)]
    pub sync_dir: Option<String>,
    /// Random id generated once per installation.
    pub device_id: String,
    /// Human-readable name (defaults to the host name).
    pub device_name: String,
    /// Also sync memory facts, calendar events, tasks and AETHER notes.
    #[serde(default = "default_true")]
    pub include_app_data: bool,
    /// Seconds between background rounds.
    #[serde(default = "default_interval")]
    pub interval_seconds: u64,
    /// Keep the key in `key.bin` so no passphrase prompt appears at start.
    #[serde(default)]
    pub remember_key: bool,
    /// Folder for scheduled backups.
    #[serde(default)]
    pub backup_dir: Option<String>,
    /// Hours between scheduled backups (0 = off).
    #[serde(default)]
    pub backup_every_hours: u32,
    /// Scheduled backups to keep.
    #[serde(default = "default_keep")]
    pub backup_keep: u32,
    /// Include app data in scheduled backups.
    #[serde(default = "default_true")]
    pub backup_include_app_data: bool,
}

/// Partial settings update; `None` keeps a value. Empty strings clear the
/// folder settings.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SyncSettingsPatch {
    /// See [`SyncSettings::enabled`].
    #[serde(default)]
    pub enabled: Option<bool>,
    /// See [`SyncSettings::sync_dir`] (`""` clears).
    #[serde(default)]
    pub sync_dir: Option<String>,
    /// See [`SyncSettings::device_name`].
    #[serde(default)]
    pub device_name: Option<String>,
    /// See [`SyncSettings::include_app_data`].
    #[serde(default)]
    pub include_app_data: Option<bool>,
    /// See [`SyncSettings::interval_seconds`].
    #[serde(default)]
    pub interval_seconds: Option<u64>,
    /// See [`SyncSettings::remember_key`].
    #[serde(default)]
    pub remember_key: Option<bool>,
    /// See [`SyncSettings::backup_dir`] (`""` clears).
    #[serde(default)]
    pub backup_dir: Option<String>,
    /// See [`SyncSettings::backup_every_hours`].
    #[serde(default)]
    pub backup_every_hours: Option<u32>,
    /// See [`SyncSettings::backup_keep`].
    #[serde(default)]
    pub backup_keep: Option<u32>,
    /// See [`SyncSettings::backup_include_app_data`].
    #[serde(default)]
    pub backup_include_app_data: Option<bool>,
}

/// Coarse state for the status bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    /// Nothing running (also when sync is off).
    Idle,
    /// A round, backup or passphrase change is running.
    Syncing,
    /// The last round failed.
    Error,
    /// Sync is on but the key is not unlocked.
    Locked,
}

/// Progress of a long operation (`sync-progress` event).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncProgress {
    /// `sync`, `backup`, `verify`, `restore` or `passphrase`.
    pub operation: String,
    /// Items done.
    pub done: u32,
    /// Items total.
    pub total: u32,
}

/// Status snapshot (`sync-status` event and `cmd_sync_status`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncStatus {
    /// Coarse state.
    pub state: SyncState,
    /// Background sync is on.
    pub enabled: bool,
    /// A sync folder is set.
    pub configured: bool,
    /// The key is in memory.
    pub unlocked: bool,
    /// A passphrase was set up on this device.
    pub initialized: bool,
    /// The key is remembered on this device.
    pub remembered: bool,
    /// Last successful round (RFC 3339).
    pub last_sync_at: Option<String>,
    /// Uploads left over from the last round.
    pub pending_uploads: u32,
    /// Downloads left over from the last round.
    pub pending_downloads: u32,
    /// Unresolved conflicts.
    pub conflicts: u32,
    /// Human-readable detail (errors, hints).
    pub message: Option<String>,
    /// This device.
    pub device_id: String,
    /// This device's name.
    pub device_name: String,
    /// Last scheduled backup (RFC 3339).
    pub last_backup_at: Option<String>,
    /// Next scheduled backup (RFC 3339).
    pub next_backup_at: Option<String>,
    /// Progress of the running operation.
    pub progress: Option<SyncProgress>,
}

/// A device that syncs through the folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceInfo {
    /// Device id.
    pub device_id: String,
    /// Device name.
    pub device_name: String,
    /// OS.
    pub platform: String,
    /// App version.
    pub app_version: String,
    /// Last sync (RFC 3339).
    pub last_seen: Option<String>,
    /// Files it tracks.
    pub file_count: u64,
    /// This is the current device.
    pub is_current: bool,
}

/// One side of a conflict, for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictSideInfo {
    /// Device id.
    pub device_id: String,
    /// Device name.
    pub device_name: String,
    /// Version time (RFC 3339).
    pub modified_at: String,
    /// Written by this device.
    pub is_this_device: bool,
}

/// A conflict for the UI. `current` is the version at the file's path
/// (`keep: "local"`), `other` the conflict copy (`keep: "remote"`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncConflict {
    /// Conflict id.
    pub id: String,
    /// Logical path of the file.
    pub path: String,
    /// Path for display (without namespace).
    pub display_path: String,
    /// Logical path of the conflict copy.
    pub copy_path: String,
    /// Copy path for display.
    pub display_copy_path: String,
    /// `vault` or `app`.
    pub kind: String,
    /// Detection time (RFC 3339).
    pub detected_at: String,
    /// Device that detected it.
    pub detected_by_name: String,
    /// Version at the path.
    pub current: ConflictSideInfo,
    /// Version in the copy.
    pub other: ConflictSideInfo,
    /// Settled.
    pub resolved: bool,
    /// `local` | `remote` | `both`.
    pub resolution: Option<KeepChoice>,
    /// When settled (RFC 3339).
    pub resolved_at: Option<String>,
    /// Who settled it.
    pub resolved_by_name: Option<String>,
    /// The conflict copy still exists on this device.
    pub copy_exists: bool,
}

/// Both versions of a conflict for the side-by-side diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncConflictDetail {
    /// The conflict.
    pub conflict: SyncConflict,
    /// Text at the file's path (None when missing or binary).
    pub current_content: Option<String>,
    /// Text of the conflict copy (None when missing or binary).
    pub other_content: Option<String>,
    /// At least one side is not UTF-8 text or too large to diff.
    pub binary: bool,
}

/// What a folder contains (setup wizard).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncFolderInfo {
    /// Canonical folder path.
    pub path: String,
    /// An AETHER store already exists there.
    pub initialized: bool,
    /// Devices registered in it.
    pub device_count: u32,
    /// Store creation time (RFC 3339).
    pub created_at: Option<String>,
    /// Device that created it.
    pub created_by: Option<String>,
}

/// Result of a passphrase change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassphraseChangeReport {
    /// Content blobs re-encrypted.
    pub blobs: u32,
    /// Device indexes re-encrypted.
    pub indexes: u32,
    /// Device records re-encrypted.
    pub devices: u32,
    /// Conflict records re-encrypted.
    pub conflicts: u32,
    /// Whether a sync folder was migrated (false = only this device).
    pub sync_folder: bool,
    /// Objects that could not be migrated.
    pub issues: Vec<SyncIssue>,
}

/// Events the engine emits; the command layer forwards them to the webview.
#[derive(Debug, Clone)]
pub enum SyncEvent {
    /// `sync-status`.
    Status(SyncStatus),
    /// `sync-progress`.
    Progress(SyncProgress),
}

/// Callback receiving [`SyncEvent`]s.
pub type SyncEmitter = Arc<dyn Fn(SyncEvent) + Send + Sync>;

#[derive(Serialize, Deserialize)]
struct RememberedKey {
    v: u32,
    salt: String,
    kdf: KdfParams,
    key: String,
}

/// Everything needed to work on conflict records.
struct LoadedConflicts {
    settings: SyncSettings,
    keys: Arc<KeySet>,
    store: SyncStore,
    records: folder_sync::ConflictEntries,
}

#[derive(Debug, Default)]
struct Runtime {
    busy: Option<SyncProgress>,
    last_error: Option<String>,
    message: Option<String>,
    pending_uploads: u32,
    pending_downloads: u32,
    conflicts: u32,
    last_sync_at: Option<i64>,
    last_backup_at: Option<i64>,
    last_backup_attempt: Option<Instant>,
}

// ── Engine ─────────────────────────────────────────────────────────────

/// The sync & backup engine. Cheap to share (`Arc`); every method is
/// thread-safe and long operations are serialized.
pub struct SyncEngine {
    data_dir: PathBuf,
    dir: PathBuf,
    vault: Arc<VaultReader>,
    kdf: KdfParams,
    settings: Mutex<SyncSettings>,
    keys: Mutex<Option<Arc<KeySet>>>,
    runtime: Mutex<Runtime>,
    op_lock: Mutex<()>,
    index_cache: Mutex<HashMap<String, CachedIndex>>,
    emitter: RwLock<Option<SyncEmitter>>,
    wake: (Mutex<bool>, Condvar),
    stop: AtomicBool,
}

impl SyncEngine {
    /// Engine with production Argon2id parameters.
    pub fn new(data_dir: &Path, vault: Arc<VaultReader>) -> Result<Self, AetherError> {
        Self::with_kdf(data_dir, vault, KdfParams::DEFAULT)
    }

    /// Engine with explicit KDF parameters for *new* keys (tests use cheap
    /// ones; existing keys always use their stored parameters).
    pub fn with_kdf(
        data_dir: &Path,
        vault: Arc<VaultReader>,
        kdf: KdfParams,
    ) -> Result<Self, AetherError> {
        kdf.validate()?;
        let dir = data_dir.join("sync");
        std::fs::create_dir_all(&dir)?;
        let settings_path = dir.join(SETTINGS_FILE);
        let settings = match std::fs::read(&settings_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<SyncSettings>(&b).ok())
        {
            Some(s) if folder_sync::is_valid_id(&s.device_id) => s,
            _ => {
                let s = SyncSettings {
                    enabled: false,
                    sync_dir: None,
                    device_id: uuid::Uuid::new_v4().to_string(),
                    device_name: default_device_name(),
                    include_app_data: true,
                    interval_seconds: DEFAULT_INTERVAL_SECONDS,
                    remember_key: false,
                    backup_dir: None,
                    backup_every_hours: 0,
                    backup_keep: snapshot::DEFAULT_KEEP,
                    backup_include_app_data: true,
                };
                write_json(&settings_path, &s)?;
                s
            }
        };
        let state = LocalState::load(&dir.join(STATE_FILE));
        let runtime = Runtime {
            last_sync_at: state.last_sync_at,
            last_backup_at: state.last_backup_at,
            ..Runtime::default()
        };
        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            dir,
            vault,
            kdf,
            settings: Mutex::new(settings),
            keys: Mutex::new(None),
            runtime: Mutex::new(runtime),
            op_lock: Mutex::new(()),
            index_cache: Mutex::new(HashMap::new()),
            emitter: RwLock::new(None),
            wake: (Mutex::new(false), Condvar::new()),
            stop: AtomicBool::new(false),
        })
    }

    /// Install the event callback.
    pub fn set_emitter(&self, emitter: SyncEmitter) {
        *self.emitter.write().unwrap_or_else(|p| p.into_inner()) = Some(emitter);
    }

    fn emit(&self, event: SyncEvent) {
        let emitter = self
            .emitter
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(emitter) = emitter {
            emitter(event);
        }
    }

    fn emit_status(&self) {
        self.emit(SyncEvent::Status(self.status()));
    }

    fn set_progress(&self, operation: &str, done: u32, total: u32) {
        let progress = SyncProgress {
            operation: operation.to_owned(),
            done,
            total,
        };
        lock(&self.runtime).busy = Some(progress.clone());
        if total < 50 || done % 25 == 0 || done == total {
            self.emit(SyncEvent::Progress(progress));
        }
    }

    fn begin(&self, operation: &str) {
        self.set_progress(operation, 0, 0);
        self.emit_status();
    }

    fn end(&self) {
        lock(&self.runtime).busy = None;
        self.emit_status();
    }

    fn local_keyinfo_path(&self) -> PathBuf {
        self.dir.join(KEYINFO_FILE)
    }

    fn key_file_path(&self) -> PathBuf {
        self.dir.join(KEY_FILE)
    }

    fn state_path(&self) -> PathBuf {
        self.dir.join(STATE_FILE)
    }

    fn current_keys(&self) -> Option<Arc<KeySet>> {
        lock(&self.keys).clone()
    }

    fn require_keys(&self) -> Result<Arc<KeySet>, AetherError> {
        self.current_keys()
            .ok_or_else(|| sync_err("sync is locked — unlock it with your passphrase first"))
    }

    fn store(&self, settings: &SyncSettings) -> Result<SyncStore, AetherError> {
        let dir = settings
            .sync_dir
            .as_deref()
            .ok_or_else(|| invalid("choose a sync folder first"))?;
        if !Path::new(dir).is_dir() {
            return Err(sync_err(format!("the sync folder is not reachable: {dir}")));
        }
        Ok(SyncStore::new(Path::new(dir)))
    }

    fn roots(&self, include_app_data: bool) -> Roots {
        Roots {
            vault: self.vault.detect_vault_path().map(PathBuf::from),
            data_dir: self.data_dir.clone(),
            include_app_data,
        }
    }

    /// Current settings.
    pub fn settings(&self) -> SyncSettings {
        lock(&self.settings).clone()
    }

    fn save_settings(&self, settings: &SyncSettings) -> Result<(), AetherError> {
        write_json(&self.dir.join(SETTINGS_FILE), settings)?;
        *lock(&self.settings) = settings.clone();
        Ok(())
    }

    /// Status snapshot.
    pub fn status(&self) -> SyncStatus {
        let s = self.settings();
        let unlocked = lock(&self.keys).is_some();
        let rt = lock(&self.runtime);
        let configured = s.sync_dir.is_some();
        let state = if rt.busy.is_some() {
            SyncState::Syncing
        } else if s.enabled && configured && !unlocked {
            SyncState::Locked
        } else if s.enabled && rt.last_error.is_some() {
            SyncState::Error
        } else {
            SyncState::Idle
        };
        let next_backup_at = (s.backup_every_hours > 0 && s.backup_dir.is_some()).then(|| {
            let every = i64::from(s.backup_every_hours) * 3_600_000;
            rfc3339(rt.last_backup_at.map_or_else(now_ms, |at| at + every))
        });
        SyncStatus {
            state,
            enabled: s.enabled,
            configured,
            unlocked,
            initialized: self.local_keyinfo_path().is_file(),
            remembered: s.remember_key && self.key_file_path().is_file(),
            last_sync_at: rt.last_sync_at.map(rfc3339),
            pending_uploads: rt.pending_uploads,
            pending_downloads: rt.pending_downloads,
            conflicts: rt.conflicts,
            message: rt.last_error.clone().or_else(|| rt.message.clone()),
            device_id: s.device_id.clone(),
            device_name: s.device_name.clone(),
            last_backup_at: rt.last_backup_at.map(rfc3339),
            next_backup_at,
            progress: rt.busy.clone(),
        }
    }

    // ── Settings ──

    /// Apply a settings patch (validated). Changing the sync folder locks
    /// the key, because the new folder may use a different passphrase.
    pub fn update_settings(&self, patch: SyncSettingsPatch) -> Result<SyncSettings, AetherError> {
        let _op = lock(&self.op_lock);
        let old = self.settings();
        let mut s = old.clone();
        if let Some(dir) = patch.sync_dir {
            s.sync_dir = if dir.trim().is_empty() {
                None
            } else {
                Some(self.validate_sync_dir(&dir)?.to_string_lossy().to_string())
            };
        }
        if let Some(dir) = patch.backup_dir {
            s.backup_dir = if dir.trim().is_empty() {
                None
            } else {
                Some(
                    self.validate_dir(&dir, "backup folder")?
                        .to_string_lossy()
                        .to_string(),
                )
            };
        }
        if let Some(name) = patch.device_name {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
                return Err(invalid("the device name must be 1–64 printable characters"));
            }
            s.device_name = name.to_owned();
        }
        if let Some(v) = patch.include_app_data {
            s.include_app_data = v;
        }
        if let Some(v) = patch.interval_seconds {
            if !(MIN_INTERVAL_SECONDS..=MAX_INTERVAL_SECONDS).contains(&v) {
                return Err(invalid(format!(
                    "the sync interval must be between {MIN_INTERVAL_SECONDS} and {MAX_INTERVAL_SECONDS} seconds"
                )));
            }
            s.interval_seconds = v;
        }
        if let Some(v) = patch.backup_every_hours {
            if v > MAX_BACKUP_EVERY_HOURS {
                return Err(invalid(format!(
                    "scheduled backups can run at most every {MAX_BACKUP_EVERY_HOURS} hours"
                )));
            }
            s.backup_every_hours = v;
        }
        if let Some(v) = patch.backup_keep {
            if !(1..=365).contains(&v) {
                return Err(invalid("keep between 1 and 365 backups"));
            }
            s.backup_keep = v;
        }
        if let Some(v) = patch.backup_include_app_data {
            s.backup_include_app_data = v;
        }
        if let Some(v) = patch.enabled {
            s.enabled = v;
        }
        if s.enabled && s.sync_dir.is_none() {
            return Err(invalid("choose a sync folder before turning sync on"));
        }
        if s.backup_every_hours > 0 && s.backup_dir.is_none() {
            return Err(invalid("choose a backup folder before scheduling backups"));
        }
        let folder_changed = s.sync_dir != old.sync_dir;
        if let Some(remember) = patch.remember_key {
            if remember && !folder_changed {
                let keys = self.require_keys().map_err(|_| {
                    sync_err("unlock sync first to remember the key on this device")
                })?;
                self.write_key_file(&keys)?;
            } else if !remember {
                self.remove_key_file()?;
            }
            s.remember_key = remember && !folder_changed;
        }
        if folder_changed {
            // The new folder may use a different passphrase: forget the key.
            *lock(&self.keys) = None;
            lock(&self.index_cache).clear();
            self.remove_key_file()?;
            s.remember_key = false;
            let mut rt = lock(&self.runtime);
            rt.last_error = None;
            rt.pending_uploads = 0;
            rt.pending_downloads = 0;
            rt.conflicts = 0;
            rt.message = s
                .sync_dir
                .as_ref()
                .map(|_| "Sync folder changed — unlock with its passphrase to continue.".into());
        }
        self.save_settings(&s)?;
        drop(_op);
        self.emit_status();
        self.wake();
        Ok(s)
    }

    /// Validate a user-chosen folder: absolute, existing, not a system or
    /// root folder, not inside the app data dir.
    fn validate_dir(&self, input: &str, label: &str) -> Result<PathBuf, AetherError> {
        let trimmed = input.trim();
        let path = Path::new(trimmed);
        if trimmed.is_empty() || trimmed.contains('\0') || !path.is_absolute() {
            return Err(invalid(format!("the {label} must be an absolute path")));
        }
        if !path.is_dir() {
            return Err(invalid(format!("the {label} does not exist: {trimmed}")));
        }
        let canonical = std::fs::canonicalize(path)?;
        check_safe_location(&canonical, label)?;
        if let Ok(data) = std::fs::canonicalize(&self.data_dir) {
            if canonical.starts_with(&data) {
                return Err(invalid(format!(
                    "the {label} cannot be inside the AETHER-OS data folder"
                )));
            }
        }
        Ok(canonical)
    }

    fn validate_sync_dir(&self, input: &str) -> Result<PathBuf, AetherError> {
        let canonical = self.validate_dir(input, "sync folder")?;
        if let Some(vault) = self
            .vault
            .detect_vault_path()
            .and_then(|v| std::fs::canonicalize(v).ok())
        {
            if canonical.starts_with(&vault) {
                return Err(invalid(
                    "the sync folder cannot be inside the vault (it would sync itself)",
                ));
            }
            if vault.starts_with(canonical.join(folder_sync::STORE_DIR)) {
                return Err(invalid("the vault cannot live inside the sync store"));
            }
        }
        Ok(canonical)
    }

    /// Describe a folder for the setup wizard.
    pub fn inspect_folder(&self, path: &str) -> Result<SyncFolderInfo, AetherError> {
        let canonical = self.validate_dir(path, "sync folder")?;
        let store = SyncStore::new(&canonical);
        let info = store.read_keyinfo()?;
        let device_count = store.list("devices", ".json")?.len() as u32;
        Ok(SyncFolderInfo {
            path: canonical.to_string_lossy().to_string(),
            initialized: info.is_some(),
            device_count,
            created_at: info.as_ref().map(|i| rfc3339(i.created_at)),
            created_by: info.map(|i| i.created_by),
        })
    }

    // ── Keys ──

    fn write_key_file(&self, keys: &KeySet) -> Result<(), AetherError> {
        let remembered = RememberedKey {
            v: 1,
            salt: keys.salt_hex(),
            kdf: keys.kdf(),
            key: hex::encode(keys.master().as_bytes()),
        };
        let bytes = Zeroizing::new(
            serde_json::to_vec(&remembered)
                .map_err(|e| crypto_err(format!("key serialize: {e}")))?,
        );
        let mut key_hex = Zeroizing::new(remembered.key);
        key_hex.clear();
        write_private(&self.key_file_path(), &bytes)
    }

    fn remove_key_file(&self) -> Result<(), AetherError> {
        let path = self.key_file_path();
        if path.exists() {
            // Overwrite before unlinking so the key does not linger in the file.
            if let Ok(len) = std::fs::metadata(&path).map(|m| m.len()) {
                let _ = std::fs::write(&path, vec![0u8; len as usize]);
            }
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    fn read_key_file(&self) -> Result<Option<KeySet>, AetherError> {
        let path = self.key_file_path();
        if !path.is_file() {
            return Ok(None);
        }
        let bytes = Zeroizing::new(folder_sync::read_limited(&path, 4096)?);
        let remembered: RememberedKey = serde_json::from_slice(&bytes)
            .map_err(|e| crypto_err(format!("remembered key is corrupt: {e}")))?;
        let key_hex = Zeroizing::new(remembered.key);
        let raw = Zeroizing::new(
            hex::decode(key_hex.as_str()).map_err(|_| crypto_err("remembered key is corrupt"))?,
        );
        let array: [u8; crypto::KEY_LEN] = raw
            .as_slice()
            .try_into()
            .map_err(|_| crypto_err("remembered key has the wrong length"))?;
        remembered.kdf.validate()?;
        Ok(Some(KeySet::new(
            MasterKey::from_bytes(array),
            crypto::parse_salt(&remembered.salt)?,
            remembered.kdf,
        )))
    }

    /// The key parameters that apply now: the sync folder's (when set and
    /// reachable), else this device's cached copy.
    fn effective_keyinfo(&self, settings: &SyncSettings) -> Result<Option<KeyInfo>, AetherError> {
        if let Some(dir) = settings.sync_dir.as_deref() {
            if Path::new(dir).is_dir() {
                if let Some(info) = SyncStore::new(Path::new(dir)).read_keyinfo()? {
                    return Ok(Some(info));
                }
            }
        }
        KeyInfo::read(&self.local_keyinfo_path())
    }

    /// Derive the key from `passphrase` and check it against the verifier of
    /// the sync folder (or this device); creates the key on first use.
    /// `remember` stores the key in `key.bin` (less secure, opt-in).
    pub fn unlock(&self, passphrase: &str, remember: bool) -> Result<SyncStatus, AetherError> {
        let _op = lock(&self.op_lock);
        let settings = self.settings();
        let store = match settings.sync_dir.as_deref() {
            Some(dir) if Path::new(dir).is_dir() => Some(SyncStore::new(Path::new(dir))),
            Some(dir) => return Err(sync_err(format!("the sync folder is not reachable: {dir}"))),
            None => None,
        };
        let remote = match &store {
            Some(s) => s.read_keyinfo()?,
            None => None,
        };
        let local = KeyInfo::read(&self.local_keyinfo_path()).unwrap_or(None);
        let (mut info, creating) = match (remote, local) {
            (Some(r), _) => (r, false),
            (None, Some(l)) => (l, false),
            (None, None) => {
                crypto::check_new_passphrase(passphrase)?;
                (
                    KeyInfo {
                        v: 1,
                        store_id: uuid::Uuid::new_v4().to_string(),
                        kdf: self.kdf,
                        salt: hex::encode(crypto::random_salt()),
                        verifier: String::new(),
                        created_at: now_ms(),
                        created_by: settings.device_name.clone(),
                    },
                    true,
                )
            }
        };
        if !creating {
            // The sync folder's key file is untrusted: never derive with
            // parameters weaker than this build creates keys with.
            info.kdf.ensure_at_least(&self.kdf)?;
        }
        let keys = KeySet::derive(passphrase, info.salt_bytes()?, info.kdf)?;
        if creating {
            info.verifier = keys.verifier_hex();
        } else if !keys.matches_verifier(&info.verifier) {
            return Err(crypto_err("wrong passphrase"));
        }
        if let Some(store) = &store {
            if store.read_keyinfo()?.is_none() {
                // A fresh folder becomes a fresh store (new id) protected by
                // this passphrase.
                store.ensure_layout()?;
                if !creating {
                    info.store_id = uuid::Uuid::new_v4().to_string();
                    info.created_at = now_ms();
                    info.created_by = settings.device_name.clone();
                }
                info.write(&store.keyinfo_path())?;
            }
        }
        if KeyInfo::read(&self.local_keyinfo_path())
            .ok()
            .flatten()
            .as_ref()
            != Some(&info)
        {
            info.write(&self.local_keyinfo_path())?;
        }
        let keys = Arc::new(keys);
        let mut s = settings;
        if remember {
            self.write_key_file(&keys)?;
        } else {
            self.remove_key_file()?;
        }
        if s.remember_key != remember {
            s.remember_key = remember;
            self.save_settings(&s)?;
        }
        *lock(&self.keys) = Some(keys);
        lock(&self.index_cache).clear();
        {
            let mut rt = lock(&self.runtime);
            rt.message = None;
            rt.last_error = None;
        }
        drop(_op);
        self.wake();
        let status = self.status();
        self.emit(SyncEvent::Status(status.clone()));
        Ok(status)
    }

    /// Unlock from `key.bin` when the user opted in. Returns whether the
    /// engine is now unlocked.
    pub fn try_auto_unlock(&self) -> bool {
        let settings = self.settings();
        if !settings.remember_key {
            return false;
        }
        let Ok(Some(keys)) = self.read_key_file() else {
            return false;
        };
        let matches = match self.effective_keyinfo(&settings) {
            Ok(Some(info)) => {
                info.salt == keys.salt_hex()
                    && keys.matches_verifier(&info.verifier)
                    && info.kdf.ensure_at_least(&self.kdf).is_ok()
                    && keys.kdf().ensure_at_least(&self.kdf).is_ok()
            }
            _ => false,
        };
        if !matches {
            lock(&self.runtime).message = Some(
                "The passphrase changed on another device — unlock with the new passphrase.".into(),
            );
            return false;
        }
        *lock(&self.keys) = Some(Arc::new(keys));
        self.emit_status();
        self.wake();
        true
    }

    /// Forget the key (zeroized once no operation holds it).
    pub fn lock(&self) -> SyncStatus {
        *lock(&self.keys) = None;
        lock(&self.index_cache).clear();
        let status = self.status();
        self.emit(SyncEvent::Status(status.clone()));
        status
    }

    // ── Folder sync ──

    /// Run a sync round now.
    pub fn sync_now(&self) -> Result<SyncReport, AetherError> {
        let _op = lock(&self.op_lock);
        let settings = self.settings();
        let keys = self.require_keys()?;
        let store = self.store(&settings)?;
        self.begin("sync");
        let result = self.run_round(&settings, &keys, &store);
        {
            let mut rt = lock(&self.runtime);
            match &result {
                Ok(report) => {
                    rt.last_error = None;
                    rt.pending_uploads = report.pending_uploads;
                    rt.pending_downloads = report.pending_downloads;
                    rt.last_sync_at = Some(now_ms());
                    rt.message = (!report.issues.is_empty()).then(|| {
                        format!(
                            "{} item(s) need attention — see the last report",
                            report.issues.len()
                        )
                    });
                }
                Err(e) => rt.last_error = Some(e.to_string()),
            }
        }
        self.end();
        result
    }

    fn run_round(
        &self,
        settings: &SyncSettings,
        keys: &Arc<KeySet>,
        store: &SyncStore,
    ) -> Result<SyncReport, AetherError> {
        let store_id = match store.read_keyinfo()? {
            Some(info) => {
                if info.salt != keys.salt_hex() || !keys.matches_verifier(&info.verifier) {
                    *lock(&self.keys) = None;
                    return Err(crypto_err(
                        "the sync passphrase was changed on another device — unlock with the new passphrase",
                    ));
                }
                info.store_id
            }
            None => {
                // The folder was emptied or is new: re-initialise it with our key.
                let mut info = KeyInfo::read(&self.local_keyinfo_path())?
                    .ok_or_else(|| sync_err("unlock sync again to initialise this folder"))?;
                info.store_id = uuid::Uuid::new_v4().to_string();
                info.created_at = now_ms();
                info.created_by = settings.device_name.clone();
                store.ensure_layout()?;
                info.write(&store.keyinfo_path())?;
                info.write(&self.local_keyinfo_path())?;
                info.store_id
            }
        };
        let roots = self.roots(settings.include_app_data);
        if roots.vault.is_none() && !settings.include_app_data {
            return Err(invalid(
                "no vault is configured — choose one in Settings → Vault",
            ));
        }
        let mut state = LocalState::load(&self.state_path());
        state.bind_store(&store_id);
        let ctx = RoundContext {
            keys,
            store,
            roots: &roots,
            vault: &self.vault,
            device_id: &settings.device_id,
            device_name: &settings.device_name,
        };
        let result = {
            let mut cache = lock(&self.index_cache);
            folder_sync::sync_round(&ctx, &mut state, &mut cache, &|done, total| {
                self.set_progress("sync", done, total)
            })
        };
        state.save(&self.state_path())?;
        if let Ok((records, _)) = folder_sync::read_conflicts(store, keys) {
            lock(&self.runtime).conflicts =
                records.iter().filter(|(r, _)| !r.resolved).count() as u32;
        }
        result
    }

    /// Devices registered in the sync folder (this one first).
    pub fn devices(&self) -> Result<Vec<DeviceInfo>, AetherError> {
        let settings = self.settings();
        let mut devices: Vec<DeviceInfo> = match (self.current_keys(), self.store(&settings)) {
            (Some(keys), Ok(store)) => folder_sync::read_devices(&store, &keys)?
                .0
                .into_iter()
                .map(|r| DeviceInfo {
                    is_current: r.device_id == settings.device_id,
                    device_id: r.device_id,
                    device_name: r.device_name,
                    platform: r.platform,
                    app_version: r.app_version,
                    last_seen: Some(rfc3339(r.last_seen)),
                    file_count: r.file_count,
                })
                .collect(),
            (None, Ok(_)) => return Err(sync_err("unlock sync to see the other devices")),
            _ => Vec::new(),
        };
        if !devices.iter().any(|d| d.is_current) {
            devices.push(DeviceInfo {
                device_id: settings.device_id.clone(),
                device_name: settings.device_name.clone(),
                platform: std::env::consts::OS.to_owned(),
                app_version: env!("CARGO_PKG_VERSION").to_owned(),
                last_seen: lock(&self.runtime).last_sync_at.map(rfc3339),
                file_count: 0,
                is_current: true,
            });
        }
        devices.sort_by(|a, b| {
            b.is_current
                .cmp(&a.is_current)
                .then_with(|| b.last_seen.cmp(&a.last_seen))
        });
        Ok(devices)
    }

    // ── Conflicts ──

    fn conflict_view(&self, record: &ConflictRecord, roots: &Roots, me: &str) -> SyncConflict {
        let side = |s: &conflict::ConflictSide| ConflictSideInfo {
            device_id: s.device_id.clone(),
            device_name: s.device_name.clone(),
            modified_at: rfc3339(s.mtime),
            is_this_device: s.device_id == me,
        };
        SyncConflict {
            id: record.id.clone(),
            path: record.path.clone(),
            display_path: conflict::display_path(&record.path),
            copy_path: record.copy_path.clone(),
            display_copy_path: conflict::display_path(&record.copy_path),
            kind: if record.path.starts_with("vault/") {
                "vault".into()
            } else {
                "app".into()
            },
            detected_at: rfc3339(record.detected_at),
            detected_by_name: record.detected_by_name.clone(),
            current: side(&record.current),
            other: side(&record.other),
            resolved: record.resolved,
            resolution: record.resolution,
            resolved_at: record.resolved_at.map(rfc3339),
            resolved_by_name: record.resolved_by_name.clone(),
            copy_exists: roots
                .resolve(&record.copy_path)
                .map(|p| p.is_file())
                .unwrap_or(false),
        }
    }

    fn load_conflicts(&self) -> Result<LoadedConflicts, AetherError> {
        let settings = self.settings();
        let keys = self.require_keys()?;
        let store = self.store(&settings)?;
        let (records, _) = folder_sync::read_conflicts(&store, &keys)?;
        Ok(LoadedConflicts {
            settings,
            keys,
            store,
            records,
        })
    }

    /// All conflict records (unresolved first). Expired resolved records are
    /// removed from the sync folder.
    pub fn list_conflicts(&self) -> Result<Vec<SyncConflict>, AetherError> {
        let LoadedConflicts {
            settings, records, ..
        } = self.load_conflicts()?;
        let roots = self.roots(true);
        let now = now_ms();
        let mut out = Vec::new();
        for (record, path) in records {
            if record.is_expired(now) {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            out.push(self.conflict_view(&record, &roots, &settings.device_id));
        }
        out.sort_by(|a, b| {
            a.resolved
                .cmp(&b.resolved)
                .then_with(|| b.detected_at.cmp(&a.detected_at))
        });
        lock(&self.runtime).conflicts = out.iter().filter(|c| !c.resolved).count() as u32;
        Ok(out)
    }

    /// Both versions of one conflict.
    pub fn get_conflict(&self, id: &str) -> Result<SyncConflictDetail, AetherError> {
        if !folder_sync::is_valid_id(id) {
            return Err(invalid("invalid conflict id"));
        }
        let LoadedConflicts {
            settings, records, ..
        } = self.load_conflicts()?;
        let (record, _) = records
            .into_iter()
            .find(|(r, _)| r.id == id)
            .ok_or_else(|| invalid("conflict not found"))?;
        let roots = self.roots(true);
        let read_text = |path: &str| -> (Option<String>, bool) {
            let Ok(abs) = roots.resolve(path) else {
                return (None, false);
            };
            match folder_sync::read_limited(&abs, MAX_DIFF_BYTES) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => (Some(text), false),
                    Err(_) => (None, true),
                },
                Err(_) if abs.is_file() => (None, true),
                Err(_) => (None, false),
            }
        };
        let (current_content, current_binary) = read_text(&record.path);
        let (other_content, other_binary) = read_text(&record.copy_path);
        Ok(SyncConflictDetail {
            conflict: self.conflict_view(&record, &roots, &settings.device_id),
            current_content,
            other_content,
            binary: current_binary || other_binary,
        })
    }

    /// Settle a conflict: `local` keeps the file and trashes the copy,
    /// `remote` replaces the file with the copy's content and trashes the
    /// copy, `both` keeps both files.
    pub fn resolve_conflict(
        &self,
        id: &str,
        keep: KeepChoice,
    ) -> Result<SyncConflict, AetherError> {
        if !folder_sync::is_valid_id(id) {
            return Err(invalid("invalid conflict id"));
        }
        let _op = lock(&self.op_lock);
        let LoadedConflicts {
            settings,
            keys,
            store,
            records,
        } = self.load_conflicts()?;
        let (mut record, _) = records
            .into_iter()
            .find(|(r, _)| r.id == id)
            .ok_or_else(|| invalid("conflict not found"))?;
        if record.resolved {
            return Err(invalid("this conflict was already resolved"));
        }
        let roots = self.roots(true);
        let ctx = RoundContext {
            keys: &keys,
            store: &store,
            roots: &roots,
            vault: &self.vault,
            device_id: &settings.device_id,
            device_name: &settings.device_name,
        };
        match keep {
            KeepChoice::Local => ctx.trash_local(&record.copy_path)?,
            KeepChoice::Remote => {
                let bytes = ctx
                    .read_local(&record.copy_path)
                    .map_err(|_| sync_err("the conflict copy no longer exists on this device"))?;
                ctx.write_local(&record.path, &bytes, now_ms())?;
                ctx.trash_local(&record.copy_path)?;
            }
            KeepChoice::Both => {}
        }
        record.resolve(keep, &settings.device_name, now_ms());
        ctx.write_conflict(&record)?;
        let view = self.conflict_view(&record, &roots, &settings.device_id);
        {
            let mut rt = lock(&self.runtime);
            rt.conflicts = rt.conflicts.saturating_sub(1);
        }
        drop(_op);
        self.emit_status();
        self.wake();
        Ok(view)
    }

    // ── Passphrase change ──

    /// Change the passphrase: re-encrypts every blob, index, device record
    /// and conflict record in the sync folder with a key from a fresh salt,
    /// then switches the key file atomically. Resumable: objects already
    /// under the new key are skipped when the same new passphrase is used.
    pub fn change_passphrase(
        &self,
        old: &str,
        new: &str,
    ) -> Result<PassphraseChangeReport, AetherError> {
        crypto::check_new_passphrase(new)?;
        if old == new {
            return Err(invalid(
                "the new passphrase must be different from the current one",
            ));
        }
        let _op = lock(&self.op_lock);
        let settings = self.settings();
        let store = match settings.sync_dir.as_deref() {
            Some(dir) if Path::new(dir).is_dir() => Some(SyncStore::new(Path::new(dir))),
            Some(dir) => return Err(sync_err(format!("the sync folder is not reachable: {dir}"))),
            None => None,
        };
        let current = match &store {
            Some(s) => s.read_keyinfo()?,
            None => None,
        }
        .or(KeyInfo::read(&self.local_keyinfo_path())?)
        .ok_or_else(|| sync_err("no passphrase has been set up yet"))?;
        current.kdf.ensure_at_least(&self.kdf)?;
        let old_keys = KeySet::derive(old, current.salt_bytes()?, current.kdf)?;
        if !old_keys.matches_verifier(&current.verifier) {
            return Err(crypto_err("the current passphrase is wrong"));
        }

        // Resume a half-finished change with the same new passphrase.
        let pending = store
            .as_ref()
            .and_then(|s| KeyInfo::read(&s.pending_keyinfo_path()).ok().flatten());
        let resumed = pending.and_then(|p| {
            p.kdf.ensure_at_least(&self.kdf).ok()?;
            let keys = KeySet::derive(new, p.salt_bytes().ok()?, p.kdf).ok()?;
            keys.matches_verifier(&p.verifier).then_some((p, keys))
        });
        let (new_info, new_keys) = match resumed {
            Some(found) => found,
            None => {
                let salt = crypto::random_salt();
                let keys = KeySet::derive(new, salt, self.kdf)?;
                let info = KeyInfo {
                    v: 1,
                    store_id: current.store_id.clone(),
                    kdf: self.kdf,
                    salt: hex::encode(salt),
                    verifier: keys.verifier_hex(),
                    created_at: now_ms(),
                    created_by: settings.device_name.clone(),
                };
                (info, keys)
            }
        };

        self.begin("passphrase");
        let result = (|| -> Result<PassphraseChangeReport, AetherError> {
            let mut report = PassphraseChangeReport::default();
            if let Some(store) = &store {
                new_info.write(&store.pending_keyinfo_path())?;
                let old_blobs =
                    migrate_store(store, &old_keys, &new_keys, &mut report, &|done, total| {
                        self.set_progress("passphrase", done, total)
                    })?;
                std::fs::rename(store.pending_keyinfo_path(), store.keyinfo_path())?;
                for path in old_blobs {
                    let _ = std::fs::remove_file(path);
                }
                report.sync_folder = true;
            }
            new_info.write(&self.local_keyinfo_path())?;
            if settings.remember_key {
                self.write_key_file(&new_keys)?;
            }
            Ok(report)
        })();
        if result.is_ok() {
            *lock(&self.keys) = Some(Arc::new(new_keys));
            lock(&self.index_cache).clear();
            let mut state = LocalState::load(&self.state_path());
            state.published_digest = None;
            state.device_published_at = None;
            state.save(&self.state_path())?;
        }
        self.end();
        drop(_op);
        self.wake();
        result
    }

    // ── Backups ──

    fn author(settings: &SyncSettings) -> BackupAuthor<'_> {
        BackupAuthor {
            device_id: &settings.device_id,
            device_name: &settings.device_name,
        }
    }

    fn validate_backup_file(&self, path: &str) -> Result<PathBuf, AetherError> {
        let p = Path::new(path.trim());
        if !p.is_absolute() || !p.is_file() {
            return Err(invalid(format!("backup not found: {path}")));
        }
        let is_backup =
            |p: &Path| p.extension().and_then(|e| e.to_str()) == Some(snapshot::BACKUP_EXT);
        if !is_backup(p) {
            return Err(invalid("not an .aetherbak backup file"));
        }
        let canonical = std::fs::canonicalize(p)?;
        // A symlink named `*.aetherbak` must still point at a backup file.
        if !is_backup(&canonical) || !canonical.is_file() {
            return Err(invalid("not an .aetherbak backup file"));
        }
        Ok(canonical)
    }

    fn do_backup(
        &self,
        settings: &SyncSettings,
        dest: &Path,
        include_app_data: bool,
        scheduled: bool,
    ) -> Result<BackupReport, AetherError> {
        let keys = self.require_keys()?;
        let roots = self.roots(include_app_data);
        if roots.vault.is_none() && !include_app_data {
            return Err(invalid("no vault is configured — nothing to back up"));
        }
        let state = LocalState::load(&self.state_path());
        let (files, _) = snapshot::backup_files(&roots, &state.scan_cache);
        snapshot::create_backup(
            dest,
            &keys,
            &roots,
            &files,
            &Self::author(settings),
            scheduled,
            &|done, total| self.set_progress("backup", done, total),
        )
    }

    /// Create an encrypted backup now (uses the unlocked key).
    pub fn backup_create(
        &self,
        dest_dir: &str,
        include_app_data: bool,
    ) -> Result<BackupReport, AetherError> {
        let dest = self.validate_dir(dest_dir, "backup folder")?;
        let _op = lock(&self.op_lock);
        let settings = self.settings();
        self.begin("backup");
        let result = self.do_backup(&settings, &dest, include_app_data, false);
        self.end();
        result
    }

    /// Backups in a folder, newest first.
    pub fn backup_list(&self, dir: &str) -> Result<Vec<BackupInfo>, AetherError> {
        let dir = self.validate_dir(dir, "backup folder")?;
        snapshot::list_backups(&dir)
    }

    /// Decrypt and check every file of a backup.
    pub fn backup_verify(
        &self,
        path: &str,
        passphrase: &str,
    ) -> Result<BackupVerifyReport, AetherError> {
        let path = self.validate_backup_file(path)?;
        self.begin("verify");
        let result = snapshot::verify_backup(&path, passphrase, &|done, total| {
            self.set_progress("verify", done, total)
        });
        self.end();
        result
    }

    /// Dry-run preview of a backup.
    pub fn backup_preview(
        &self,
        path: &str,
        passphrase: &str,
    ) -> Result<BackupPreview, AetherError> {
        let path = self.validate_backup_file(path)?;
        snapshot::preview_backup(&path, passphrase)
    }

    /// Restore a backup into `target_dir` (see [`RestoreMode`]).
    pub fn backup_restore(
        &self,
        path: &str,
        passphrase: &str,
        target_dir: &str,
        mode: RestoreMode,
    ) -> Result<RestoreReport, AetherError> {
        let path = self.validate_backup_file(path)?;
        let target = self.validate_restore_target(target_dir)?;
        let _op = lock(&self.op_lock);
        let live_vault = self
            .vault
            .detect_vault_path()
            .and_then(|v| std::fs::canonicalize(v).ok());
        let is_live = live_vault.as_ref() == Some(&target);
        // Replacing moves the folder aside; only allow it where that is
        // clearly intended (the live vault or an empty / new folder), so a
        // mistyped target like ~/Documents is never renamed.
        let non_empty = std::fs::read_dir(&target)
            .map(|mut it| it.next().is_some())
            .unwrap_or(false);
        if mode == RestoreMode::Replace && non_empty && !is_live {
            return Err(invalid(
                "replace only works on the current vault or an empty folder — use merge for other folders",
            ));
        }
        self.begin("restore");
        let result = snapshot::restore_backup(
            &path,
            passphrase,
            &RestoreTarget {
                target_dir: &target,
                data_dir: &self.data_dir,
                vault: is_live.then_some(self.vault.as_ref()),
            },
            mode,
            &|done, total| self.set_progress("restore", done, total),
        );
        self.end();
        drop(_op);
        self.wake();
        result
    }

    fn validate_restore_target(&self, input: &str) -> Result<PathBuf, AetherError> {
        let trimmed = input.trim();
        let path = Path::new(trimmed);
        if trimmed.is_empty() || !path.is_absolute() {
            return Err(invalid("the restore folder must be an absolute path"));
        }
        let canonical = if path.exists() {
            if !path.is_dir() {
                return Err(invalid("the restore target is not a folder"));
            }
            std::fs::canonicalize(path)?
        } else {
            let parent = path
                .parent()
                .filter(|p| p.is_dir())
                .ok_or_else(|| invalid("the parent of the restore folder does not exist"))?;
            let name = path
                .file_name()
                .ok_or_else(|| invalid("the restore folder needs a name"))?;
            std::fs::canonicalize(parent)?.join(name)
        };
        check_safe_location(&canonical, "restore folder")?;
        if let Ok(data) = std::fs::canonicalize(&self.data_dir) {
            if canonical.starts_with(&data) {
                return Err(invalid(
                    "the restore folder cannot be inside the AETHER-OS data folder",
                ));
            }
        }
        if let Some(sync_dir) = self.settings().sync_dir {
            if canonical.starts_with(Path::new(&sync_dir).join(folder_sync::STORE_DIR)) {
                return Err(invalid(
                    "the restore folder cannot be inside the sync store",
                ));
            }
        }
        Ok(canonical)
    }

    fn backup_due(&self, settings: &SyncSettings) -> bool {
        if settings.backup_every_hours == 0 || settings.backup_dir.is_none() {
            return false;
        }
        let rt = lock(&self.runtime);
        if rt
            .last_backup_attempt
            .is_some_and(|at| at.elapsed() < BACKUP_RETRY)
        {
            return false;
        }
        let every = i64::from(settings.backup_every_hours) * 3_600_000;
        rt.last_backup_at.map_or(true, |at| now_ms() - at >= every)
    }

    /// Run the scheduled backup (with catch-up) and prune old ones.
    fn run_scheduled_backup(&self, settings: &SyncSettings) -> Result<BackupReport, AetherError> {
        let _op = lock(&self.op_lock);
        lock(&self.runtime).last_backup_attempt = Some(Instant::now());
        let dir = settings
            .backup_dir
            .as_deref()
            .ok_or_else(|| invalid("no backup folder configured"))?;
        let dest = self.validate_dir(dir, "backup folder")?;
        self.begin("backup");
        let result = self
            .do_backup(settings, &dest, settings.backup_include_app_data, true)
            .and_then(|mut report| {
                report.pruned = snapshot::prune_backups(&dest, settings.backup_keep)?;
                Ok(report)
            });
        match &result {
            Ok(_) => {
                let now = now_ms();
                let mut state = LocalState::load(&self.state_path());
                state.last_backup_at = Some(now);
                state.save(&self.state_path())?;
                lock(&self.runtime).last_backup_at = Some(now);
            }
            Err(e) => lock(&self.runtime).message = Some(format!("Scheduled backup failed: {e}")),
        }
        self.end();
        result
    }

    // ── Background loop ──

    /// Wake the background loop (sync soon).
    pub fn wake(&self) {
        let (flag, cv) = &self.wake;
        *lock(flag) = true;
        cv.notify_all();
    }

    /// Start the background thread: folder sync every `interval_seconds`
    /// and scheduled backups (overdue ones run right after unlock).
    pub fn start(self: &Arc<Self>) -> Result<(), AetherError> {
        let engine = Arc::clone(self);
        std::thread::Builder::new()
            .name("aether-sync".into())
            .spawn(move || engine.run_loop())?;
        Ok(())
    }

    fn run_loop(&self) {
        let mut last_round: Option<Instant> = None;
        loop {
            let requested = {
                let (flag, cv) = &self.wake;
                let mut woke = lock(flag);
                if !*woke {
                    woke = cv
                        .wait_timeout(woke, TICK)
                        .map(|(g, _)| g)
                        .unwrap_or_else(|p| p.into_inner().0);
                }
                std::mem::replace(&mut *woke, false)
            };
            if self.stop.load(Ordering::SeqCst) {
                break;
            }
            let settings = self.settings();
            if self.current_keys().is_none() {
                continue;
            }
            if settings.enabled && settings.sync_dir.is_some() {
                let interval =
                    Duration::from_secs(settings.interval_seconds.max(MIN_INTERVAL_SECONDS));
                let due = requested || last_round.map_or(true, |t| t.elapsed() >= interval);
                if due {
                    last_round = Some(Instant::now());
                    // Errors are recorded in the status and retried next time.
                    let _ = self.sync_now();
                }
            }
            if self.backup_due(&settings) {
                let _ = self.run_scheduled_backup(&settings);
            }
        }
    }

    /// Stop the background loop and forget the key.
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.wake();
        *lock(&self.keys) = None;
        lock(&self.index_cache).clear();
    }
}

/// Re-encrypt every object of `store` from `old` to `new`. Returns the old
/// blob files to delete after the switch.
fn migrate_store(
    store: &SyncStore,
    old: &KeySet,
    new: &KeySet,
    report: &mut PassphraseChangeReport,
    progress: &dyn Fn(u32, u32),
) -> Result<Vec<PathBuf>, AetherError> {
    store.ensure_layout()?;
    let blobs = store.list("blobs", ".bin")?;
    let indexes = store.list("index", ".idx")?;
    let devices = store.list("devices", ".json")?;
    let conflicts = store.list("conflicts", ".json")?;
    let total = (blobs.len() + indexes.len() + devices.len() + conflicts.len()) as u32;
    let mut done = 0u32;
    let mut step = || {
        done += 1;
        progress(done, total);
    };
    let old_salt = old.salt_hex();
    let new_salt = new.salt_hex();
    let issue = |report: &mut PassphraseChangeReport, path: &Path, msg: String| {
        report.issues.push(SyncIssue {
            path: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            message: msg,
        });
    };

    // Content hash → a path, to recompute path hashes in blob headers.
    let mut paths_by_hash: HashMap<String, String> = HashMap::new();
    for (device_id, path) in &indexes {
        if let Ok(bytes) = store.read_meta(path) {
            let decoded = folder_sync::decrypt_index(old, device_id, &bytes)
                .or_else(|_| folder_sync::decrypt_index(new, device_id, &bytes));
            if let Ok((index, _)) = decoded {
                for (p, e) in index.entries {
                    if !e.deleted {
                        paths_by_hash.entry(e.content_hash).or_insert(p);
                    }
                }
            }
        }
    }

    let mut old_blobs = Vec::new();
    for (id, path) in &blobs {
        step();
        let bytes = match folder_sync::read_limited(path, folder_sync::MAX_FILE_BYTES + 65_536) {
            Ok(b) => b,
            Err(e) => {
                issue(report, path, e.to_string());
                continue;
            }
        };
        let header = match crypto::peek_header(&bytes) {
            Ok((h, _)) => h,
            Err(e) => {
                issue(report, path, e.to_string());
                continue;
            }
        };
        if header.salt == new_salt {
            continue;
        }
        if header.salt != old_salt {
            issue(
                report,
                path,
                "encrypted with an unknown passphrase; skipped".into(),
            );
            continue;
        }
        let (h, plain) = match old.open(EnvelopeKind::Blob, &bytes) {
            Ok(v) => v,
            Err(e) => {
                issue(report, path, e.to_string());
                continue;
            }
        };
        if h.content_hash.as_deref() != Some(id.as_str()) {
            issue(
                report,
                path,
                "blob header does not match its name; skipped".into(),
            );
            continue;
        }
        let hash = crypto::content_hash(&plain);
        let new_id = new.blob_id(&hash);
        let new_path = store.blob_path(&new_id);
        if !new_path.is_file() {
            let sealed = new.seal(
                EnvelopeKind::Blob,
                HeaderFields {
                    device_id: h.device_id.clone(),
                    path_hash: paths_by_hash.get(&hash).map(|p| new.path_hash(p)),
                    mtime: h.mtime,
                    content_hash: Some(new_id),
                },
                &plain,
            )?;
            folder_sync::write_atomic(&new_path, &sealed, None)?;
        }
        old_blobs.push(path.clone());
        report.blobs += 1;
    }

    let reseal = |kind: EnvelopeKind,
                  path: &Path,
                  report: &mut PassphraseChangeReport|
     -> Result<Option<(crypto::EnvelopeHeader, Vec<u8>)>, AetherError> {
        let bytes = store.read_meta(path)?;
        let (header, _) = crypto::peek_header(&bytes)?;
        if header.salt == new_salt {
            return Ok(None);
        }
        match old.open(kind, &bytes) {
            Ok(v) => Ok(Some(v)),
            Err(e) => {
                issue(report, path, e.to_string());
                Ok(None)
            }
        }
    };

    for (kind, list) in [
        (EnvelopeKind::Index, &indexes),
        (EnvelopeKind::Device, &devices),
    ] {
        for (_, path) in list {
            step();
            if let Some((h, plain)) = reseal(kind, path, report)? {
                let sealed = new.seal(
                    kind,
                    HeaderFields {
                        device_id: h.device_id,
                        ..HeaderFields::default()
                    },
                    &plain,
                )?;
                folder_sync::write_atomic(path, &sealed, None)?;
                match kind {
                    EnvelopeKind::Index => report.indexes += 1,
                    _ => report.devices += 1,
                }
            }
        }
    }

    for (_, path) in &conflicts {
        step();
        if let Some((h, plain)) = reseal(EnvelopeKind::Conflict, path, report)? {
            let mut record: ConflictRecord = match serde_json::from_slice(&plain) {
                Ok(r) => r,
                Err(e) => {
                    issue(report, path, format!("conflict record is corrupt: {e}"));
                    continue;
                }
            };
            record.id = new.path_hash(&record.copy_path)[..32].to_owned();
            let json = serde_json::to_vec(&record)
                .map_err(|e| sync_err(format!("conflict serialize: {e}")))?;
            let sealed = new.seal(
                EnvelopeKind::Conflict,
                HeaderFields {
                    device_id: h.device_id,
                    path_hash: Some(new.path_hash(&record.path)),
                    ..HeaderFields::default()
                },
                &json,
            )?;
            let new_path = store.conflict_path(&record.id);
            folder_sync::write_atomic(&new_path, &sealed, None)?;
            if new_path != *path {
                let _ = std::fs::remove_file(path);
            }
            report.conflicts += 1;
        }
    }
    Ok(old_blobs)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), AetherError> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| sync_err(format!("serialize: {e}")))?;
    folder_sync::write_atomic(path, &bytes, None)
}

/// Write a file readable only by the current user (0600 on Unix).
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), AetherError> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let tmp = path.with_extension("bin.tmp");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        folder_sync::write_atomic(path, bytes, None)
    }
}

/// Reject filesystem roots, the home folder itself and OS system folders.
fn check_safe_location(canonical: &Path, label: &str) -> Result<(), AetherError> {
    if canonical.parent().is_none() {
        return Err(invalid(format!("the {label} cannot be a filesystem root")));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        if let Ok(home) = std::fs::canonicalize(home) {
            if canonical == home {
                return Err(invalid(format!(
                    "the {label} cannot be your home folder itself — pick a sub-folder"
                )));
            }
        }
    }
    const SYSTEM: &[&str] = &[
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/private/etc",
        "/private/var/db",
        "/dev",
        "/proc",
        "/sys",
        "/Library",
        "/Applications",
        "C:\\Windows",
        "C:\\Program Files",
    ];
    if SYSTEM.iter().any(|s| canonical.starts_with(s)) {
        return Err(invalid(format!("the {label} cannot be a system folder")));
    }
    Ok(())
}

fn default_device_name() -> String {
    sysinfo::System::host_name()
        .map(|h| h.trim().trim_end_matches(".local").to_owned())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "This device".to_owned())
}

impl Drop for SyncEngine {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Key material is wrapped in `Zeroizing` and wiped with the Arc.
        *lock(&self.keys) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tempfile::TempDir;

    const PASS: &str = "correct horse battery staple";

    struct Device {
        _data: TempDir,
        _vault_dir: TempDir,
        data: PathBuf,
        vault: PathBuf,
        engine: Arc<SyncEngine>,
    }

    impl Device {
        fn new(sync_dir: &Path, name: &str) -> Self {
            let data = tempfile::tempdir().unwrap();
            let vault_dir = tempfile::tempdir().unwrap();
            let vault = std::fs::canonicalize(vault_dir.path()).unwrap();
            let reader = VaultReader::new(data.path()).unwrap();
            reader.set_vault_path(vault.to_str().unwrap()).unwrap();
            let engine = Arc::new(
                SyncEngine::with_kdf(data.path(), Arc::new(reader), KdfParams::TESTING).unwrap(),
            );
            engine
                .update_settings(SyncSettingsPatch {
                    sync_dir: Some(sync_dir.to_string_lossy().to_string()),
                    device_name: Some(name.to_owned()),
                    include_app_data: Some(false),
                    enabled: Some(true),
                    ..SyncSettingsPatch::default()
                })
                .unwrap();
            Device {
                data: data.path().to_path_buf(),
                _data: data,
                _vault_dir: vault_dir,
                vault,
                engine,
            }
        }

        fn write(&self, rel: &str, content: &str, mtime_ms: i64) {
            let path = self.vault.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, content).unwrap();
            let file = std::fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(UNIX_EPOCH + Duration::from_millis(mtime_ms as u64))
                .unwrap();
        }

        fn read(&self, rel: &str) -> Option<String> {
            std::fs::read_to_string(self.vault.join(rel)).ok()
        }

        fn sync(&self) -> SyncReport {
            self.engine.sync_now().expect("sync round")
        }

        fn files(&self) -> Vec<String> {
            let mut out: Vec<String> = walkdir::WalkDir::new(&self.vault)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file())
                .map(|e| {
                    e.path()
                        .strip_prefix(&self.vault)
                        .unwrap()
                        .to_string_lossy()
                        .to_string()
                })
                .filter(|p| !p.starts_with(".trash"))
                .collect();
            out.sort();
            out
        }
    }

    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    /// Two devices sharing one sync folder, both unlocked.
    fn pair() -> (TempDir, Device, Device) {
        let sync = tempfile::tempdir().unwrap();
        let a = Device::new(sync.path(), "Mac A");
        let b = Device::new(sync.path(), "Mac B");
        a.engine.unlock(PASS, false).unwrap();
        b.engine.unlock(PASS, false).unwrap();
        (sync, a, b)
    }

    fn store_of(sync: &TempDir) -> SyncStore {
        SyncStore::new(&std::fs::canonicalize(sync.path()).unwrap())
    }

    #[test]
    fn first_unlock_creates_the_store_and_second_device_joins() {
        let sync = tempfile::tempdir().unwrap();
        let a = Device::new(sync.path(), "Mac A");
        assert!(!a.engine.status().initialized);
        assert_eq!(a.engine.status().state, SyncState::Locked);
        assert!(a.engine.unlock("short", false).is_err(), "min length");
        a.engine.unlock(PASS, false).unwrap();
        assert!(a.engine.status().unlocked);
        assert!(store_of(&sync).keyinfo_path().is_file());

        let b = Device::new(sync.path(), "Mac B");
        let info = b
            .engine
            .inspect_folder(sync.path().to_str().unwrap())
            .unwrap();
        assert!(info.initialized);
        let err = b.engine.unlock("wrong passphrase!", false).unwrap_err();
        assert!(err.to_string().contains("wrong passphrase"));
        assert!(!b.engine.status().unlocked);
        b.engine.unlock(PASS, false).unwrap();
        assert!(b.engine.status().unlocked);
        assert_eq!(b.engine.status().state, SyncState::Idle);
    }

    #[test]
    fn create_on_a_appears_on_b_and_edit_on_b_updates_a() {
        let (_sync, a, b) = pair();
        let t = now() - 60_000;
        a.write("Projects/Plan.md", "# Plan\n\nv1", t);
        a.write("assets/logo.png", "\u{1}\u{2}binary", t);
        let report = a.sync();
        assert_eq!(report.uploaded, 2);
        let report = b.sync();
        assert_eq!(report.downloaded, 2, "{:?}", report.issues);
        assert_eq!(b.read("Projects/Plan.md").unwrap(), "# Plan\n\nv1");
        assert_eq!(b.read("assets/logo.png").unwrap(), "\u{1}\u{2}binary");
        // mtimes travel with the content.
        let meta = std::fs::metadata(b.vault.join("Projects/Plan.md")).unwrap();
        assert_eq!(folder_sync::system_time_ms(meta.modified().unwrap()), t);

        b.write("Projects/Plan.md", "# Plan\n\nv2 from B", t + 10_000);
        assert_eq!(b.sync().uploaded, 1);
        let report = a.sync();
        assert_eq!(report.downloaded, 1);
        assert_eq!(a.read("Projects/Plan.md").unwrap(), "# Plan\n\nv2 from B");
        // Nothing left to do.
        let again = a.sync();
        assert_eq!(again.uploaded + again.downloaded + again.conflicts, 0);
        assert_eq!(a.engine.devices().unwrap().len(), 2);
    }

    #[test]
    fn concurrent_edits_create_a_conflict_copy_and_lose_nothing() {
        let (_sync, a, b) = pair();
        let t = now() - 120_000;
        a.write("Note.md", "base", t);
        a.sync();
        b.sync();
        a.write("Note.md", "edited on A", t + 1_000);
        b.write("Note.md", "edited on B (newer)", t + 2_000);
        a.sync();
        let report = b.sync();
        assert_eq!(report.conflicts, 1, "{:?}", report.issues);
        a.sync();

        for device in [&a, &b] {
            let files = device.files();
            assert_eq!(files.len(), 2, "{files:?}");
            assert_eq!(device.read("Note.md").unwrap(), "edited on B (newer)");
            let copy = files
                .iter()
                .find(|f| f.contains("(conflict from Mac A"))
                .unwrap();
            assert_eq!(device.read(copy).unwrap(), "edited on A");
        }

        let conflicts = a.engine.list_conflicts().unwrap();
        assert_eq!(conflicts.len(), 1);
        let c = &conflicts[0];
        assert!(!c.resolved);
        assert!(c.copy_exists);
        assert_eq!(c.display_path, "Note.md");
        assert_eq!(c.current.device_name, "Mac B");
        assert!(c.other.is_this_device);
        assert_eq!(a.engine.status().conflicts, 1);

        let detail = a.engine.get_conflict(&c.id).unwrap();
        assert_eq!(
            detail.current_content.as_deref(),
            Some("edited on B (newer)")
        );
        assert_eq!(detail.other_content.as_deref(), Some("edited on A"));
        assert!(!detail.binary);

        // Keep the other version: the note takes the copy's content and the
        // copy goes to the trash; the change syncs to B.
        let resolved = a
            .engine
            .resolve_conflict(&c.id, KeepChoice::Remote)
            .unwrap();
        assert!(resolved.resolved);
        assert_eq!(a.read("Note.md").unwrap(), "edited on A");
        assert_eq!(a.files(), vec!["Note.md".to_string()]);
        assert!(a.engine.resolve_conflict(&c.id, KeepChoice::Both).is_err());
        a.sync();
        b.sync();
        assert_eq!(b.read("Note.md").unwrap(), "edited on A");
        assert_eq!(b.files(), vec!["Note.md".to_string()]);
        let on_b = b.engine.list_conflicts().unwrap();
        assert!(on_b[0].resolved);
        assert_eq!(on_b[0].resolution, Some(KeepChoice::Remote));
        assert_eq!(b.engine.status().conflicts, 0);
    }

    #[test]
    fn keep_local_and_keep_both_resolutions() {
        let (_sync, a, b) = pair();
        let t = now() - 120_000;
        a.write("x.md", "base", t);
        a.write("y.md", "base", t);
        a.sync();
        b.sync();
        a.write("x.md", "A-x", t + 1_000);
        a.write("y.md", "A-y", t + 1_000);
        b.write("x.md", "B-x!", t + 2_000);
        b.write("y.md", "B-y!", t + 2_000);
        a.sync();
        assert_eq!(b.sync().conflicts, 2);
        let conflicts = b.engine.list_conflicts().unwrap();
        let x = conflicts.iter().find(|c| c.path == "vault/x.md").unwrap();
        let y = conflicts.iter().find(|c| c.path == "vault/y.md").unwrap();
        b.engine.resolve_conflict(&x.id, KeepChoice::Local).unwrap();
        b.engine.resolve_conflict(&y.id, KeepChoice::Both).unwrap();
        assert_eq!(b.read("x.md").unwrap(), "B-x!");
        let files = b.files();
        assert!(files
            .iter()
            .any(|f| f.starts_with("y (conflict from Mac A")));
        assert!(!files.iter().any(|f| f.starts_with("x (conflict")));
        // The trashed copy is kept in the vault trash, never destroyed.
        assert!(b.vault.join(".trash").is_dir());
    }

    #[test]
    fn deletion_propagates_to_the_trash_of_other_devices() {
        let (_sync, a, b) = pair();
        let t = now() - 60_000;
        a.write("gone.md", "bye", t);
        a.write("stay.md", "hi", t);
        a.sync();
        b.sync();
        std::fs::remove_file(a.vault.join("gone.md")).unwrap();
        assert_eq!(a.sync().deleted_remote, 1);
        let report = b.sync();
        assert_eq!(report.deleted_local, 1);
        assert_eq!(b.files(), vec!["stay.md".to_string()]);
        assert_eq!(
            std::fs::read_to_string(b.vault.join(".trash/gone.md")).unwrap(),
            "bye"
        );
        // The tombstone does not resurrect or re-delete anything.
        let again = a.sync();
        assert_eq!(again.downloaded + again.uploaded, 0);
    }

    #[test]
    fn weaker_kdf_parameters_in_the_sync_folder_are_rejected() {
        let (sync, a, _b) = pair();
        a.sync();
        assert!(store_of(&sync).read_keyinfo().unwrap().is_some());

        // A device that creates keys with stronger parameters must refuse
        // the weaker header written by `a` instead of deriving with it.
        let data = tempfile::tempdir().unwrap();
        let vault_dir = tempfile::tempdir().unwrap();
        let reader = VaultReader::new(data.path()).unwrap();
        reader
            .set_vault_path(vault_dir.path().to_str().unwrap())
            .unwrap();
        let strong = KdfParams {
            m_kib: 128,
            t: 2,
            ..KdfParams::TESTING
        };
        let engine = SyncEngine::with_kdf(data.path(), Arc::new(reader), strong).unwrap();
        engine
            .update_settings(SyncSettingsPatch {
                sync_dir: Some(sync.path().to_string_lossy().to_string()),
                enabled: Some(true),
                ..SyncSettingsPatch::default()
            })
            .unwrap();
        let err = engine.unlock(PASS, false).unwrap_err().to_string();
        assert!(err.contains("weaker"), "{err}");
        assert!(!engine.status().unlocked);
    }

    #[test]
    fn corrupted_blob_is_skipped_and_reported() {
        let (sync, a, b) = pair();
        let t = now() - 60_000;
        a.write("good.md", "fine", t);
        a.write("bad.md", "will be corrupted", t);
        a.sync();
        let store = store_of(&sync);
        let keys = a.engine.current_keys().unwrap();
        let bad_id = keys.blob_id(&crypto::content_hash(b"will be corrupted"));
        let blob = store.blob_path(&bad_id);
        let mut bytes = std::fs::read(&blob).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x55;
        std::fs::write(&blob, bytes).unwrap();

        let report = b.sync();
        assert_eq!(report.downloaded, 1);
        assert_eq!(report.pending_downloads, 1);
        assert!(report
            .issues
            .iter()
            .any(|i| i.path == "vault/bad.md" && i.message.contains("decryption failed")));
        assert_eq!(b.read("good.md").unwrap(), "fine");
        assert!(b.read("bad.md").is_none());
        assert_eq!(b.engine.status().pending_downloads, 1);
    }

    #[test]
    fn sync_folder_holds_no_plaintext_names_or_contents() {
        let (sync, a, _b) = pair();
        a.write(
            "Secret Diary/Confession.md",
            "the butler did it",
            now() - 60_000,
        );
        a.sync();
        for entry in walkdir::WalkDir::new(sync.path())
            .into_iter()
            .filter_map(Result::ok)
        {
            let name = entry.file_name().to_string_lossy().to_string();
            assert!(
                !name.contains("Confession") && !name.contains("Diary"),
                "{name}"
            );
            if entry.file_type().is_file() {
                let raw = std::fs::read(entry.path()).unwrap();
                let text = String::from_utf8_lossy(&raw);
                assert!(!text.contains("butler"));
                assert!(!text.contains("Confession"));
            }
        }
    }

    #[test]
    fn passphrase_change_keeps_everything_decryptable() {
        let (sync, a, b) = pair();
        let t = now() - 60_000;
        a.write("one.md", "first", t);
        a.write("two.md", "second", t);
        a.sync();
        b.sync();
        a.write("x.md", "unsynced", t + 5_000);

        assert!(a
            .engine
            .change_passphrase("nope nope nope", "new passphrase 2")
            .is_err());
        assert!(a.engine.change_passphrase(PASS, "short").is_err());
        let report = a
            .engine
            .change_passphrase(PASS, "a brand new passphrase")
            .unwrap();
        assert!(report.sync_folder);
        assert_eq!(report.blobs, 2);
        assert_eq!(report.indexes, 2);
        assert_eq!(report.devices, 2);
        assert!(report.issues.is_empty(), "{:?}", report.issues);
        let store = store_of(&sync);
        assert!(!store.pending_keyinfo_path().exists());
        let new_salt = a.engine.current_keys().unwrap().salt_hex();
        for (_, path) in store.list("blobs", ".bin").unwrap() {
            let (header, _) = crypto::peek_header(&std::fs::read(path).unwrap()).unwrap();
            assert_eq!(header.salt, new_salt);
        }

        // A keeps syncing with the new key.
        assert_eq!(a.sync().uploaded, 1);
        // B notices the change, locks itself and needs the new passphrase.
        assert!(b.engine.sync_now().is_err());
        assert!(!b.engine.status().unlocked);
        assert!(b.engine.unlock(PASS, false).is_err());
        b.engine.unlock("a brand new passphrase", false).unwrap();
        let report = b.sync();
        assert_eq!(report.downloaded, 1, "{:?}", report.issues);
        assert_eq!(b.read("x.md").unwrap(), "unsynced");
        assert_eq!(b.read("one.md").unwrap(), "first");
        // Old content is still fetchable under the new key.
        std::fs::remove_file(b.vault.join("one.md")).unwrap();
        let mut state = LocalState::load(&b.data.join("sync/state.json"));
        state.base.remove("vault/one.md");
        state.save(&b.data.join("sync/state.json")).unwrap();
        b.sync();
        assert_eq!(b.read("one.md").unwrap(), "first");
    }

    #[test]
    fn remembered_key_is_private_and_auto_unlocks() {
        let (_sync, a, _b) = pair();
        a.engine.unlock(PASS, true).unwrap();
        let key_file = a.data.join("sync/key.bin");
        assert!(key_file.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&key_file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(a.engine.status().remembered);
        a.engine.lock();
        assert!(!a.engine.status().unlocked);
        assert!(a.engine.try_auto_unlock());
        assert!(a.engine.status().unlocked);
        // Turning it off deletes the key file.
        a.engine
            .update_settings(SyncSettingsPatch {
                remember_key: Some(false),
                ..SyncSettingsPatch::default()
            })
            .unwrap();
        assert!(!key_file.exists());
        a.engine.lock();
        assert!(!a.engine.try_auto_unlock());
        // The passphrase itself is never written anywhere.
        for entry in walkdir::WalkDir::new(&a.data)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_type().is_file() {
                let raw = std::fs::read(entry.path()).unwrap();
                assert!(!String::from_utf8_lossy(&raw).contains(PASS));
            }
        }
    }

    #[test]
    fn app_data_syncs_when_enabled() {
        let (_sync, a, b) = pair();
        for d in [&a, &b] {
            d.engine
                .update_settings(SyncSettingsPatch {
                    include_app_data: Some(true),
                    ..SyncSettingsPatch::default()
                })
                .unwrap();
        }
        let facts = a.data.join("memory/facts.json");
        std::fs::create_dir_all(facts.parent().unwrap()).unwrap();
        std::fs::write(&facts, r#"[{"fact":"likes tea"}]"#).unwrap();
        std::fs::create_dir_all(a.data.join("ai")).unwrap();
        std::fs::write(a.data.join("ai/ai_config.json"), r#"{"key":"sk-secret"}"#).unwrap();
        a.sync();
        b.sync();
        assert_eq!(
            std::fs::read_to_string(b.data.join("memory/facts.json")).unwrap(),
            r#"[{"fact":"likes tea"}]"#
        );
        // API keys and other app files are never synced.
        assert!(!b.data.join("ai/ai_config.json").exists());
    }

    #[test]
    fn settings_are_validated() {
        let (sync, a, _b) = pair();
        let inside_vault = a.vault.join("sync-here");
        std::fs::create_dir_all(&inside_vault).unwrap();
        let err = a
            .engine
            .update_settings(SyncSettingsPatch {
                sync_dir: Some(inside_vault.to_string_lossy().to_string()),
                ..SyncSettingsPatch::default()
            })
            .unwrap_err();
        assert!(err.to_string().contains("inside the vault"));
        for bad in ["relative/dir", "/", "/definitely/not/here"] {
            assert!(a
                .engine
                .update_settings(SyncSettingsPatch {
                    sync_dir: Some(bad.into()),
                    ..SyncSettingsPatch::default()
                })
                .is_err());
        }
        assert!(a
            .engine
            .update_settings(SyncSettingsPatch {
                interval_seconds: Some(1),
                ..SyncSettingsPatch::default()
            })
            .is_err());
        assert!(a
            .engine
            .update_settings(SyncSettingsPatch {
                backup_every_hours: Some(24),
                ..SyncSettingsPatch::default()
            })
            .is_err());
        // Changing the folder locks the key.
        let other = tempfile::tempdir().unwrap();
        a.engine
            .update_settings(SyncSettingsPatch {
                sync_dir: Some(other.path().to_string_lossy().to_string()),
                ..SyncSettingsPatch::default()
            })
            .unwrap();
        assert!(!a.engine.status().unlocked);
        assert!(a.engine.status().message.is_some());
        drop(sync);
    }

    #[test]
    fn fresh_folder_gets_a_new_store_and_a_full_upload() {
        let (_sync, a, _b) = pair();
        a.write("n.md", "note", now() - 60_000);
        a.sync();
        let other = tempfile::tempdir().unwrap();
        a.engine
            .update_settings(SyncSettingsPatch {
                sync_dir: Some(other.path().to_string_lossy().to_string()),
                ..SyncSettingsPatch::default()
            })
            .unwrap();
        a.engine.unlock(PASS, false).unwrap();
        let report = a.sync();
        assert_eq!(report.uploaded, 1, "base must reset for a new store");
    }

    #[test]
    fn engine_backups_scheduled_catch_up_and_prune() {
        let (_sync, a, _b) = pair();
        a.write("n.md", "note", now() - 60_000);
        let backups = tempfile::tempdir().unwrap();
        let dir = backups.path().to_string_lossy().to_string();
        let manual = a.engine.backup_create(&dir, false).unwrap();
        assert_eq!(manual.files, 1);
        a.engine
            .update_settings(SyncSettingsPatch {
                backup_dir: Some(dir.clone()),
                backup_every_hours: Some(24),
                backup_keep: Some(2),
                ..SyncSettingsPatch::default()
            })
            .unwrap();
        let settings = a.engine.settings();
        // Never backed up → due immediately (catch-up on launch).
        assert!(a.engine.backup_due(&settings));
        for _ in 0..3 {
            lock(&a.engine.runtime).last_backup_attempt = None;
            a.engine.run_scheduled_backup(&settings).unwrap();
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!a.engine.backup_due(&settings));
        assert!(a.engine.status().last_backup_at.is_some());
        assert!(a.engine.status().next_backup_at.is_some());
        let listed = a.engine.backup_list(&dir).unwrap();
        assert_eq!(listed.iter().filter(|b| b.scheduled).count(), 2);
        assert_eq!(listed.iter().filter(|b| !b.scheduled).count(), 1);

        let preview = a.engine.backup_preview(&manual.path, PASS).unwrap();
        assert_eq!(preview.file_count, 1);
        assert!(a.engine.backup_verify(&manual.path, PASS).unwrap().ok);
        let target = backups.path().join("restore-here");
        let restored = a
            .engine
            .backup_restore(
                &manual.path,
                PASS,
                &target.to_string_lossy(),
                RestoreMode::Merge,
            )
            .unwrap();
        assert_eq!(restored.restored, 1);
        assert_eq!(
            std::fs::read_to_string(target.join("n.md")).unwrap(),
            "note"
        );
        assert!(a
            .engine
            .backup_restore(&manual.path, PASS, "relative", RestoreMode::Merge)
            .is_err());
        // Replace is refused for a non-empty folder that is not the vault…
        let err = a
            .engine
            .backup_restore(
                &manual.path,
                PASS,
                &target.to_string_lossy(),
                RestoreMode::Replace,
            )
            .unwrap_err();
        assert!(err.to_string().contains("use merge"));
        // …but moves the live vault aside first.
        std::fs::write(a.vault.join("n.md"), "changed after the backup").unwrap();
        let replaced = a
            .engine
            .backup_restore(
                &manual.path,
                PASS,
                &a.vault.to_string_lossy(),
                RestoreMode::Replace,
            )
            .unwrap();
        let moved = PathBuf::from(replaced.moved_existing_to.expect("moved aside"));
        assert_eq!(
            std::fs::read_to_string(moved.join("n.md")).unwrap(),
            "changed after the backup"
        );
        assert_eq!(
            std::fs::read_to_string(a.vault.join("n.md")).unwrap(),
            "note"
        );
        let _ = std::fs::remove_dir_all(&moved);
        assert!(a
            .engine
            .backup_restore(
                &manual.path,
                PASS,
                &a.data.join("x").to_string_lossy(),
                RestoreMode::Merge
            )
            .is_err());
    }

    #[test]
    fn lock_drops_the_key_material() {
        let (_sync, a, _b) = pair();
        a.sync();
        assert!(a.engine.current_keys().is_some());
        let status = a.engine.lock();
        assert!(!status.unlocked);
        assert!(a.engine.current_keys().is_none(), "the key set is released");
        assert!(a.engine.sync_now().is_err(), "nothing runs without the key");
    }

    #[test]
    fn backups_require_an_unlocked_key() {
        let sync = tempfile::tempdir().unwrap();
        let a = Device::new(sync.path(), "Mac A");
        let out = tempfile::tempdir().unwrap();
        let err = a
            .engine
            .backup_create(&out.path().to_string_lossy(), false)
            .unwrap_err();
        assert!(err.to_string().contains("locked"));
        assert!(a.engine.sync_now().is_err());
    }

    #[test]
    fn events_are_emitted() {
        let (_sync, a, _b) = pair();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        a.engine.set_emitter(Arc::new(move |event| {
            let label = match event {
                SyncEvent::Status(s) => format!("status:{:?}", s.state),
                SyncEvent::Progress(p) => format!("progress:{}", p.operation),
            };
            lock(&sink).push(label);
        }));
        a.write("n.md", "note", now() - 60_000);
        a.sync();
        let seen = lock(&seen);
        assert!(seen.iter().any(|e| e == "status:Syncing"));
        assert!(seen.iter().any(|e| e == "progress:sync"));
        assert_eq!(seen.last().map(String::as_str), Some("status:Idle"));
    }

    #[test]
    fn background_loop_syncs_and_stops() {
        let (_sync, a, b) = pair();
        a.write("bg.md", "from the loop", now() - 60_000);
        a.engine.start().unwrap();
        a.engine.wake();
        let deadline = Instant::now() + Duration::from_secs(10);
        while a.engine.status().last_sync_at.is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        a.engine.shutdown();
        assert!(!a.engine.status().unlocked);
        b.sync();
        assert_eq!(b.read("bg.md").unwrap(), "from the loop");
    }
}
