//! Folder sync: end-to-end encrypted multi-device sync through any shared
//! folder (iCloud Drive, Dropbox, Syncthing, a USB stick, a NAS share).
//!
//! # Sync folder layout (`<sync_dir>/aether-sync/v1/`)
//!
//! ```text
//! keyinfo.json              plaintext: store id, KDF params, salt, verifier
//! devices/<device_id>.json  encrypted device record (name, platform, last seen)
//! index/<device_id>.idx     encrypted index of that device: path → IndexEntry
//! blobs/<blob_id>.bin       encrypted file contents, content-addressed (dedupe)
//! conflicts/<id>.json       encrypted conflict records
//! ```
//!
//! Blob names are keyed hashes of the plaintext content hash and the index
//! maps logical paths to entries only inside its encrypted payload, so the
//! folder reveals neither file names nor contents.
//!
//! # Logical paths
//!
//! `vault/<relative path>` for vault files, `app/<store>/<file>.json` for the
//! optional app data (memory, calendar events, tasks, AETHER notes) and
//! `app-conflicts/<…>` for conflict copies of app data.
//!
//! # Algorithm
//!
//! Every device keeps a *base* — the last common version of every path it
//! has synced. One round:
//!
//! 1. scan the local files (hashes are cached by size + mtime),
//! 2. decrypt every other device's index and take the best entry per path by
//!    `(version, mtime, device id)` — `version` is a Lamport-style counter per
//!    path: a new version is always `max(all known) + 1`,
//! 3. [`plan`] compares local ↔ base ↔ remote per path (pure, tested),
//! 4. execute: upload changed blobs, download remote-newer blobs, apply
//!    deletions (moved to the trash, never destroyed), resolve conflicts by
//!    keeping the newer version at the path and writing the other one as a
//!    conflict copy — nothing is ever lost,
//! 5. publish our index (only when it changed) and device record.
//!
//! Tombstones are kept for 30 days. Unreferenced blobs are garbage collected
//! after a 7-day grace period, once a day.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use super::conflict::{self, ConflictRecord, ConflictSide};
use super::crypto::{self, EnvelopeKind, HeaderFields, KdfParams, KeySet};
use crate::engine::error::AetherError;
use crate::engine::fs_guard;
use crate::engine::vault_reader::VaultReader;

/// Top-level folder created inside the user's sync folder.
pub const STORE_DIR: &str = "aether-sync";
/// Layout version directory.
pub const STORE_VERSION_DIR: &str = "v1";
/// How long deletions are remembered.
pub const TOMBSTONE_TTL_MS: i64 = 30 * 24 * 3600 * 1000;
/// Files larger than this are skipped (and reported).
pub const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
/// Namespace of vault files.
pub const NS_VAULT: &str = "vault";
/// Namespace of app-data JSON stores.
pub const NS_APP: &str = "app";
/// Namespace of app-data conflict copies.
pub const NS_APP_CONFLICTS: &str = "app-conflicts";
/// App-data folders (relative to the app data dir) that are synced when
/// "include app data" is on. Only `*.json` files inside them are included.
pub const APP_DATA_DIRS: &[&str] = &[
    "memory",
    "calendar/events",
    "tasks/projects",
    "tasks/items",
    "aether/notes",
];
/// Where app-data conflict copies live (relative to the app data dir).
pub const APP_CONFLICTS_DIR: &str = "sync/conflict-copies";
/// Where app-data files removed by sync are moved (relative to the app data dir).
pub const APP_TRASH_DIR: &str = "sync/trash";

const BLOB_GC_GRACE_MS: i64 = 7 * 24 * 3600 * 1000;
const GC_INTERVAL_MS: i64 = 24 * 3600 * 1000;
const DEVICE_REFRESH_MS: i64 = 10 * 60 * 1000;
const TMP_MARKER: &str = ".aether-tmp-";
/// Cached hashes are only trusted for files older than this.
const CACHE_TRUST_MS: i64 = 2_000;
const MAX_META_BYTES: u64 = 64 * 1024 * 1024;
const MAX_KEYINFO_BYTES: u64 = 64 * 1024;
/// Envelope overhead allowance when reading a blob of known size.
const ENVELOPE_SLACK: u64 = 64 * 1024;
/// Highest version counter accepted from a remote index. Real counters grow
/// by one per edit; the bound keeps `version + 1` from overflowing.
pub const MAX_VERSION: u64 = 1 << 53;

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    system_time_ms(SystemTime::now())
}

/// Convert a `SystemTime` to epoch milliseconds (0 before 1970).
pub fn system_time_ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn ms_to_system_time(ms: i64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64)
}

/// A per-file problem that did not stop the round.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncIssue {
    /// Logical path (or store object) concerned.
    pub path: String,
    /// What went wrong.
    pub message: String,
}

impl SyncIssue {
    fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

/// Result of one sync round.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncReport {
    /// RFC 3339 start time.
    pub started_at: String,
    /// RFC 3339 end time.
    pub finished_at: String,
    /// Wall time of the round.
    pub duration_ms: u64,
    /// Files uploaded as new versions.
    pub uploaded: u32,
    /// Files written locally from other devices.
    pub downloaded: u32,
    /// Local files moved to the trash because another device deleted them.
    pub deleted_local: u32,
    /// Local deletions published as tombstones.
    pub deleted_remote: u32,
    /// Paths that were already identical on both sides.
    pub adopted: u32,
    /// Conflicts detected in this round.
    pub conflicts: u32,
    /// Uploads that could not be completed (retried next round).
    pub pending_uploads: u32,
    /// Downloads that could not be completed (retried next round).
    pub pending_downloads: u32,
    /// Encrypted bytes written to the sync folder.
    pub bytes_up: u64,
    /// Plaintext bytes written locally.
    pub bytes_down: u64,
    /// Devices whose index was read (including this one).
    pub devices: u32,
    /// Files tracked on this device after the round.
    pub files: u32,
    /// Skipped files and other non-fatal problems.
    pub issues: Vec<SyncIssue>,
}

// ── Local state ────────────────────────────────────────────────────────

/// Metadata of a local file (also the scan cache entry).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalMeta {
    /// Plain BLAKE3 hex of the content.
    pub content_hash: String,
    /// Size in bytes.
    pub size: u64,
    /// Modification time (ms).
    pub mtime: i64,
}

/// One version of one path as published in a device index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexEntry {
    /// Plain BLAKE3 hex of the content (empty for tombstones).
    pub content_hash: String,
    /// Size in bytes.
    pub size: u64,
    /// Modification time of that version (ms).
    pub mtime: i64,
    /// Tombstone flag.
    pub deleted: bool,
    /// When the deletion happened (ms).
    #[serde(default)]
    pub deleted_at: Option<i64>,
    /// Lamport-style version counter of the path.
    pub version: u64,
    /// Device id that authored this version.
    pub device: String,
    /// Name of that device.
    #[serde(default)]
    pub device_name: String,
}

impl IndexEntry {
    /// Total order used to pick the newest version.
    fn order_key(&self) -> (u64, i64, &str) {
        (self.version, self.mtime, self.device.as_str())
    }

    /// Strictly newer than `other`.
    pub fn is_newer_than(&self, other: &IndexEntry) -> bool {
        self.order_key() > other.order_key()
    }

    fn matches_local(&self, local: Option<&LocalMeta>) -> bool {
        match local {
            Some(l) => !self.deleted && self.content_hash == l.content_hash,
            None => self.deleted,
        }
    }
}

/// A device's published index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceIndex {
    /// Payload version.
    pub v: u32,
    /// Author device.
    pub device_id: String,
    /// Author device name.
    pub device_name: String,
    /// When it was written (ms).
    pub generated_at: i64,
    /// Logical path → newest known version on that device.
    pub entries: BTreeMap<String, IndexEntry>,
}

/// A device's published record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceRecord {
    /// Payload version.
    pub v: u32,
    /// Device id.
    pub device_id: String,
    /// Device name.
    pub device_name: String,
    /// `macos`, `windows`, `linux`, …
    pub platform: String,
    /// App version that wrote the record.
    pub app_version: String,
    /// Last successful sync (ms).
    pub last_seen: i64,
    /// Files in its index (tombstones excluded).
    pub file_count: u64,
}

/// Persistent per-device sync state (`<data_dir>/sync/state.json`). Paths are
/// stored in plaintext here: it never leaves this device.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LocalState {
    /// Payload version.
    #[serde(default)]
    pub v: u32,
    /// Store the base belongs to; a different store resets the base.
    #[serde(default)]
    pub store_id: Option<String>,
    /// Last common version per path.
    #[serde(default)]
    pub base: BTreeMap<String, IndexEntry>,
    /// Hash cache keyed by logical path.
    #[serde(default)]
    pub scan_cache: BTreeMap<String, LocalMeta>,
    /// Last successful round (ms).
    #[serde(default)]
    pub last_sync_at: Option<i64>,
    /// Last scheduled or manual backup (ms).
    #[serde(default)]
    pub last_backup_at: Option<i64>,
    /// Digest of the last published index entries.
    #[serde(default)]
    pub published_digest: Option<String>,
    /// Last device record publication (ms).
    #[serde(default)]
    pub device_published_at: Option<i64>,
    /// Last blob garbage collection (ms).
    #[serde(default)]
    pub last_gc_at: Option<i64>,
}

impl LocalState {
    /// Load from disk; a missing or unreadable file yields a fresh state.
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Persist atomically.
    pub fn save(&self, path: &Path) -> Result<(), AetherError> {
        let bytes = serde_json::to_vec(self)
            .map_err(|e| AetherError::Sync(format!("state serialize: {e}")))?;
        write_atomic(path, &bytes, None)
    }

    /// Point the state at `store_id`, forgetting the base of any other store.
    pub fn bind_store(&mut self, store_id: &str) {
        if self.store_id.as_deref() != Some(store_id) {
            self.store_id = Some(store_id.to_owned());
            self.base.clear();
            self.published_digest = None;
            self.device_published_at = None;
            self.last_gc_at = None;
        }
    }
}

// ── Key info ───────────────────────────────────────────────────────────

/// Plaintext key parameters of a sync store (also cached locally).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyInfo {
    /// Payload version.
    pub v: u32,
    /// Random id of the store (changes when a fresh folder is initialised).
    pub store_id: String,
    /// Argon2id parameters.
    pub kdf: KdfParams,
    /// Hex salt.
    pub salt: String,
    /// Hex verifier (`blake3(master || "verify")`).
    pub verifier: String,
    /// Creation time (ms).
    pub created_at: i64,
    /// Name of the device that created the key.
    pub created_by: String,
}

impl KeyInfo {
    /// Reject malformed or hostile key files.
    pub fn validate(&self) -> Result<(), AetherError> {
        if self.v != 1 {
            return Err(AetherError::Crypto(format!(
                "unsupported key file version {}",
                self.v
            )));
        }
        self.kdf.validate()?;
        crypto::parse_salt(&self.salt)?;
        if blake3::Hash::from_hex(self.verifier.trim()).is_err() {
            return Err(AetherError::Crypto("key file verifier is malformed".into()));
        }
        if !is_valid_id(&self.store_id) {
            return Err(AetherError::Crypto("key file store id is malformed".into()));
        }
        Ok(())
    }

    /// Parsed salt bytes.
    pub fn salt_bytes(&self) -> Result<[u8; crypto::SALT_LEN], AetherError> {
        crypto::parse_salt(&self.salt)
    }

    /// Read and validate a key file; `None` when it does not exist.
    pub fn read(path: &Path) -> Result<Option<Self>, AetherError> {
        if !path.is_file() {
            return Ok(None);
        }
        let bytes = read_limited(path, MAX_KEYINFO_BYTES)?;
        let info: KeyInfo = serde_json::from_slice(&bytes)
            .map_err(|e| AetherError::Crypto(format!("key file is corrupt: {e}")))?;
        info.validate()?;
        Ok(Some(info))
    }

    /// Write atomically as pretty JSON.
    pub fn write(&self, path: &Path) -> Result<(), AetherError> {
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|e| AetherError::Crypto(format!("key file serialize: {e}")))?;
        write_atomic(path, &bytes, None)
    }
}

/// Ids used in file names (device ids, store ids, conflict ids).
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// ── File helpers ───────────────────────────────────────────────────────

/// Read a file, refusing anything larger than `max` bytes.
pub fn read_limited(path: &Path, max: u64) -> Result<Vec<u8>, AetherError> {
    let file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    if len > max {
        return Err(AetherError::Sync(format!(
            "{} is too large ({len} bytes)",
            path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(AetherError::Sync(format!(
            "{} grew beyond the size limit",
            path.display()
        )));
    }
    Ok(bytes)
}

/// Write `bytes` via a temp file in the same directory and an atomic rename;
/// optionally set the modification time first.
pub fn write_atomic(path: &Path, bytes: &[u8], mtime_ms: Option<i64>) -> Result<(), AetherError> {
    let parent = path
        .parent()
        .ok_or_else(|| AetherError::Sync("path has no parent directory".into()))?;
    std::fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut suffix = [0u8; 6];
    rand::rngs::OsRng.fill_bytes(&mut suffix);
    let tmp = parent.join(format!(".{name}{TMP_MARKER}{}", hex::encode(suffix)));
    let result = (|| -> Result<(), AetherError> {
        std::fs::write(&tmp, bytes)?;
        if let Some(ms) = mtime_ms {
            let file = std::fs::File::options().write(true).open(&tmp)?;
            file.set_modified(ms_to_system_time(ms))?;
        }
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn set_mtime(path: &Path, ms: i64) -> Result<(), AetherError> {
    let file = std::fs::File::options().write(true).open(path)?;
    file.set_modified(ms_to_system_time(ms))?;
    Ok(())
}

fn file_meta(path: &Path) -> Result<(u64, i64), AetherError> {
    let meta = std::fs::metadata(path)?;
    Ok((meta.len(), meta.modified().map(system_time_ms).unwrap_or(0)))
}

/// Move `path` to `dest`, adding " 2", " 3", … when `dest` exists.
fn move_unique(path: &Path, dest: &Path) -> Result<PathBuf, AetherError> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let dest_str = dest.to_string_lossy().to_string();
    for n in 1..10_000u32 {
        let candidate = PathBuf::from(conflict::numbered_path(&dest_str, n));
        if !candidate.exists() {
            std::fs::rename(path, &candidate)?;
            return Ok(candidate);
        }
    }
    Err(AetherError::Sync(format!(
        "no free name to move {} to",
        path.display()
    )))
}

// ── Logical paths ──────────────────────────────────────────────────────

/// Split and validate a logical path into namespace + components.
pub fn split_virtual(path: &str) -> Result<(&str, Vec<&str>), AetherError> {
    let invalid = || AetherError::Sync(format!("invalid sync path: {path}"));
    if path.is_empty() || path.len() > 1024 || path.contains('\0') || path.contains('\\') {
        return Err(invalid());
    }
    let mut parts = path.split('/');
    let ns = parts.next().ok_or_else(invalid)?;
    if ![NS_VAULT, NS_APP, NS_APP_CONFLICTS].contains(&ns) {
        return Err(invalid());
    }
    let rest: Vec<&str> = parts.collect();
    if rest.is_empty()
        || rest
            .iter()
            .any(|c| c.is_empty() || *c == "." || *c == ".." || (cfg!(windows) && c.contains(':')))
    {
        return Err(invalid());
    }
    Ok((ns, rest))
}

/// Is this vault-relative path excluded from sync? Names are compared
/// case-insensitively: on a case-insensitive file system `.GIT` *is* the
/// repository folder, so a remote entry must not be able to reach it by
/// spelling it differently.
pub fn is_excluded_vault_path(components: &[&str]) -> bool {
    for c in components {
        let lower = c.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            ".git" | ".trash" | ".nopes" | ".ds_store" | "thumbs.db" | "desktop.ini"
        ) || lower.starts_with(".aether")
            || c.contains(TMP_MARKER)
        {
            return true;
        }
    }
    components
        .first()
        .is_some_and(|c| c.eq_ignore_ascii_case(".obsidian"))
        && components.get(1).is_some_and(|c| {
            let lower = c.to_ascii_lowercase();
            lower.starts_with("workspace") || lower == "cache"
        })
}

fn is_allowed_app_path(rest: &[&str]) -> bool {
    let joined = rest.join("/");
    joined.ends_with(".json")
        && APP_DATA_DIRS
            .iter()
            .any(|dir| joined.starts_with(&format!("{dir}/")))
}

/// The local folders a round works on.
#[derive(Debug, Clone)]
pub struct Roots {
    /// Vault root, when a vault is configured.
    pub vault: Option<PathBuf>,
    /// App data dir.
    pub data_dir: PathBuf,
    /// Whether app data is part of the sync.
    pub include_app_data: bool,
}

impl Roots {
    /// Does this device sync `path`?
    pub fn in_scope(&self, path: &str) -> bool {
        match split_virtual(path) {
            Ok((NS_VAULT, rest)) => self.vault.is_some() && !is_excluded_vault_path(&rest),
            Ok((NS_APP, rest)) => self.include_app_data && is_allowed_app_path(&rest),
            Ok((NS_APP_CONFLICTS, rest)) => {
                self.include_app_data && !rest.iter().any(|c| c.contains(TMP_MARKER))
            }
            _ => false,
        }
    }

    /// Root directory of a namespace.
    fn root_of(&self, ns: &str) -> Result<PathBuf, AetherError> {
        match ns {
            NS_VAULT => self
                .vault
                .clone()
                .ok_or_else(|| AetherError::Vault("no vault path configured".into())),
            NS_APP => Ok(self.data_dir.clone()),
            _ => Ok(self.data_dir.join(APP_CONFLICTS_DIR)),
        }
    }

    /// Map a logical path to an absolute path inside its root.
    pub fn resolve(&self, path: &str) -> Result<PathBuf, AetherError> {
        let (ns, rest) = split_virtual(path)?;
        if ns == NS_APP && !is_allowed_app_path(&rest) {
            return Err(AetherError::Sync(format!(
                "not a synced app-data file: {path}"
            )));
        }
        let mut abs = self.root_of(ns)?;
        for c in rest {
            abs.push(c);
        }
        Ok(abs)
    }

    /// Create the parent directory of `abs` and make sure it (after
    /// resolving symlinks) is still inside the namespace root. The deepest
    /// existing ancestor is checked *before* anything is created, so a
    /// symlinked folder cannot be used to create directories elsewhere.
    pub fn prepare_parent(&self, path: &str, abs: &Path) -> Result<(), AetherError> {
        let (ns, _) = split_virtual(path)?;
        let root = self.root_of(ns)?;
        std::fs::create_dir_all(&root)?;
        let parent = abs
            .parent()
            .ok_or_else(|| AetherError::Sync("path has no parent".into()))?;
        let canonical_root = std::fs::canonicalize(&root)?;
        fs_guard::create_dir_all_within(&canonical_root, parent).map_err(|_| {
            AetherError::Sync(format!("refusing to write outside the sync roots: {path}"))
        })?;
        Ok(())
    }

    /// Check that the existing local file of `path` really lives inside its
    /// namespace root: its folder (symlinks resolved) is inside the root
    /// and the file itself is not a symbolic link.
    pub fn check_local_inside(&self, path: &str, abs: &Path) -> Result<(), AetherError> {
        let (ns, _) = split_virtual(path)?;
        let outside = || {
            AetherError::Sync(format!(
                "refusing to touch a file outside the sync roots: {path}"
            ))
        };
        let root = std::fs::canonicalize(self.root_of(ns)?).map_err(|_| outside())?;
        let parent = abs.parent().ok_or_else(outside)?;
        let canonical_parent = std::fs::canonicalize(parent).map_err(|_| outside())?;
        if !canonical_parent.starts_with(&root) {
            return Err(outside());
        }
        if std::fs::symlink_metadata(abs).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(outside());
        }
        Ok(())
    }
}

// ── Scanning ───────────────────────────────────────────────────────────

/// Local files found by [`scan_local`].
#[derive(Debug, Default)]
pub struct ScanResult {
    /// Logical path → metadata.
    pub files: BTreeMap<String, LocalMeta>,
    /// Files that could not be read or are too large.
    pub issues: Vec<SyncIssue>,
}

/// Walk the vault (and app data when enabled), reusing cached hashes for
/// files whose size and mtime did not change.
pub fn scan_local(roots: &Roots, cache: &BTreeMap<String, LocalMeta>) -> ScanResult {
    let mut result = ScanResult::default();
    if let Some(vault) = &roots.vault {
        scan_tree(
            vault,
            NS_VAULT,
            &|comps| !is_excluded_vault_path(comps),
            cache,
            &mut result,
        );
    }
    if roots.include_app_data {
        for dir in APP_DATA_DIRS {
            scan_tree(
                &roots.data_dir.join(dir),
                &format!("{NS_APP}/{dir}"),
                &|comps| {
                    comps.last().is_some_and(|n| n.ends_with(".json"))
                        && !comps.iter().any(|c| c.contains(TMP_MARKER))
                },
                cache,
                &mut result,
            );
        }
        scan_tree(
            &roots.data_dir.join(APP_CONFLICTS_DIR),
            NS_APP_CONFLICTS,
            &|comps| !comps.iter().any(|c| c.contains(TMP_MARKER)),
            cache,
            &mut result,
        );
    }
    result
}

fn scan_tree(
    root: &Path,
    prefix: &str,
    accept: &dyn Fn(&[&str]) -> bool,
    cache: &BTreeMap<String, LocalMeta>,
    out: &mut ScanResult,
) {
    if !root.is_dir() {
        return;
    }
    let now = now_ms();
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let Ok(rel) = entry.path().strip_prefix(root) else {
                return false;
            };
            let comps: Vec<String> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect();
            let refs: Vec<&str> = comps.iter().map(String::as_str).collect();
            // Directories are pruned by the vault exclusion rules; files are
            // judged by `accept` below.
            !(entry.file_type().is_dir() && prefix == NS_VAULT && is_excluded_vault_path(&refs))
        });
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                out.issues
                    .push(SyncIssue::new(prefix, format!("cannot read folder: {e}")));
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let mut comps: Vec<&str> = Vec::new();
        let mut utf8 = true;
        for c in rel.components() {
            match c.as_os_str().to_str() {
                Some(s) => comps.push(s),
                None => utf8 = false,
            }
        }
        if !utf8 {
            out.issues.push(SyncIssue::new(
                rel.to_string_lossy().to_string(),
                "file name is not valid UTF-8; skipped",
            ));
            continue;
        }
        if !accept(&comps) {
            continue;
        }
        let path = format!("{prefix}/{}", comps.join("/"));
        if split_virtual(&path).is_err() {
            out.issues
                .push(SyncIssue::new(&path, "file name cannot be synced; skipped"));
            continue;
        }
        let (size, mtime) = match entry.metadata() {
            Ok(m) => (m.len(), m.modified().map(system_time_ms).unwrap_or(0)),
            Err(e) => {
                out.issues
                    .push(SyncIssue::new(&path, format!("stat failed: {e}")));
                continue;
            }
        };
        if size > MAX_FILE_BYTES {
            out.issues.push(SyncIssue::new(
                &path,
                format!("larger than {} MiB; skipped", MAX_FILE_BYTES / 1024 / 1024),
            ));
            continue;
        }
        // Recently modified files are always re-hashed: a same-size edit
        // within the mtime granularity must not hide behind the cache.
        if let Some(cached) = cache.get(&path) {
            if cached.size == size && cached.mtime == mtime && now - mtime > CACHE_TRUST_MS {
                out.files.insert(path, cached.clone());
                continue;
            }
        }
        match read_limited(entry.path(), MAX_FILE_BYTES) {
            Ok(bytes) => {
                out.files.insert(
                    path,
                    LocalMeta {
                        content_hash: crypto::content_hash(&bytes),
                        size: bytes.len() as u64,
                        mtime,
                    },
                );
            }
            Err(e) => out
                .issues
                .push(SyncIssue::new(&path, format!("read failed: {e}"))),
        }
    }
}

// ── Sync store ─────────────────────────────────────────────────────────

/// The encrypted store inside a user's sync folder.
#[derive(Debug, Clone)]
pub struct SyncStore {
    root: PathBuf,
}

impl SyncStore {
    /// Store for `sync_dir` (`<sync_dir>/aether-sync/v1`).
    pub fn new(sync_dir: &Path) -> Self {
        Self {
            root: sync_dir.join(STORE_DIR).join(STORE_VERSION_DIR),
        }
    }

    /// Create the sub-folders.
    pub fn ensure_layout(&self) -> Result<(), AetherError> {
        for sub in ["devices", "index", "blobs", "conflicts"] {
            std::fs::create_dir_all(self.root.join(sub))?;
        }
        Ok(())
    }

    /// `keyinfo.json`.
    pub fn keyinfo_path(&self) -> PathBuf {
        self.root.join("keyinfo.json")
    }

    /// `keyinfo.pending.json` (written while a passphrase change runs).
    pub fn pending_keyinfo_path(&self) -> PathBuf {
        self.root.join("keyinfo.pending.json")
    }

    /// Read the store's key file.
    pub fn read_keyinfo(&self) -> Result<Option<KeyInfo>, AetherError> {
        KeyInfo::read(&self.keyinfo_path())
    }

    /// Encrypted blob file.
    pub fn blob_path(&self, blob_id: &str) -> PathBuf {
        self.root.join("blobs").join(format!("{blob_id}.bin"))
    }

    /// Encrypted index of a device.
    pub fn index_path(&self, device_id: &str) -> PathBuf {
        self.root.join("index").join(format!("{device_id}.idx"))
    }

    /// Encrypted record of a device.
    pub fn device_path(&self, device_id: &str) -> PathBuf {
        self.root.join("devices").join(format!("{device_id}.json"))
    }

    /// Encrypted conflict record.
    pub fn conflict_path(&self, id: &str) -> PathBuf {
        self.root.join("conflicts").join(format!("{id}.json"))
    }

    /// `(id, path)` of every well-formed object in a sub-folder.
    pub fn list(&self, sub: &str, ext: &str) -> Result<Vec<(String, PathBuf)>, AetherError> {
        let dir = self.root.join(sub);
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if let Some(id) = name.strip_suffix(ext) {
                if is_valid_id(id) || (sub == "blobs" && is_hex64(id)) {
                    out.push((id.to_owned(), path.clone()));
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Read an encrypted metadata object.
    pub fn read_meta(&self, path: &Path) -> Result<Vec<u8>, AetherError> {
        read_limited(path, MAX_META_BYTES)
    }
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// A decrypted index kept in memory until its file changes.
#[derive(Debug, Clone)]
pub struct CachedIndex {
    modified: SystemTime,
    len: u64,
    salt: String,
    index: DeviceIndex,
}

/// Decrypt and validate one device index file.
pub fn decrypt_index(
    keys: &KeySet,
    device_id: &str,
    bytes: &[u8],
) -> Result<(DeviceIndex, Vec<SyncIssue>), AetherError> {
    let (header, plaintext) = keys.open(EnvelopeKind::Index, bytes)?;
    if header.device_id != device_id {
        return Err(AetherError::Sync(
            "index was written by a different device than its name says".into(),
        ));
    }
    let mut index: DeviceIndex = serde_json::from_slice(&plaintext)
        .map_err(|e| AetherError::Sync(format!("index payload is corrupt: {e}")))?;
    if index.device_id != device_id {
        return Err(AetherError::Sync(
            "index payload belongs to a different device".into(),
        ));
    }
    let mut issues = Vec::new();
    index.entries.retain(|path, entry| {
        let ok = split_virtual(path).is_ok()
            && (entry.deleted || is_hex64(&entry.content_hash))
            && entry.size <= MAX_FILE_BYTES
            && entry.version <= MAX_VERSION;
        if !ok {
            issues.push(SyncIssue::new(
                path.clone(),
                format!("ignored a malformed entry from device {device_id}"),
            ));
        }
        ok
    });
    Ok((index, issues))
}

/// Every other device's index as loaded by [`load_remote_indexes`].
#[derive(Debug, Default)]
pub struct RemoteIndexes {
    /// Successfully decrypted indexes.
    pub indexes: Vec<DeviceIndex>,
    /// Problems (unreadable indexes are skipped, never fatal).
    pub issues: Vec<SyncIssue>,
    /// False when at least one index file could not be read.
    pub complete: bool,
}

/// Load every *other* device's index, reusing decrypted copies whose file
/// did not change.
pub fn load_remote_indexes(
    store: &SyncStore,
    keys: &KeySet,
    me: &str,
    cache: &mut HashMap<String, CachedIndex>,
) -> Result<RemoteIndexes, AetherError> {
    let mut indexes = Vec::new();
    let mut issues = Vec::new();
    let mut complete = true;
    let listed = store.list("index", ".idx")?;
    let present: HashSet<String> = listed.iter().map(|(id, _)| id.clone()).collect();
    cache.retain(|id, _| present.contains(id));
    for (device_id, path) in listed {
        if device_id == me {
            continue;
        }
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                issues.push(SyncIssue::new(format!("index/{device_id}"), e.to_string()));
                complete = false;
                continue;
            }
        };
        let modified = meta.modified().unwrap_or(UNIX_EPOCH);
        if let Some(hit) = cache.get(&device_id) {
            if hit.modified == modified && hit.len == meta.len() && hit.salt == keys.salt_hex() {
                indexes.push(hit.index.clone());
                continue;
            }
        }
        let loaded = store
            .read_meta(&path)
            .and_then(|bytes| decrypt_index(keys, &device_id, &bytes));
        match loaded {
            Ok((index, mut entry_issues)) => {
                issues.append(&mut entry_issues);
                cache.insert(
                    device_id.clone(),
                    CachedIndex {
                        modified,
                        len: meta.len(),
                        salt: keys.salt_hex(),
                        index: index.clone(),
                    },
                );
                indexes.push(index);
            }
            Err(e) => {
                complete = false;
                issues.push(SyncIssue::new(
                    format!("index/{device_id}"),
                    format!("unreadable device index skipped: {e}"),
                ));
            }
        }
    }
    Ok(RemoteIndexes {
        indexes,
        issues,
        complete,
    })
}

/// Best (newest) entry per path over all given indexes.
pub fn merge_remote(indexes: &[DeviceIndex]) -> BTreeMap<String, IndexEntry> {
    let mut best: BTreeMap<String, IndexEntry> = BTreeMap::new();
    for index in indexes {
        for (path, entry) in &index.entries {
            match best.get(path) {
                Some(current) if !entry.is_newer_than(current) => {}
                _ => {
                    best.insert(path.clone(), entry.clone());
                }
            }
        }
    }
    best
}

// ── Planning (pure) ────────────────────────────────────────────────────

/// What a round will do for one path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Publish the local file as a new version.
    Upload {
        /// Logical path.
        path: String,
        /// Local file as scanned.
        local: LocalMeta,
        /// New version number.
        version: u64,
    },
    /// Publish a local deletion as a tombstone.
    PublishDelete {
        /// Logical path.
        path: String,
        /// New version number.
        version: u64,
    },
    /// Write the remote version locally.
    Download {
        /// Logical path.
        path: String,
        /// Remote version.
        entry: IndexEntry,
        /// Local file expected on disk (unchanged since the base).
        local: Option<LocalMeta>,
    },
    /// Move the local file to the trash (deleted on another device).
    DeleteLocal {
        /// Logical path.
        path: String,
        /// Remote tombstone.
        entry: IndexEntry,
        /// Local file expected on disk.
        local: LocalMeta,
    },
    /// Both sides already agree; record the remote version as the base.
    Adopt {
        /// Logical path.
        path: String,
        /// Remote version.
        entry: IndexEntry,
    },
    /// Both sides changed differently since the base.
    Conflict {
        /// Logical path.
        path: String,
        /// Local version.
        local: LocalMeta,
        /// Remote version.
        remote: IndexEntry,
        /// Whether the local version keeps the path.
        local_wins: bool,
        /// Version number for the local version if it wins.
        version: u64,
    },
}

impl Action {
    /// Logical path the action is about.
    pub fn path(&self) -> &str {
        match self {
            Action::Upload { path, .. }
            | Action::PublishDelete { path, .. }
            | Action::Download { path, .. }
            | Action::DeleteLocal { path, .. }
            | Action::Adopt { path, .. }
            | Action::Conflict { path, .. } => path,
        }
    }

    /// Counts as a pending upload in the status.
    pub fn is_upload(&self) -> bool {
        matches!(
            self,
            Action::Upload { .. } | Action::PublishDelete { .. } | Action::Conflict { .. }
        )
    }

    /// Counts as a pending download in the status.
    pub fn is_download(&self) -> bool {
        matches!(self, Action::Download { .. } | Action::DeleteLocal { .. })
    }
}

/// Decide what to do per path. `me` is this device's id; paths for which
/// `in_scope` is false are ignored.
pub fn plan(
    me: &str,
    local: &BTreeMap<String, LocalMeta>,
    base: &BTreeMap<String, IndexEntry>,
    remote: &BTreeMap<String, IndexEntry>,
    in_scope: &dyn Fn(&str) -> bool,
) -> Vec<Action> {
    let mut paths: Vec<&String> = local
        .keys()
        .chain(base.keys())
        .chain(remote.keys())
        .collect();
    paths.sort();
    paths.dedup();

    let mut actions = Vec::new();
    for path in paths {
        if !in_scope(path) {
            continue;
        }
        let l = local.get(path);
        let b = base.get(path);
        let r = remote.get(path);
        let max_version = b.map_or(0, |e| e.version).max(r.map_or(0, |e| e.version));
        let next_version = max_version.saturating_add(1);

        let local_changed = match (l, b) {
            (Some(l), Some(b)) => b.deleted || b.content_hash != l.content_hash,
            (Some(_), None) => true,
            (None, Some(b)) => !b.deleted,
            (None, None) => false,
        };
        let remote_changed = match (r, b) {
            (Some(r), Some(b)) => r.is_newer_than(b),
            (Some(_), None) => true,
            (None, _) => false,
        };

        let path = path.clone();
        match (local_changed, remote_changed) {
            (false, false) => {}
            (true, false) => match l {
                Some(l) => actions.push(Action::Upload {
                    path,
                    local: l.clone(),
                    version: next_version,
                }),
                None => actions.push(Action::PublishDelete {
                    path,
                    version: next_version,
                }),
            },
            (false, true) => {
                let r = r.expect("remote_changed implies an entry").clone();
                if r.matches_local(l) {
                    actions.push(Action::Adopt { path, entry: r });
                } else if r.deleted {
                    match l {
                        Some(l) => actions.push(Action::DeleteLocal {
                            path,
                            entry: r,
                            local: l.clone(),
                        }),
                        None => actions.push(Action::Adopt { path, entry: r }),
                    }
                } else {
                    actions.push(Action::Download {
                        path,
                        entry: r,
                        local: l.cloned(),
                    });
                }
            }
            (true, true) => {
                let r = r.expect("remote_changed implies an entry").clone();
                if r.matches_local(l) {
                    actions.push(Action::Adopt { path, entry: r });
                    continue;
                }
                match (l, r.deleted) {
                    // Deleted here, edited there: the edit wins.
                    (None, false) => actions.push(Action::Download {
                        path,
                        entry: r,
                        local: None,
                    }),
                    // Edited here, deleted there: the edit wins.
                    (Some(l), true) => actions.push(Action::Upload {
                        path,
                        local: l.clone(),
                        version: next_version,
                    }),
                    (Some(l), false) => {
                        let local_wins = (l.mtime, me) > (r.mtime, r.device.as_str());
                        actions.push(Action::Conflict {
                            path,
                            local: l.clone(),
                            remote: r,
                            local_wins,
                            version: next_version,
                        });
                    }
                    (None, true) => actions.push(Action::Adopt { path, entry: r }),
                }
            }
        }
    }
    actions
}

/// Drop tombstones older than [`TOMBSTONE_TTL_MS`] from a base.
pub fn prune_tombstones(base: &mut BTreeMap<String, IndexEntry>, now: i64) -> usize {
    let before = base.len();
    base.retain(|_, e| {
        !(e.deleted && now.saturating_sub(e.deleted_at.unwrap_or(e.mtime)) > TOMBSTONE_TTL_MS)
    });
    before - base.len()
}

// ── Execution ──────────────────────────────────────────────────────────

/// Everything one round needs.
pub struct RoundContext<'a> {
    /// Unlocked keys.
    pub keys: &'a KeySet,
    /// Sync store.
    pub store: &'a SyncStore,
    /// Local roots.
    pub roots: &'a Roots,
    /// Vault writer (`.md` files go through `write_note`).
    pub vault: &'a VaultReader,
    /// This device.
    pub device_id: &'a str,
    /// This device's name.
    pub device_name: &'a str,
}

impl RoundContext<'_> {
    /// Encrypt the local file at `path` into the store (if its blob is not
    /// there yet) and return the new index entry.
    pub fn upload(
        &self,
        path: &str,
        version: u64,
    ) -> Result<(IndexEntry, LocalMeta, u64), AetherError> {
        let abs = self.roots.resolve(path)?;
        let bytes = read_limited(&abs, MAX_FILE_BYTES)?;
        let (_, mtime) = file_meta(&abs)?;
        let hash = crypto::content_hash(&bytes);
        let blob_id = self.keys.blob_id(&hash);
        let blob_path = self.store.blob_path(&blob_id);
        let mut written = 0;
        if !blob_path.is_file() {
            let sealed = self.keys.seal(
                EnvelopeKind::Blob,
                HeaderFields {
                    device_id: self.device_id.to_owned(),
                    path_hash: Some(self.keys.path_hash(path)),
                    mtime: Some(mtime),
                    content_hash: Some(blob_id),
                },
                &bytes,
            )?;
            written = sealed.len() as u64;
            write_atomic(&blob_path, &sealed, None)?;
        }
        let meta = LocalMeta {
            content_hash: hash.clone(),
            size: bytes.len() as u64,
            mtime,
        };
        let entry = IndexEntry {
            content_hash: hash,
            size: bytes.len() as u64,
            mtime,
            deleted: false,
            deleted_at: None,
            version,
            device: self.device_id.to_owned(),
            device_name: self.device_name.to_owned(),
        };
        Ok((entry, meta, written))
    }

    /// Read, decrypt and verify the blob of `entry`.
    pub fn fetch(&self, entry: &IndexEntry) -> Result<Vec<u8>, AetherError> {
        let blob_id = self.keys.blob_id(&entry.content_hash);
        let path = self.store.blob_path(&blob_id);
        if !path.is_file() {
            return Err(AetherError::Sync(
                "content has not arrived in the sync folder yet".into(),
            ));
        }
        let bytes = read_limited(&path, entry.size + ENVELOPE_SLACK)?;
        let (header, plaintext) = self.keys.open(EnvelopeKind::Blob, &bytes)?;
        if header.content_hash.as_deref() != Some(blob_id.as_str()) {
            return Err(AetherError::Sync(
                "blob was swapped: its header names different content".into(),
            ));
        }
        if crypto::content_hash(&plaintext) != entry.content_hash
            || plaintext.len() as u64 != entry.size
        {
            return Err(AetherError::Sync(
                "blob content does not match the index".into(),
            ));
        }
        Ok(plaintext)
    }

    /// Write `bytes` to the local file of `path` (Markdown through the vault
    /// writer so history and watchers see it) and stamp its mtime.
    pub fn write_local(
        &self,
        path: &str,
        bytes: &[u8],
        mtime: i64,
    ) -> Result<LocalMeta, AetherError> {
        let abs = self.roots.resolve(path)?;
        self.roots.prepare_parent(path, &abs)?;
        let is_markdown = path.starts_with("vault/") && path.to_ascii_lowercase().ends_with(".md");
        match (is_markdown, std::str::from_utf8(bytes)) {
            (true, Ok(text)) => {
                self.vault.write_note(&abs.to_string_lossy(), text)?;
                set_mtime(&abs, mtime)?;
            }
            _ => write_atomic(&abs, bytes, Some(mtime))?,
        }
        let (size, actual_mtime) = file_meta(&abs)?;
        Ok(LocalMeta {
            content_hash: crypto::content_hash(bytes),
            size,
            mtime: actual_mtime,
        })
    }

    /// Move a local file to the trash (`<vault>/.trash/…` or
    /// `<data_dir>/sync/trash/…`); nothing is destroyed.
    pub fn trash_local(&self, path: &str) -> Result<(), AetherError> {
        let abs = self.roots.resolve(path)?;
        if !abs.exists() {
            return Ok(());
        }
        self.roots.check_local_inside(path, &abs)?;
        let (ns, rest) = split_virtual(path)?;
        let (trash_root, dest) = if ns == NS_VAULT {
            let root = self.roots.root_of(NS_VAULT)?;
            let mut dest = root.join(".trash");
            for c in rest {
                dest.push(c);
            }
            (root, dest)
        } else {
            let mut dest = self.roots.data_dir.join(APP_TRASH_DIR).join(ns);
            for c in rest {
                dest.push(c);
            }
            (self.roots.data_dir.clone(), dest)
        };
        // The trash folder (e.g. a symlinked `.trash`) must not lead out of
        // the root either.
        if let Some(parent) = dest.parent() {
            let canonical_root = std::fs::canonicalize(&trash_root)?;
            fs_guard::create_dir_all_within(&canonical_root, parent).map_err(|_| {
                AetherError::Sync(format!(
                    "refusing to move {path} to a trash folder outside the sync roots"
                ))
            })?;
        }
        move_unique(&abs, &dest)?;
        Ok(())
    }

    /// Does the local file still match what the plan saw?
    pub fn local_matches(&self, path: &str, expected: Option<&LocalMeta>) -> bool {
        let Ok(abs) = self.roots.resolve(path) else {
            return false;
        };
        match expected {
            None => !abs.exists(),
            Some(expected) => match file_meta(&abs) {
                Ok((size, mtime)) if size == expected.size && mtime == expected.mtime => true,
                Ok(_) => read_limited(&abs, MAX_FILE_BYTES)
                    .map(|b| crypto::content_hash(&b) == expected.content_hash)
                    .unwrap_or(false),
                Err(_) => false,
            },
        }
    }

    /// Current content of a local file.
    pub fn read_local(&self, path: &str) -> Result<Vec<u8>, AetherError> {
        read_limited(&self.roots.resolve(path)?, MAX_FILE_BYTES)
    }

    /// Stable conflict id for a copy path.
    pub fn conflict_id(&self, copy_path: &str) -> String {
        self.keys.path_hash(copy_path)[..32].to_owned()
    }

    /// Write an encrypted conflict record.
    pub fn write_conflict(&self, record: &ConflictRecord) -> Result<(), AetherError> {
        let json = serde_json::to_vec(record)
            .map_err(|e| AetherError::Sync(format!("conflict serialize: {e}")))?;
        let sealed = self.keys.seal(
            EnvelopeKind::Conflict,
            HeaderFields {
                device_id: self.device_id.to_owned(),
                path_hash: Some(self.keys.path_hash(&record.path)),
                ..HeaderFields::default()
            },
            &json,
        )?;
        write_atomic(&self.store.conflict_path(&record.id), &sealed, None)
    }
}

/// Decrypted conflict records with the file each came from.
pub type ConflictEntries = Vec<(ConflictRecord, PathBuf)>;

/// Read and decrypt every conflict record in the store.
pub fn read_conflicts(
    store: &SyncStore,
    keys: &KeySet,
) -> Result<(ConflictEntries, Vec<SyncIssue>), AetherError> {
    let mut records = Vec::new();
    let mut issues = Vec::new();
    for (id, path) in store.list("conflicts", ".json")? {
        let parsed = store
            .read_meta(&path)
            .and_then(|bytes| keys.open(EnvelopeKind::Conflict, &bytes))
            .and_then(|(_, plain)| {
                serde_json::from_slice::<ConflictRecord>(&plain)
                    .map_err(|e| AetherError::Sync(format!("conflict record is corrupt: {e}")))
            });
        match parsed {
            Ok(record)
                if split_virtual(&record.path).is_ok()
                    && split_virtual(&record.copy_path).is_ok() =>
            {
                records.push((record, path))
            }
            Ok(_) => issues.push(SyncIssue::new(
                format!("conflicts/{id}"),
                "malformed conflict record",
            )),
            Err(e) => issues.push(SyncIssue::new(format!("conflicts/{id}"), e.to_string())),
        }
    }
    records.sort_by_key(|r| std::cmp::Reverse(r.0.detected_at));
    Ok((records, issues))
}

/// Mutable bookkeeping of a round.
struct Exec<'a, 'b> {
    ctx: &'a RoundContext<'b>,
    state: &'a mut LocalState,
    remote: &'a BTreeMap<String, IndexEntry>,
    report: &'a mut SyncReport,
}

impl Exec<'_, '_> {
    fn next_version(&self, path: &str) -> u64 {
        self.state
            .base
            .get(path)
            .map_or(0, |e| e.version)
            .max(self.remote.get(path).map_or(0, |e| e.version))
            .saturating_add(1)
    }

    fn issue(&mut self, path: &str, message: impl Into<String>) {
        self.report.issues.push(SyncIssue::new(path, message));
    }

    fn do_upload(&mut self, path: &str, version: u64) -> Result<(), AetherError> {
        let (entry, meta, written) = self.ctx.upload(path, version)?;
        self.report.bytes_up += written;
        self.state.base.insert(path.to_owned(), entry);
        self.state.scan_cache.insert(path.to_owned(), meta);
        Ok(())
    }

    /// Pick a conflict-copy path that is free, or already holds `bytes`.
    fn free_copy_path(&self, wanted: &str, bytes: &[u8]) -> Result<String, AetherError> {
        let hash = crypto::content_hash(bytes);
        for n in 1..1000u32 {
            let candidate = conflict::numbered_path(wanted, n);
            let abs = self.ctx.roots.resolve(&candidate)?;
            if !abs.exists() {
                return Ok(candidate);
            }
            if read_limited(&abs, MAX_FILE_BYTES)
                .map(|b| crypto::content_hash(&b) == hash)
                .unwrap_or(false)
            {
                return Ok(candidate);
            }
        }
        Err(AetherError::Sync(format!(
            "no free conflict name for {wanted}"
        )))
    }

    fn run(&mut self, action: Action) -> Result<(), AetherError> {
        match action {
            Action::Adopt { path, entry } => {
                self.state.base.insert(path, entry);
                self.report.adopted += 1;
            }
            Action::Upload { path, version, .. } => {
                self.do_upload(&path, version)?;
                self.report.uploaded += 1;
            }
            Action::PublishDelete { path, version } => {
                let now = now_ms();
                self.state.base.insert(
                    path.clone(),
                    IndexEntry {
                        content_hash: String::new(),
                        size: 0,
                        mtime: now,
                        deleted: true,
                        deleted_at: Some(now),
                        version,
                        device: self.ctx.device_id.to_owned(),
                        device_name: self.ctx.device_name.to_owned(),
                    },
                );
                self.state.scan_cache.remove(&path);
                self.report.deleted_remote += 1;
            }
            Action::Download { path, entry, local } => {
                if !self.ctx.local_matches(&path, local.as_ref()) {
                    return Err(AetherError::Sync(
                        "changed locally during sync; will retry".into(),
                    ));
                }
                let bytes = self.ctx.fetch(&entry)?;
                let meta = self.ctx.write_local(&path, &bytes, entry.mtime)?;
                self.report.bytes_down += bytes.len() as u64;
                self.state.scan_cache.insert(path.clone(), meta);
                self.state.base.insert(path, entry);
                self.report.downloaded += 1;
            }
            Action::DeleteLocal { path, entry, local } => {
                if !self.ctx.local_matches(&path, Some(&local)) {
                    return Err(AetherError::Sync(
                        "changed locally during sync; will retry".into(),
                    ));
                }
                self.ctx.trash_local(&path)?;
                self.state.scan_cache.remove(&path);
                self.state.base.insert(path, entry);
                self.report.deleted_local += 1;
            }
            Action::Conflict {
                path,
                local,
                remote,
                local_wins,
                version,
            } => self.run_conflict(path, local, remote, local_wins, version)?,
        }
        Ok(())
    }

    fn run_conflict(
        &mut self,
        path: String,
        local: LocalMeta,
        remote: IndexEntry,
        local_wins: bool,
        version: u64,
    ) -> Result<(), AetherError> {
        let remote_bytes = self.ctx.fetch(&remote)?;
        if !self.ctx.local_matches(&path, Some(&local)) {
            return Err(AetherError::Sync(
                "changed locally during sync; will retry".into(),
            ));
        }
        let me = ConflictSide {
            device_id: self.ctx.device_id.to_owned(),
            device_name: self.ctx.device_name.to_owned(),
            mtime: local.mtime,
        };
        let them = ConflictSide {
            device_id: remote.device.clone(),
            device_name: if remote.device_name.is_empty() {
                "another device".to_owned()
            } else {
                remote.device_name.clone()
            },
            mtime: remote.mtime,
        };
        let (current, other, copy_bytes) = if local_wins {
            (me, them, remote_bytes.clone())
        } else {
            (them, me, self.ctx.read_local(&path)?)
        };
        let wanted = conflict::conflict_copy_path(&path, &other.device_name, other.mtime);
        let copy_path = self.free_copy_path(&wanted, &copy_bytes)?;
        let copy_meta = self.ctx.write_local(&copy_path, &copy_bytes, other.mtime)?;
        self.state.scan_cache.insert(copy_path.clone(), copy_meta);

        if local_wins {
            self.do_upload(&path, version)?;
        } else {
            let meta = self.ctx.write_local(&path, &remote_bytes, remote.mtime)?;
            self.report.bytes_down += remote_bytes.len() as u64;
            self.state.scan_cache.insert(path.clone(), meta);
            self.state.base.insert(path.clone(), remote);
        }
        let copy_version = self.next_version(&copy_path);
        if let Err(e) = self.do_upload(&copy_path, copy_version) {
            self.issue(&copy_path, format!("conflict copy upload failed: {e}"));
        }

        let record = ConflictRecord {
            id: self.ctx.conflict_id(&copy_path),
            path: path.clone(),
            copy_path,
            detected_at: now_ms(),
            detected_by: self.ctx.device_id.to_owned(),
            detected_by_name: self.ctx.device_name.to_owned(),
            current,
            other,
            resolved: false,
            resolution: None,
            resolved_at: None,
            resolved_by_name: None,
        };
        if let Err(e) = self.ctx.write_conflict(&record) {
            self.issue(&path, format!("conflict record could not be saved: {e}"));
        }
        self.report.conflicts += 1;
        Ok(())
    }
}

/// Publish this device's index when its entries changed; returns whether a
/// new index was written.
fn publish_index(
    ctx: &RoundContext<'_>,
    state: &mut LocalState,
    entries: BTreeMap<String, IndexEntry>,
) -> Result<bool, AetherError> {
    let entries_json = serde_json::to_vec(&entries)
        .map_err(|e| AetherError::Sync(format!("index serialize: {e}")))?;
    let digest = format!(
        "{}:{}",
        ctx.keys.salt_hex(),
        crypto::content_hash(&entries_json)
    );
    let path = ctx.store.index_path(ctx.device_id);
    if state.published_digest.as_deref() == Some(digest.as_str()) && path.is_file() {
        return Ok(false);
    }
    let index = DeviceIndex {
        v: 1,
        device_id: ctx.device_id.to_owned(),
        device_name: ctx.device_name.to_owned(),
        generated_at: now_ms(),
        entries,
    };
    let json = serde_json::to_vec(&index)
        .map_err(|e| AetherError::Sync(format!("index serialize: {e}")))?;
    let sealed = ctx.keys.seal(
        EnvelopeKind::Index,
        HeaderFields {
            device_id: ctx.device_id.to_owned(),
            ..HeaderFields::default()
        },
        &json,
    )?;
    write_atomic(&path, &sealed, None)?;
    state.published_digest = Some(digest);
    Ok(true)
}

/// Write this device's encrypted record.
pub fn publish_device(
    ctx: &RoundContext<'_>,
    file_count: u64,
    last_seen: i64,
) -> Result<(), AetherError> {
    let record = DeviceRecord {
        v: 1,
        device_id: ctx.device_id.to_owned(),
        device_name: ctx.device_name.to_owned(),
        platform: std::env::consts::OS.to_owned(),
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        last_seen,
        file_count,
    };
    let json = serde_json::to_vec(&record)
        .map_err(|e| AetherError::Sync(format!("device serialize: {e}")))?;
    let sealed = ctx.keys.seal(
        EnvelopeKind::Device,
        HeaderFields {
            device_id: ctx.device_id.to_owned(),
            ..HeaderFields::default()
        },
        &json,
    )?;
    write_atomic(&ctx.store.device_path(ctx.device_id), &sealed, None)
}

/// Read every device record.
pub fn read_devices(
    store: &SyncStore,
    keys: &KeySet,
) -> Result<(Vec<DeviceRecord>, Vec<SyncIssue>), AetherError> {
    let mut out = Vec::new();
    let mut issues = Vec::new();
    for (id, path) in store.list("devices", ".json")? {
        let parsed = store
            .read_meta(&path)
            .and_then(|bytes| keys.open(EnvelopeKind::Device, &bytes))
            .and_then(|(header, plain)| {
                let record: DeviceRecord = serde_json::from_slice(&plain)
                    .map_err(|e| AetherError::Sync(format!("device record is corrupt: {e}")))?;
                if header.device_id != id || record.device_id != id {
                    return Err(AetherError::Sync(
                        "device record does not match its file name".into(),
                    ));
                }
                Ok(record)
            });
        match parsed {
            Ok(record) => out.push(record),
            Err(e) => issues.push(SyncIssue::new(format!("devices/{id}"), e.to_string())),
        }
    }
    Ok((out, issues))
}

/// Remove blobs no index references any more (after a grace period, and
/// only when every index could be read).
fn collect_garbage(
    ctx: &RoundContext<'_>,
    indexes: &[DeviceIndex],
    own: &BTreeMap<String, IndexEntry>,
    now: i64,
) -> Result<u32, AetherError> {
    let mut referenced: HashSet<String> = HashSet::new();
    for entry in indexes
        .iter()
        .flat_map(|i| i.entries.values())
        .chain(own.values())
    {
        if !entry.deleted {
            referenced.insert(ctx.keys.blob_id(&entry.content_hash));
        }
    }
    let mut removed = 0;
    for (id, path) in ctx.store.list("blobs", ".bin")? {
        if referenced.contains(&id) {
            continue;
        }
        let age = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .map(|t| now - system_time_ms(t))
            .unwrap_or(0);
        if age > BLOB_GC_GRACE_MS && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Run one full sync round. Per-file problems end up in the report; only
/// store-level failures are returned as errors.
pub fn sync_round(
    ctx: &RoundContext<'_>,
    state: &mut LocalState,
    index_cache: &mut HashMap<String, CachedIndex>,
    progress: &dyn Fn(u32, u32),
) -> Result<SyncReport, AetherError> {
    let started = now_ms();
    let mut report = SyncReport {
        started_at: rfc3339(started),
        ..SyncReport::default()
    };
    ctx.store.ensure_layout()?;

    let scan = scan_local(ctx.roots, &state.scan_cache);
    report.issues.extend(scan.issues);
    // Forget cache entries for files that disappeared.
    state.scan_cache.retain(|p, _| scan.files.contains_key(p));
    for (path, meta) in &scan.files {
        state.scan_cache.insert(path.clone(), meta.clone());
    }

    let RemoteIndexes {
        indexes,
        issues: index_issues,
        complete: all_indexes_readable,
    } = load_remote_indexes(ctx.store, ctx.keys, ctx.device_id, index_cache)?;
    report.issues.extend(index_issues);
    report.devices = indexes.len() as u32 + 1;
    let remote = merge_remote(&indexes);

    let in_scope = |p: &str| ctx.roots.in_scope(p);
    let actions = plan(ctx.device_id, &scan.files, &state.base, &remote, &in_scope);
    let total = actions.len() as u32;
    progress(0, total);

    let mut failed_up = 0;
    let mut failed_down = 0;
    {
        let mut exec = Exec {
            ctx,
            state,
            remote: &remote,
            report: &mut report,
        };
        for (done, action) in actions.into_iter().enumerate() {
            let path = action.path().to_owned();
            let (is_up, is_down) = (action.is_upload(), action.is_download());
            if let Err(e) = exec.run(action) {
                exec.issue(&path, e.to_string());
                if is_up {
                    failed_up += 1;
                }
                if is_down {
                    failed_down += 1;
                }
            }
            progress(done as u32 + 1, total);
        }
    }
    report.pending_uploads = failed_up;
    report.pending_downloads = failed_down;

    let now = now_ms();
    prune_tombstones(&mut state.base, now);
    let published: BTreeMap<String, IndexEntry> = state
        .base
        .iter()
        .filter(|(p, _)| ctx.roots.in_scope(p))
        .map(|(p, e)| (p.clone(), e.clone()))
        .collect();
    let file_count = published.values().filter(|e| !e.deleted).count() as u64;
    report.files = file_count as u32;
    let index_changed = publish_index(ctx, state, published.clone())?;
    let device_stale = state
        .device_published_at
        .map_or(true, |at| now - at > DEVICE_REFRESH_MS);
    if index_changed || device_stale || !ctx.store.device_path(ctx.device_id).is_file() {
        publish_device(ctx, file_count, now)?;
        state.device_published_at = Some(now);
    }

    if all_indexes_readable
        && state
            .last_gc_at
            .map_or(true, |at| now - at > GC_INTERVAL_MS)
    {
        collect_garbage(ctx, &indexes, &published, now)?;
        state.last_gc_at = Some(now);
    }

    state.last_sync_at = Some(now);
    let finished = now_ms();
    report.finished_at = rfc3339(finished);
    report.duration_ms = (finished - started).max(0) as u64;
    Ok(report)
}

/// RFC 3339 (UTC) rendering of epoch milliseconds.
pub fn rfc3339(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(hash: &str, mtime: i64) -> LocalMeta {
        LocalMeta {
            content_hash: hash.repeat(64 / hash.len()),
            size: 1,
            mtime,
        }
    }

    fn entry(hash: &str, version: u64, device: &str, mtime: i64) -> IndexEntry {
        IndexEntry {
            content_hash: hash.repeat(64 / hash.len()),
            size: 1,
            mtime,
            deleted: false,
            deleted_at: None,
            version,
            device: device.into(),
            device_name: device.to_uppercase(),
        }
    }

    fn tombstone(version: u64, device: &str, at: i64) -> IndexEntry {
        IndexEntry {
            content_hash: String::new(),
            size: 0,
            mtime: at,
            deleted: true,
            deleted_at: Some(at),
            version,
            device: device.into(),
            device_name: String::new(),
        }
    }

    fn map<T: Clone>(items: &[(&str, T)]) -> BTreeMap<String, T> {
        items
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn all(_: &str) -> bool {
        true
    }

    #[test]
    fn new_local_file_is_uploaded_as_version_one() {
        let local = map(&[("vault/a.md", meta("a", 10))]);
        let actions = plan("me", &local, &BTreeMap::new(), &BTreeMap::new(), &all);
        assert_eq!(
            actions,
            vec![Action::Upload {
                path: "vault/a.md".into(),
                local: meta("a", 10),
                version: 1
            }]
        );
    }

    #[test]
    fn remote_only_file_is_downloaded() {
        let remote = map(&[("vault/a.md", entry("a", 1, "other", 10))]);
        let actions = plan("me", &BTreeMap::new(), &BTreeMap::new(), &remote, &all);
        assert!(matches!(
            &actions[..],
            [Action::Download { local: None, .. }]
        ));
    }

    #[test]
    fn identical_content_on_both_sides_is_adopted_without_conflict() {
        let local = map(&[("vault/a.md", meta("a", 10))]);
        let remote = map(&[("vault/a.md", entry("a", 1, "other", 99))]);
        let actions = plan("me", &local, &BTreeMap::new(), &remote, &all);
        assert!(matches!(&actions[..], [Action::Adopt { .. }]));
    }

    #[test]
    fn remote_edit_after_common_base_is_downloaded() {
        let base = map(&[("vault/a.md", entry("a", 1, "me", 10))]);
        let local = map(&[("vault/a.md", meta("a", 10))]);
        let remote = map(&[("vault/a.md", entry("b", 2, "other", 20))]);
        let actions = plan("me", &local, &base, &remote, &all);
        assert!(matches!(
            &actions[..],
            [Action::Download { local: Some(_), .. }]
        ));
    }

    #[test]
    fn stale_remote_entry_does_not_override_newer_base() {
        let base = map(&[("vault/a.md", entry("c", 3, "me", 30))]);
        let local = map(&[("vault/a.md", meta("c", 30))]);
        let remote = map(&[("vault/a.md", entry("b", 2, "other", 20))]);
        assert!(plan("me", &local, &base, &remote, &all).is_empty());
    }

    #[test]
    fn local_edit_gets_version_above_everything_known() {
        let base = map(&[("vault/a.md", entry("a", 4, "me", 10))]);
        let local = map(&[("vault/a.md", meta("z", 50))]);
        let remote = map(&[("vault/a.md", entry("a", 4, "me", 10))]);
        let actions = plan("me", &local, &base, &remote, &all);
        assert!(matches!(&actions[..], [Action::Upload { version: 5, .. }]));
    }

    #[test]
    fn concurrent_edits_conflict_and_newer_mtime_wins() {
        let base = map(&[("vault/a.md", entry("a", 1, "me", 10))]);
        let local = map(&[("vault/a.md", meta("l", 40))]);
        let remote = map(&[("vault/a.md", entry("r", 2, "other", 30))]);
        let actions = plan("me", &local, &base, &remote, &all);
        match &actions[..] {
            [Action::Conflict {
                local_wins,
                version,
                ..
            }] => {
                assert!(*local_wins);
                assert_eq!(*version, 3);
            }
            other => panic!("expected a conflict, got {other:?}"),
        }
        // Same mtimes: the device id breaks the tie deterministically.
        let local = map(&[("vault/a.md", meta("l", 30))]);
        let actions = plan("me", &local, &base, &remote, &all);
        assert!(matches!(
            &actions[..],
            [Action::Conflict {
                local_wins: false,
                ..
            }]
        ));
        let actions = plan("zz", &local, &base, &remote, &all);
        assert!(matches!(
            &actions[..],
            [Action::Conflict {
                local_wins: true,
                ..
            }]
        ));
    }

    #[test]
    fn deletion_propagates_both_ways() {
        let base = map(&[("vault/a.md", entry("a", 1, "me", 10))]);
        // Deleted here → tombstone.
        let actions = plan(
            "me",
            &BTreeMap::new(),
            &base,
            &map(&[("vault/a.md", entry("a", 1, "me", 10))]),
            &all,
        );
        assert!(matches!(
            &actions[..],
            [Action::PublishDelete { version: 2, .. }]
        ));
        // Deleted there → move local file to trash.
        let local = map(&[("vault/a.md", meta("a", 10))]);
        let remote = map(&[("vault/a.md", tombstone(2, "other", 20))]);
        let actions = plan("me", &local, &base, &remote, &all);
        assert!(matches!(&actions[..], [Action::DeleteLocal { .. }]));
    }

    #[test]
    fn edit_wins_over_concurrent_delete() {
        let base = map(&[("vault/a.md", entry("a", 1, "me", 10))]);
        // Edited here, deleted there.
        let local = map(&[("vault/a.md", meta("b", 20))]);
        let remote = map(&[("vault/a.md", tombstone(2, "other", 30))]);
        let actions = plan("me", &local, &base, &remote, &all);
        assert!(matches!(&actions[..], [Action::Upload { version: 3, .. }]));
        // Deleted here, edited there.
        let remote = map(&[("vault/a.md", entry("c", 2, "other", 30))]);
        let actions = plan("me", &BTreeMap::new(), &base, &remote, &all);
        assert!(matches!(
            &actions[..],
            [Action::Download { local: None, .. }]
        ));
    }

    #[test]
    fn out_of_scope_paths_are_ignored() {
        let local = map(&[("app/memory/facts.json", meta("a", 10))]);
        let actions = plan("me", &local, &BTreeMap::new(), &BTreeMap::new(), &|p| {
            p.starts_with("vault/")
        });
        assert!(actions.is_empty());
    }

    #[test]
    fn merge_remote_picks_highest_version_then_mtime() {
        let a = DeviceIndex {
            v: 1,
            device_id: "a".into(),
            device_name: "A".into(),
            generated_at: 0,
            entries: map(&[("vault/x.md", entry("a", 2, "a", 10))]),
        };
        let b = DeviceIndex {
            v: 1,
            device_id: "b".into(),
            device_name: "B".into(),
            generated_at: 0,
            entries: map(&[("vault/x.md", entry("b", 2, "b", 20))]),
        };
        let c = DeviceIndex {
            v: 1,
            device_id: "c".into(),
            device_name: "C".into(),
            generated_at: 0,
            entries: map(&[("vault/x.md", entry("c", 1, "c", 99))]),
        };
        let merged = merge_remote(&[a, b, c]);
        assert_eq!(merged["vault/x.md"].device, "b");
    }

    #[test]
    fn tombstones_are_pruned_after_ttl() {
        let now = 100 * 24 * 3600 * 1000;
        let mut base = map(&[
            (
                "vault/old.md",
                tombstone(2, "a", now - TOMBSTONE_TTL_MS - 1),
            ),
            ("vault/new.md", tombstone(2, "a", now - 1000)),
            ("vault/live.md", entry("a", 1, "a", 0)),
        ]);
        assert_eq!(prune_tombstones(&mut base, now), 1);
        assert!(!base.contains_key("vault/old.md"));
        assert!(base.contains_key("vault/new.md"));
        assert!(base.contains_key("vault/live.md"));
    }

    #[test]
    fn virtual_paths_are_validated() {
        assert!(split_virtual("vault/a/b.md").is_ok());
        assert!(split_virtual("vault/../etc/passwd").is_err());
        assert!(split_virtual("vault//a").is_err());
        assert!(split_virtual("/vault/a").is_err());
        assert!(split_virtual("other/a").is_err());
        assert!(split_virtual("vault").is_err());
        assert!(split_virtual("vault/a\\b").is_err());
        assert!(split_virtual("vault/./a").is_err());
    }

    #[test]
    fn exclusion_rules_skip_tool_folders() {
        assert!(is_excluded_vault_path(&[".git", "config"]));
        assert!(is_excluded_vault_path(&[".trash", "a.md"]));
        assert!(is_excluded_vault_path(&[".obsidian", "workspace.json"]));
        assert!(is_excluded_vault_path(&[
            ".obsidian",
            "workspace-mobile.json"
        ]));
        assert!(is_excluded_vault_path(&["notes", ".DS_Store"]));
        assert!(!is_excluded_vault_path(&[".obsidian", "app.json"]));
        assert!(!is_excluded_vault_path(&["notes", "a.md"]));
    }

    #[test]
    fn exclusion_rules_are_case_insensitive() {
        assert!(is_excluded_vault_path(&[".GIT", "config"]));
        assert!(is_excluded_vault_path(&[
            "sub",
            ".Git",
            "hooks",
            "pre-commit"
        ]));
        assert!(is_excluded_vault_path(&[".Trash", "a.md"]));
        assert!(is_excluded_vault_path(&[".AETHER-cache", "x"]));
        assert!(is_excluded_vault_path(&[".Obsidian", "Workspace.json"]));
        assert!(!is_excluded_vault_path(&[".github", "workflows", "ci.yml"]));
        let roots = Roots {
            vault: Some(PathBuf::from("/v")),
            data_dir: PathBuf::from("/d"),
            include_app_data: false,
        };
        assert!(!roots.in_scope("vault/.GIT/config"));
        assert!(!roots.in_scope("vault/.TRASH/x.md"));
    }

    fn sealed_index(keys: &KeySet, device: &str, entries: BTreeMap<String, IndexEntry>) -> Vec<u8> {
        let index = DeviceIndex {
            v: 1,
            device_id: device.to_owned(),
            device_name: device.to_owned(),
            generated_at: 0,
            entries,
        };
        keys.seal(
            EnvelopeKind::Index,
            HeaderFields {
                device_id: device.to_owned(),
                ..HeaderFields::default()
            },
            &serde_json::to_vec(&index).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn remote_indexes_drop_hostile_entries() {
        let keys = KeySet::derive("pass", [7u8; crypto::SALT_LEN], KdfParams::TESTING).unwrap();
        let hash = "ab".repeat(32);
        let mut huge_version = entry(&hash, 1, "dev", 1);
        huge_version.version = MAX_VERSION + 1;
        let mut huge_size = entry(&hash, 1, "dev", 1);
        huge_size.size = MAX_FILE_BYTES + 1;
        let entries = map(&[
            ("vault/good.md", entry(&hash, 3, "dev", 1)),
            ("vault/huge-version.md", huge_version),
            ("vault/huge-size.md", huge_size),
            ("vault/bad-hash.md", entry(&"zz".repeat(32), 1, "dev", 1)),
            ("vault/../escape.md", entry(&hash, 1, "dev", 1)),
            ("/etc/passwd", entry(&hash, 1, "dev", 1)),
            ("vault/a\0b.md", entry(&hash, 1, "dev", 1)),
        ]);
        let (index, issues) =
            decrypt_index(&keys, "dev", &sealed_index(&keys, "dev", entries)).unwrap();
        assert_eq!(
            index.entries.keys().collect::<Vec<_>>(),
            vec!["vault/good.md"]
        );
        assert_eq!(issues.len(), 6);
    }

    #[test]
    fn version_counters_never_overflow() {
        let local = map(&[("vault/x.md", meta("new", 5))]);
        let mut worn = entry("old", 1, "b", 1);
        worn.version = u64::MAX;
        let base = map(&[("vault/x.md", worn)]);
        let actions = plan("a", &local, &base, &BTreeMap::new(), &all);
        assert!(matches!(
            actions.as_slice(),
            [Action::Upload {
                version: u64::MAX,
                ..
            }]
        ));
    }

    #[cfg(unix)]
    #[test]
    fn writes_and_trash_moves_never_leave_the_roots() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.join("link")).unwrap();
        let roots = Roots {
            vault: Some(vault.clone()),
            data_dir: dir.path().join("data"),
            include_app_data: false,
        };

        // A download below a symlinked folder is refused before any folder
        // is created outside the vault.
        let path = "vault/link/new/x.md";
        let abs = roots.resolve(path).unwrap();
        assert!(roots.prepare_parent(path, &abs).is_err());
        assert!(!outside.path().join("new").exists());

        // An inside path is fine.
        let good = "vault/notes/x.md";
        assert!(roots
            .prepare_parent(good, &roots.resolve(good).unwrap())
            .is_ok());

        // Files reached through a symlinked folder are never touched.
        std::fs::write(outside.path().join("keep.md"), "keep").unwrap();
        let reached = roots.resolve("vault/link/keep.md").unwrap();
        assert!(roots
            .check_local_inside("vault/link/keep.md", &reached)
            .is_err());
        // A symlinked file inside the vault is refused as well.
        std::os::unix::fs::symlink(outside.path().join("keep.md"), vault.join("alias.md")).unwrap();
        let alias = roots.resolve("vault/alias.md").unwrap();
        assert!(roots.check_local_inside("vault/alias.md", &alias).is_err());
        std::fs::write(vault.join("real.md"), "x").unwrap();
        let real = roots.resolve("vault/real.md").unwrap();
        assert!(roots.check_local_inside("vault/real.md", &real).is_ok());
    }

    #[test]
    fn roots_resolve_inside_their_namespace() {
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots {
            vault: Some(dir.path().join("vault")),
            data_dir: dir.path().join("data"),
            include_app_data: true,
        };
        assert_eq!(
            roots.resolve("vault/a/b.md").unwrap(),
            dir.path().join("vault").join("a").join("b.md")
        );
        assert_eq!(
            roots.resolve("app/memory/facts.json").unwrap(),
            dir.path().join("data").join("memory").join("facts.json")
        );
        assert!(roots.resolve("app/ai/ai_config.json").is_err());
        assert!(roots.resolve("app/memory/facts.txt").is_err());
        assert!(roots.in_scope("app/tasks/items/x.json"));
        assert!(!roots.in_scope("vault/.git/HEAD"));
        let no_app = Roots {
            include_app_data: false,
            ..roots
        };
        assert!(!no_app.in_scope("app/memory/facts.json"));
    }

    #[test]
    fn scan_uses_cache_and_skips_excluded_files() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        std::fs::create_dir_all(vault.join(".git")).unwrap();
        std::fs::create_dir_all(vault.join("notes")).unwrap();
        std::fs::write(vault.join("notes/a.md"), "alpha").unwrap();
        // Old enough for the hash cache to be trusted.
        set_mtime(&vault.join("notes/a.md"), 1_700_000_000_000).unwrap();
        std::fs::write(vault.join(".git/HEAD"), "ref").unwrap();
        std::fs::create_dir_all(dir.path().join("data/memory")).unwrap();
        std::fs::write(dir.path().join("data/memory/facts.json"), "[]").unwrap();
        std::fs::write(dir.path().join("data/memory/notes.txt"), "x").unwrap();
        let roots = Roots {
            vault: Some(vault.clone()),
            data_dir: dir.path().join("data"),
            include_app_data: true,
        };
        let scan = scan_local(&roots, &BTreeMap::new());
        let paths: Vec<&String> = scan.files.keys().collect();
        assert_eq!(paths, vec!["app/memory/facts.json", "vault/notes/a.md"]);
        assert_eq!(
            scan.files["vault/notes/a.md"].content_hash,
            crypto::content_hash(b"alpha")
        );
        // A cache hit (same size + mtime) reuses the stored hash.
        let mut cache = scan.files.clone();
        cache.get_mut("vault/notes/a.md").unwrap().content_hash = "cached".into();
        let again = scan_local(&roots, &cache);
        assert_eq!(again.files["vault/notes/a.md"].content_hash, "cached");
        // A freshly modified file is re-hashed even when size and mtime match.
        cache.get_mut("app/memory/facts.json").unwrap().content_hash = "stale".into();
        let fresh = scan_local(&roots, &cache);
        assert_eq!(
            fresh.files["app/memory/facts.json"].content_hash,
            crypto::content_hash(b"[]")
        );
    }

    #[test]
    fn local_state_rebinds_to_new_store() {
        let mut state = LocalState::default();
        state.bind_store("store-a");
        state
            .base
            .insert("vault/a.md".into(), entry("a", 1, "me", 1));
        state.bind_store("store-a");
        assert_eq!(state.base.len(), 1);
        state.bind_store("store-b");
        assert!(state.base.is_empty());
    }

    #[test]
    fn atomic_write_sets_mtime_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/file.txt");
        write_atomic(&path, b"hello", Some(1_700_000_000_000)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        let (_, mtime) = file_meta(&path).unwrap();
        assert_eq!(mtime, 1_700_000_000_000);
        let names: Vec<String> = std::fs::read_dir(dir.path().join("sub"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["file.txt"]);
    }
}
