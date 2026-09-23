//! Encrypted backups (`aether-backup-<timestamp>.aetherbak`).
//!
//! A backup is a plain ZIP archive (stored, no compression — encrypted data
//! does not compress) with three kinds of entries:
//!
//! ```text
//! manifest.json        plaintext: format, version, creation time, device,
//!                      counts, KDF params, salt and verifier
//! index.bin            encrypted file list (path, size, mtime, content hash);
//!                      its header binds the exact manifest bytes
//! blobs/<blob_id>.bin  encrypted file contents, deduplicated by content
//! ```
//!
//! The archive is self-contained: salt and KDF parameters travel with it, so
//! the passphrase alone restores it on a fresh machine. Because the index
//! header authenticates a hash of `manifest.json`, any edit of the manifest
//! is detected as soon as the index is opened.

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::crypto::{self, EnvelopeKind, HeaderFields, KdfParams, KeySet};
use super::folder_sync::{
    self, now_ms, read_limited, rfc3339, split_virtual, system_time_ms, write_atomic, LocalMeta,
    Roots, SyncIssue, APP_CONFLICTS_DIR, APP_DATA_DIRS, MAX_FILE_BYTES, NS_APP, NS_APP_CONFLICTS,
    NS_VAULT,
};
use crate::engine::error::AetherError;
use crate::engine::vault_reader::VaultReader;

/// File extension of backups.
pub const BACKUP_EXT: &str = "aetherbak";
/// File name prefix of backups.
pub const BACKUP_PREFIX: &str = "aether-backup-";
/// `format` value in the manifest.
pub const BACKUP_FORMAT: &str = "aether-backup";
/// Default number of scheduled backups to keep.
pub const DEFAULT_KEEP: u32 = 7;

const MANIFEST_NAME: &str = "manifest.json";
const INDEX_NAME: &str = "index.bin";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
const ENVELOPE_SLACK: u64 = 64 * 1024;

/// Plaintext manifest of a backup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupManifest {
    /// Always [`BACKUP_FORMAT`].
    pub format: String,
    /// Format version (1).
    pub v: u32,
    /// Creation time (ms).
    pub created_at: i64,
    /// Device that created it.
    pub device_id: String,
    /// Name of that device.
    pub device_name: String,
    /// App version that wrote it.
    pub app_version: String,
    /// Whether app data (memory, calendar, tasks, AETHER notes) is included.
    pub include_app_data: bool,
    /// Created by the scheduler (only those are pruned automatically).
    pub scheduled: bool,
    /// Number of files.
    pub file_count: u64,
    /// Total plaintext bytes.
    pub total_bytes: u64,
    /// Argon2id parameters of the backup key.
    pub kdf: KdfParams,
    /// Hex salt of the backup key.
    pub salt: String,
    /// Hex verifier of the backup key.
    pub verifier: String,
}

/// One file inside a backup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupFileEntry {
    /// Logical path (`vault/…`, `app/…`).
    pub path: String,
    /// Size in bytes.
    pub size: u64,
    /// Modification time (ms).
    pub mtime: i64,
    /// Plain BLAKE3 hex.
    pub content_hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupIndexPayload {
    v: u32,
    files: Vec<BackupFileEntry>,
}

/// Result of creating a backup.
#[derive(Debug, Clone, Serialize)]
pub struct BackupReport {
    /// Absolute path of the new archive.
    pub path: String,
    /// Its file name.
    pub file_name: String,
    /// RFC 3339 creation time.
    pub created_at: String,
    /// Files included.
    pub files: u64,
    /// Plaintext bytes included.
    pub bytes: u64,
    /// Size of the archive on disk.
    pub archive_bytes: u64,
    /// Files that could not be read.
    pub skipped: Vec<SyncIssue>,
    /// Old scheduled backups removed afterwards.
    pub pruned: Vec<String>,
}

/// A backup found in a folder (from its manifest; no passphrase needed).
#[derive(Debug, Clone, Serialize)]
pub struct BackupInfo {
    /// Absolute path.
    pub path: String,
    /// File name.
    pub file_name: String,
    /// RFC 3339 creation time (empty when unreadable).
    pub created_at: String,
    /// Device name.
    pub device_name: String,
    /// Number of files.
    pub files: u64,
    /// Plaintext bytes.
    pub bytes: u64,
    /// Archive size on disk.
    pub archive_bytes: u64,
    /// App data included.
    pub include_app_data: bool,
    /// Created by the scheduler.
    pub scheduled: bool,
    /// Why the archive could not be read, if so.
    pub error: Option<String>,
}

/// One file in a restore preview.
#[derive(Debug, Clone, Serialize)]
pub struct BackupPreviewFile {
    /// Logical path.
    pub path: String,
    /// Size in bytes.
    pub size: u64,
    /// RFC 3339 modification time.
    pub modified_at: String,
}

/// Dry-run view of a backup (requires the passphrase).
#[derive(Debug, Clone, Serialize)]
pub struct BackupPreview {
    /// Archive path.
    pub path: String,
    /// RFC 3339 creation time.
    pub created_at: String,
    /// Device name.
    pub device: String,
    /// Device id.
    pub device_id: String,
    /// App data included.
    pub include_app_data: bool,
    /// Number of files.
    pub file_count: u64,
    /// Plaintext bytes.
    pub bytes: u64,
    /// The files.
    pub files: Vec<BackupPreviewFile>,
}

/// Result of verifying every blob of a backup.
#[derive(Debug, Clone, Serialize)]
pub struct BackupVerifyReport {
    /// Archive path.
    pub path: String,
    /// No problems found.
    pub ok: bool,
    /// Files whose content was decrypted and checked.
    pub files_checked: u64,
    /// Plaintext bytes checked.
    pub bytes: u64,
    /// Problems.
    pub issues: Vec<SyncIssue>,
}

/// How a restore treats existing data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RestoreMode {
    /// Add missing files; differing files are kept and the backup version is
    /// written next to them as "(restored …)".
    Merge,
    /// Move the existing folder aside (`<name>.pre-restore-<ts>`) and restore
    /// the backup into a fresh folder.
    Replace,
}

impl RestoreMode {
    /// Parse the IPC string (`merge` | `replace`).
    pub fn parse(value: &str) -> Result<Self, AetherError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "merge" => Ok(Self::Merge),
            "replace" => Ok(Self::Replace),
            other => Err(AetherError::InvalidInput(format!(
                "unknown restore mode \"{other}\" (expected merge or replace)"
            ))),
        }
    }
}

/// Result of a restore.
#[derive(Debug, Clone, Serialize)]
pub struct RestoreReport {
    /// Folder the vault files went to.
    pub target_dir: String,
    /// `merge` or `replace`.
    pub mode: RestoreMode,
    /// Files written.
    pub restored: u64,
    /// Files already identical.
    pub unchanged: u64,
    /// Files written as "(restored …)" copies next to differing files.
    pub restored_copies: u64,
    /// App-data files written.
    pub app_files_restored: u64,
    /// App-data files kept because they differ (merge mode).
    pub app_files_kept: u64,
    /// Where the previous folder was moved (replace mode).
    pub moved_existing_to: Option<String>,
    /// Where previous app data was moved (replace mode).
    pub app_data_moved_to: Option<String>,
    /// Problems.
    pub issues: Vec<SyncIssue>,
}

fn zip_err(e: zip::result::ZipError) -> AetherError {
    AetherError::InvalidInput(format!("backup archive error: {e}"))
}

fn serialize_err(e: serde_json::Error) -> AetherError {
    AetherError::InvalidInput(format!("serialize: {e}"))
}

fn file_mtime(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(system_time_ms)
        .unwrap_or(0)
}

/// A free archive path for `stamp` in `dir`.
fn backup_path_for(dir: &Path, stamp: &str) -> PathBuf {
    for n in 1..1000u32 {
        let name = if n == 1 {
            format!("{BACKUP_PREFIX}{stamp}.{BACKUP_EXT}")
        } else {
            format!("{BACKUP_PREFIX}{stamp}-{n}.{BACKUP_EXT}")
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!(
        "{BACKUP_PREFIX}{stamp}-{}.{BACKUP_EXT}",
        uuid::Uuid::new_v4()
    ))
}

/// Who writes a backup.
pub struct BackupAuthor<'a> {
    /// Device id.
    pub device_id: &'a str,
    /// Device name.
    pub device_name: &'a str,
}

/// Create an encrypted backup of `files` in `dest_dir`.
#[allow(clippy::too_many_arguments)]
pub fn create_backup(
    dest_dir: &Path,
    keys: &KeySet,
    roots: &Roots,
    files: &BTreeMap<String, LocalMeta>,
    author: &BackupAuthor<'_>,
    scheduled: bool,
    progress: &dyn Fn(u32, u32),
) -> Result<BackupReport, AetherError> {
    std::fs::create_dir_all(dest_dir)?;
    let created_at = now_ms();
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    let final_path = backup_path_for(dest_dir, &stamp);
    let file_name = final_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let tmp_path = dest_dir.join(format!(".{file_name}.partial"));

    let build = || -> Result<(u64, u64, Vec<SyncIssue>), AetherError> {
        let mut zip = ZipWriter::new(File::create(&tmp_path)?);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let mut written: HashSet<String> = HashSet::new();
        let mut entries = Vec::new();
        let mut skipped = Vec::new();
        let mut total_bytes = 0u64;
        let total = files.len() as u32;
        for (i, path) in files.keys().enumerate() {
            let read = roots.resolve(path).and_then(|abs| {
                let bytes = read_limited(&abs, MAX_FILE_BYTES)?;
                Ok((bytes, file_mtime(&abs)))
            });
            let (bytes, mtime) = match read {
                Ok(v) => v,
                Err(e) => {
                    skipped.push(SyncIssue {
                        path: path.clone(),
                        message: e.to_string(),
                    });
                    continue;
                }
            };
            let hash = crypto::content_hash(&bytes);
            let blob_id = keys.blob_id(&hash);
            if written.insert(blob_id.clone()) {
                let sealed = keys.seal(
                    EnvelopeKind::BackupBlob,
                    HeaderFields {
                        device_id: author.device_id.to_owned(),
                        path_hash: Some(keys.path_hash(path)),
                        mtime: Some(mtime),
                        content_hash: Some(blob_id.clone()),
                    },
                    &bytes,
                )?;
                zip.start_file(format!("blobs/{blob_id}.bin"), options)
                    .map_err(zip_err)?;
                zip.write_all(&sealed)?;
            }
            total_bytes += bytes.len() as u64;
            entries.push(BackupFileEntry {
                path: path.clone(),
                size: bytes.len() as u64,
                mtime,
                content_hash: hash,
            });
            progress(i as u32 + 1, total);
        }
        let manifest = BackupManifest {
            format: BACKUP_FORMAT.to_owned(),
            v: 1,
            created_at,
            device_id: author.device_id.to_owned(),
            device_name: author.device_name.to_owned(),
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            include_app_data: roots.include_app_data,
            scheduled,
            file_count: entries.len() as u64,
            total_bytes,
            kdf: keys.kdf(),
            salt: keys.salt_hex(),
            verifier: keys.verifier_hex(),
        };
        let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(serialize_err)?;
        zip.start_file(MANIFEST_NAME, options).map_err(zip_err)?;
        zip.write_all(&manifest_json)?;
        let index_json = serde_json::to_vec(&BackupIndexPayload {
            v: 1,
            files: entries,
        })
        .map_err(serialize_err)?;
        let sealed_index = keys.seal(
            EnvelopeKind::BackupIndex,
            HeaderFields {
                device_id: author.device_id.to_owned(),
                content_hash: Some(crypto::content_hash(&manifest_json)),
                ..HeaderFields::default()
            },
            &index_json,
        )?;
        zip.start_file(INDEX_NAME, options).map_err(zip_err)?;
        zip.write_all(&sealed_index)?;
        let file = zip.finish().map_err(zip_err)?;
        file.sync_all()?;
        Ok((manifest.file_count, total_bytes, skipped))
    };

    match build() {
        Ok((count, bytes, skipped)) => {
            std::fs::rename(&tmp_path, &final_path)?;
            let archive_bytes = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
            Ok(BackupReport {
                path: final_path.to_string_lossy().to_string(),
                file_name,
                created_at: rfc3339(created_at),
                files: count,
                bytes,
                archive_bytes,
                skipped,
                pruned: Vec::new(),
            })
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}

fn read_entry(zip: &mut ZipArchive<File>, name: &str, max: u64) -> Result<Vec<u8>, AetherError> {
    let entry = zip.by_name(name).map_err(|_| {
        AetherError::InvalidInput(format!("backup is incomplete: {name} is missing"))
    })?;
    if entry.size() > max {
        return Err(AetherError::InvalidInput(format!(
            "backup entry {name} is too large"
        )));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(AetherError::InvalidInput(format!(
            "backup entry {name} is too large"
        )));
    }
    Ok(bytes)
}

fn open_archive(path: &Path) -> Result<ZipArchive<File>, AetherError> {
    let file = File::open(path)?;
    ZipArchive::new(file)
        .map_err(|e| AetherError::InvalidInput(format!("not a readable AETHER backup: {e}")))
}

fn parse_manifest(bytes: &[u8]) -> Result<BackupManifest, AetherError> {
    let manifest: BackupManifest = serde_json::from_slice(bytes)
        .map_err(|e| AetherError::InvalidInput(format!("backup manifest is corrupt: {e}")))?;
    if manifest.format != BACKUP_FORMAT || manifest.v != 1 {
        return Err(AetherError::InvalidInput(
            "unsupported backup format or version".into(),
        ));
    }
    Ok(manifest)
}

/// Read only the manifest of a backup (no passphrase).
pub fn read_manifest(path: &Path) -> Result<BackupManifest, AetherError> {
    let mut zip = open_archive(path)?;
    parse_manifest(&read_entry(&mut zip, MANIFEST_NAME, MAX_MANIFEST_BYTES)?)
}

/// A backup whose passphrase was verified and whose index was decrypted.
pub struct OpenedBackup {
    /// The manifest (authenticated through the index header).
    pub manifest: BackupManifest,
    /// Keys derived from the passphrase.
    pub keys: KeySet,
    /// File list.
    pub files: Vec<BackupFileEntry>,
    archive: ZipArchive<File>,
}

impl OpenedBackup {
    /// Decrypt and verify the content of `entry`.
    pub fn read_file(&mut self, entry: &BackupFileEntry) -> Result<Vec<u8>, AetherError> {
        let blob_id = self.keys.blob_id(&entry.content_hash);
        let bytes = read_entry(
            &mut self.archive,
            &format!("blobs/{blob_id}.bin"),
            entry.size + ENVELOPE_SLACK,
        )?;
        let (header, plaintext) = self.keys.open(EnvelopeKind::BackupBlob, &bytes)?;
        if header.content_hash.as_deref() != Some(blob_id.as_str()) {
            return Err(AetherError::InvalidInput(
                "backup blob was swapped: header names different content".into(),
            ));
        }
        if crypto::content_hash(&plaintext) != entry.content_hash {
            return Err(AetherError::InvalidInput(
                "backup content does not match its index".into(),
            ));
        }
        Ok(plaintext)
    }
}

/// Open a backup with its passphrase: verifies the passphrase, decrypts the
/// index and checks the manifest binding.
pub fn open_backup(path: &Path, passphrase: &str) -> Result<OpenedBackup, AetherError> {
    let mut archive = open_archive(path)?;
    let manifest_bytes = read_entry(&mut archive, MANIFEST_NAME, MAX_MANIFEST_BYTES)?;
    let manifest = parse_manifest(&manifest_bytes)?;
    let salt = crypto::parse_salt(&manifest.salt)?;
    let keys = KeySet::derive(passphrase, salt, manifest.kdf)?;
    if !keys.matches_verifier(&manifest.verifier) {
        return Err(AetherError::InvalidInput(
            "wrong passphrase for this backup".into(),
        ));
    }
    let index_bytes = read_entry(&mut archive, INDEX_NAME, MAX_INDEX_BYTES)?;
    let (header, plaintext) = keys.open(EnvelopeKind::BackupIndex, &index_bytes)?;
    if header.content_hash.as_deref() != Some(crypto::content_hash(&manifest_bytes).as_str()) {
        return Err(AetherError::InvalidInput(
            "the backup manifest was modified after the backup was made".into(),
        ));
    }
    let payload: BackupIndexPayload = serde_json::from_slice(&plaintext)
        .map_err(|e| AetherError::InvalidInput(format!("backup index is corrupt: {e}")))?;
    if payload
        .files
        .iter()
        .any(|f| split_virtual(&f.path).is_err() || f.content_hash.len() != 64)
    {
        return Err(AetherError::InvalidInput(
            "backup index contains an invalid path".into(),
        ));
    }
    Ok(OpenedBackup {
        manifest,
        keys,
        files: payload.files,
        archive,
    })
}

/// List backups in `dir`, newest first. Unreadable archives are listed with
/// an `error` so the UI can explain them.
pub fn list_backups(dir: &Path) -> Result<Vec<BackupInfo>, AetherError> {
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.')
            || !path.is_file()
            || path.extension().and_then(|e| e.to_str()) != Some(BACKUP_EXT)
        {
            continue;
        }
        let archive_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let path_str = path.to_string_lossy().to_string();
        match read_manifest(&path) {
            Ok(m) => out.push(BackupInfo {
                path: path_str,
                file_name: name,
                created_at: rfc3339(m.created_at),
                device_name: m.device_name,
                files: m.file_count,
                bytes: m.total_bytes,
                archive_bytes,
                include_app_data: m.include_app_data,
                scheduled: m.scheduled,
                error: None,
            }),
            Err(e) => out.push(BackupInfo {
                path: path_str,
                file_name: name,
                created_at: String::new(),
                device_name: String::new(),
                files: 0,
                bytes: 0,
                archive_bytes,
                include_app_data: false,
                scheduled: false,
                error: Some(e.to_string()),
            }),
        }
    }
    out.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.file_name.cmp(&a.file_name))
    });
    Ok(out)
}

/// Decrypt and check every file of a backup.
pub fn verify_backup(
    path: &Path,
    passphrase: &str,
    progress: &dyn Fn(u32, u32),
) -> Result<BackupVerifyReport, AetherError> {
    let mut opened = open_backup(path, passphrase)?;
    let files = opened.files.clone();
    let mut issues = Vec::new();
    let mut checked = 0u64;
    let mut bytes = 0u64;
    let total = files.len() as u32;
    for (i, file) in files.iter().enumerate() {
        match opened.read_file(file) {
            Ok(plain) => {
                checked += 1;
                bytes += plain.len() as u64;
            }
            Err(e) => issues.push(SyncIssue {
                path: file.path.clone(),
                message: e.to_string(),
            }),
        }
        progress(i as u32 + 1, total);
    }
    if opened.manifest.file_count != files.len() as u64 {
        issues.push(SyncIssue {
            path: MANIFEST_NAME.to_owned(),
            message: "file count does not match the index".into(),
        });
    }
    Ok(BackupVerifyReport {
        path: path.to_string_lossy().to_string(),
        ok: issues.is_empty(),
        files_checked: checked,
        bytes,
        issues,
    })
}

/// Dry-run preview of a backup.
pub fn preview_backup(path: &Path, passphrase: &str) -> Result<BackupPreview, AetherError> {
    let opened = open_backup(path, passphrase)?;
    let bytes = opened.files.iter().map(|f| f.size).sum();
    Ok(BackupPreview {
        path: path.to_string_lossy().to_string(),
        created_at: rfc3339(opened.manifest.created_at),
        device: opened.manifest.device_name.clone(),
        device_id: opened.manifest.device_id.clone(),
        include_app_data: opened.manifest.include_app_data,
        file_count: opened.files.len() as u64,
        bytes,
        files: opened
            .files
            .iter()
            .map(|f| BackupPreviewFile {
                path: f.path.clone(),
                size: f.size,
                modified_at: rfc3339(f.mtime),
            })
            .collect(),
    })
}

/// `<stem> (restored <ts>)<ext>` next to `path`.
fn restored_copy_path(path: &str, stamp: &str, n: u32) -> String {
    let (dir, name) = match path.rfind('/') {
        Some(idx) => (&path[..=idx], &path[idx + 1..]),
        None => ("", path),
    };
    let (stem, ext) = match name.rfind('.') {
        Some(idx) if idx > 0 => (&name[..idx], &name[idx..]),
        _ => (name, ""),
    };
    let counter = if n > 1 {
        format!(" {n}")
    } else {
        String::new()
    };
    format!("{dir}{stem} (restored {stamp}{counter}){ext}")
}

/// Move `path` to a sibling named `<name>.pre-restore-<stamp>` (unique).
fn move_aside(path: &Path, stamp: &str) -> Result<PathBuf, AetherError> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| AetherError::InvalidInput("cannot move a root folder aside".into()))?;
    let parent = path
        .parent()
        .ok_or_else(|| AetherError::InvalidInput("cannot move a root folder aside".into()))?;
    for n in 1..1000u32 {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate = parent.join(format!("{name}.pre-restore-{stamp}{suffix}"));
        if !candidate.exists() {
            std::fs::rename(path, &candidate)?;
            return Ok(candidate);
        }
    }
    Err(AetherError::InvalidInput(
        "no free name to move the existing folder aside".into(),
    ))
}

fn dir_has_entries(path: &Path) -> bool {
    std::fs::read_dir(path)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
}

/// Where restored data goes.
pub struct RestoreTarget<'a> {
    /// Folder for the vault files.
    pub target_dir: &'a Path,
    /// App data dir (for `app/…` entries).
    pub data_dir: &'a Path,
    /// Vault writer, when `target_dir` is the live vault (Markdown then goes
    /// through `write_note`).
    pub vault: Option<&'a VaultReader>,
}

fn write_restored(
    roots: &Roots,
    target: &RestoreTarget<'_>,
    path: &str,
    bytes: &[u8],
    mtime: i64,
) -> Result<(), AetherError> {
    let abs = roots.resolve(path)?;
    roots.prepare_parent(path, &abs)?;
    let markdown = path.starts_with("vault/") && path.to_ascii_lowercase().ends_with(".md");
    if let (true, Some(vault), Ok(text)) = (markdown, target.vault, std::str::from_utf8(bytes)) {
        vault.write_note(&abs.to_string_lossy(), text)?;
        let file = File::options().write(true).open(&abs)?;
        file.set_modified(
            std::time::UNIX_EPOCH + std::time::Duration::from_millis(mtime.max(0) as u64),
        )?;
        return Ok(());
    }
    write_atomic(&abs, bytes, Some(mtime))
}

/// Restore a backup. Never overwrites differing data without keeping it:
/// `replace` moves the existing folder aside first, `merge` writes
/// "(restored …)" copies next to differing files.
pub fn restore_backup(
    path: &Path,
    passphrase: &str,
    target: &RestoreTarget<'_>,
    mode: RestoreMode,
    progress: &dyn Fn(u32, u32),
) -> Result<RestoreReport, AetherError> {
    let mut opened = open_backup(path, passphrase)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut report = RestoreReport {
        target_dir: target.target_dir.to_string_lossy().to_string(),
        mode,
        restored: 0,
        unchanged: 0,
        restored_copies: 0,
        app_files_restored: 0,
        app_files_kept: 0,
        moved_existing_to: None,
        app_data_moved_to: None,
        issues: Vec::new(),
    };
    let has_app = opened
        .files
        .iter()
        .any(|f| f.path.starts_with("app/") || f.path.starts_with("app-conflicts/"));

    if mode == RestoreMode::Replace {
        if target.target_dir.exists() && dir_has_entries(target.target_dir) {
            let moved = move_aside(target.target_dir, &stamp)?;
            report.moved_existing_to = Some(moved.to_string_lossy().to_string());
        }
        if has_app {
            let aside = target
                .data_dir
                .join("sync")
                .join(format!("pre-restore-{stamp}"));
            let mut moved_any = false;
            for dir in APP_DATA_DIRS.iter().copied().chain([APP_CONFLICTS_DIR]) {
                let src = target.data_dir.join(dir);
                if src.is_dir() && dir_has_entries(&src) {
                    let dest = aside.join(dir);
                    if let Some(parent) = dest.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::rename(&src, &dest)?;
                    std::fs::create_dir_all(&src)?;
                    moved_any = true;
                }
            }
            if moved_any {
                report.app_data_moved_to = Some(aside.to_string_lossy().to_string());
            }
        }
    }
    std::fs::create_dir_all(target.target_dir)?;

    let roots = Roots {
        vault: Some(target.target_dir.to_path_buf()),
        data_dir: target.data_dir.to_path_buf(),
        include_app_data: true,
    };
    let files = opened.files.clone();
    let total = files.len() as u32;
    for (i, file) in files.iter().enumerate() {
        progress(i as u32 + 1, total);
        let (ns, _) = match split_virtual(&file.path) {
            Ok(v) => v,
            Err(e) => {
                report.issues.push(SyncIssue {
                    path: file.path.clone(),
                    message: e.to_string(),
                });
                continue;
            }
        };
        let bytes = match opened.read_file(file) {
            Ok(b) => b,
            Err(e) => {
                report.issues.push(SyncIssue {
                    path: file.path.clone(),
                    message: e.to_string(),
                });
                continue;
            }
        };
        let abs = match roots.resolve(&file.path) {
            Ok(p) => p,
            Err(e) => {
                report.issues.push(SyncIssue {
                    path: file.path.clone(),
                    message: e.to_string(),
                });
                continue;
            }
        };
        let is_app = ns == NS_APP || ns == NS_APP_CONFLICTS;
        let mut dest_path = file.path.clone();
        if abs.exists() {
            let same = read_limited(&abs, MAX_FILE_BYTES)
                .map(|b| crypto::content_hash(&b) == file.content_hash)
                .unwrap_or(false);
            if same {
                report.unchanged += 1;
                continue;
            }
            if is_app {
                report.app_files_kept += 1;
                continue;
            }
            debug_assert_eq!(ns, NS_VAULT);
            let mut n = 1;
            loop {
                let candidate = restored_copy_path(&file.path, &stamp, n);
                match roots.resolve(&candidate) {
                    Ok(p) if !p.exists() => {
                        dest_path = candidate;
                        break;
                    }
                    Ok(_) if n < 1000 => n += 1,
                    _ => {
                        dest_path = String::new();
                        break;
                    }
                }
            }
            if dest_path.is_empty() {
                report.issues.push(SyncIssue {
                    path: file.path.clone(),
                    message: "no free name for the restored copy".into(),
                });
                continue;
            }
            report.restored_copies += 1;
        }
        match write_restored(&roots, target, &dest_path, &bytes, file.mtime) {
            Ok(()) if is_app => report.app_files_restored += 1,
            Ok(()) => report.restored += 1,
            Err(e) => report.issues.push(SyncIssue {
                path: file.path.clone(),
                message: e.to_string(),
            }),
        }
    }
    Ok(report)
}

/// Delete the oldest *scheduled* backups in `dir` beyond `keep`. Manual
/// backups are never touched. Returns the removed file names.
pub fn prune_backups(dir: &Path, keep: u32) -> Result<Vec<String>, AetherError> {
    let mut scheduled: Vec<(i64, String, PathBuf)> = Vec::new();
    for info in list_backups(dir)? {
        if info.error.is_some() || !info.scheduled || !info.file_name.starts_with(BACKUP_PREFIX) {
            continue;
        }
        let created = read_manifest(Path::new(&info.path))
            .map(|m| m.created_at)
            .unwrap_or(0);
        scheduled.push((created, info.file_name, PathBuf::from(info.path)));
    }
    scheduled.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let mut removed = Vec::new();
    for (_, name, path) in scheduled.into_iter().skip(keep.max(1) as usize) {
        std::fs::remove_file(&path)?;
        removed.push(name);
    }
    Ok(removed)
}

/// Build the file list for a backup from a scan.
pub fn backup_files(
    roots: &Roots,
    cache: &BTreeMap<String, LocalMeta>,
) -> (BTreeMap<String, LocalMeta>, Vec<SyncIssue>) {
    let scan = folder_sync::scan_local(roots, cache);
    (scan.files, scan.issues)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::sync::crypto::SALT_LEN;

    struct Fixture {
        _dir: tempfile::TempDir,
        vault: PathBuf,
        data: PathBuf,
        out: PathBuf,
        keys: KeySet,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        let data = dir.path().join("data");
        let out = dir.path().join("backups");
        std::fs::create_dir_all(vault.join("Projects")).unwrap();
        std::fs::create_dir_all(data.join("memory")).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(vault.join("Projects/Plan.md"), "# Plan\n\nship it").unwrap();
        std::fs::write(vault.join("Inbox.md"), "inbox").unwrap();
        std::fs::write(vault.join("Copy.md"), "inbox").unwrap();
        std::fs::write(data.join("memory/facts.json"), "[]").unwrap();
        let keys =
            KeySet::derive("backup passphrase", [3u8; SALT_LEN], KdfParams::TESTING).unwrap();
        Fixture {
            vault,
            data,
            out,
            keys,
            _dir: dir,
        }
    }

    fn roots(f: &Fixture, app: bool) -> Roots {
        Roots {
            vault: Some(f.vault.clone()),
            data_dir: f.data.clone(),
            include_app_data: app,
        }
    }

    fn author() -> BackupAuthor<'static> {
        BackupAuthor {
            device_id: "device-a",
            device_name: "Mac A",
        }
    }

    fn make_backup(f: &Fixture, app: bool, scheduled: bool) -> BackupReport {
        let roots = roots(f, app);
        let (files, _) = backup_files(&roots, &BTreeMap::new());
        create_backup(
            &f.out,
            &f.keys,
            &roots,
            &files,
            &author(),
            scheduled,
            &|_, _| {},
        )
        .unwrap()
    }

    #[test]
    fn backup_round_trip_preview_verify_and_restore() {
        let f = fixture();
        let report = make_backup(&f, true, false);
        assert_eq!(report.files, 4);
        assert!(report.file_name.starts_with(BACKUP_PREFIX));
        assert!(report.file_name.ends_with(".aetherbak"));

        let listed = list_backups(&f.out).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].device_name, "Mac A");
        assert_eq!(listed[0].files, 4);
        assert!(listed[0].error.is_none());

        let path = PathBuf::from(&report.path);
        let preview = preview_backup(&path, "backup passphrase").unwrap();
        assert_eq!(preview.file_count, 4);
        assert_eq!(preview.device, "Mac A");
        assert!(preview
            .files
            .iter()
            .any(|x| x.path == "vault/Projects/Plan.md"));

        let verified = verify_backup(&path, "backup passphrase", &|_, _| {}).unwrap();
        assert!(verified.ok, "{:?}", verified.issues);
        assert_eq!(verified.files_checked, 4);

        let target = f.out.join("restored-vault");
        let restored = restore_backup(
            &path,
            "backup passphrase",
            &RestoreTarget {
                target_dir: &target,
                data_dir: &f.data,
                vault: None,
            },
            RestoreMode::Merge,
            &|_, _| {},
        )
        .unwrap();
        assert_eq!(restored.restored, 3);
        // facts.json is identical to the live one.
        assert_eq!(restored.unchanged, 1);
        assert_eq!(
            std::fs::read_to_string(target.join("Projects/Plan.md")).unwrap(),
            "# Plan\n\nship it"
        );
    }

    #[test]
    fn backup_contains_no_plaintext() {
        let f = fixture();
        let report = make_backup(&f, false, false);
        let raw = std::fs::read(&report.path).unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(!text.contains("ship it"));
        assert!(!text.contains("Plan.md"));
        assert!(!text.contains("Projects"));
    }

    #[test]
    fn wrong_passphrase_is_rejected() {
        let f = fixture();
        let report = make_backup(&f, false, false);
        let err = preview_backup(Path::new(&report.path), "not the passphrase")
            .err()
            .unwrap()
            .to_string();
        assert!(err.contains("wrong passphrase"));
    }

    #[test]
    fn tampered_manifest_is_detected() {
        let f = fixture();
        let report = make_backup(&f, false, false);
        // Rebuild the archive with an edited device name in the manifest.
        let mut src = ZipArchive::new(File::open(&report.path).unwrap()).unwrap();
        let forged = f.out.join("forged.aetherbak");
        let mut dst = ZipWriter::new(File::create(&forged).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for i in 0..src.len() {
            let mut entry = src.by_index(i).unwrap();
            let name = entry.name().to_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            if name == MANIFEST_NAME {
                bytes = String::from_utf8(bytes)
                    .unwrap()
                    .replace("Mac A", "Evil")
                    .into_bytes();
            }
            dst.start_file(name, options).unwrap();
            dst.write_all(&bytes).unwrap();
        }
        dst.finish().unwrap();
        let err = preview_backup(&forged, "backup passphrase")
            .err()
            .unwrap()
            .to_string();
        assert!(err.contains("manifest was modified"), "{err}");
    }

    #[test]
    fn corrupted_blob_is_reported_by_verify() {
        let f = fixture();
        let report = make_backup(&f, false, false);
        let mut src = ZipArchive::new(File::open(&report.path).unwrap()).unwrap();
        let broken = f.out.join("broken.aetherbak");
        let mut dst = ZipWriter::new(File::create(&broken).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let mut flipped = false;
        for i in 0..src.len() {
            let mut entry = src.by_index(i).unwrap();
            let name = entry.name().to_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            if name.starts_with("blobs/") && !flipped {
                let last = bytes.len() - 1;
                bytes[last] ^= 0xff;
                flipped = true;
            }
            dst.start_file(name, options).unwrap();
            dst.write_all(&bytes).unwrap();
        }
        dst.finish().unwrap();
        let verified = verify_backup(&broken, "backup passphrase", &|_, _| {}).unwrap();
        assert!(!verified.ok);
        // Deduplicated blobs may back several files; every file is accounted for.
        assert!(!verified.issues.is_empty());
        assert_eq!(verified.files_checked + verified.issues.len() as u64, 3);
    }

    #[test]
    fn replace_moves_the_existing_folder_aside() {
        let f = fixture();
        let report = make_backup(&f, false, false);
        std::fs::write(f.vault.join("Inbox.md"), "changed after backup").unwrap();
        std::fs::write(f.vault.join("New.md"), "new after backup").unwrap();
        let restored = restore_backup(
            Path::new(&report.path),
            "backup passphrase",
            &RestoreTarget {
                target_dir: &f.vault,
                data_dir: &f.data,
                vault: None,
            },
            RestoreMode::Replace,
            &|_, _| {},
        )
        .unwrap();
        let moved = PathBuf::from(restored.moved_existing_to.expect("moved aside"));
        assert!(moved
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("vault.pre-restore-"));
        assert_eq!(
            std::fs::read_to_string(moved.join("Inbox.md")).unwrap(),
            "changed after backup"
        );
        assert_eq!(
            std::fs::read_to_string(f.vault.join("Inbox.md")).unwrap(),
            "inbox"
        );
        assert!(!f.vault.join("New.md").exists());
        assert_eq!(restored.restored, 3);
    }

    #[test]
    fn merge_keeps_differing_files_and_writes_restored_copies() {
        let f = fixture();
        let report = make_backup(&f, true, false);
        std::fs::write(f.vault.join("Inbox.md"), "edited").unwrap();
        std::fs::write(f.data.join("memory/facts.json"), "[{\"x\":1}]").unwrap();
        let restored = restore_backup(
            Path::new(&report.path),
            "backup passphrase",
            &RestoreTarget {
                target_dir: &f.vault,
                data_dir: &f.data,
                vault: None,
            },
            RestoreMode::Merge,
            &|_, _| {},
        )
        .unwrap();
        assert_eq!(restored.restored_copies, 1);
        assert_eq!(restored.app_files_kept, 1);
        assert_eq!(
            std::fs::read_to_string(f.vault.join("Inbox.md")).unwrap(),
            "edited"
        );
        let copies: Vec<String> = std::fs::read_dir(&f.vault)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("Inbox (restored "))
            .collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(
            std::fs::read_to_string(f.vault.join(&copies[0])).unwrap(),
            "inbox"
        );
        assert_eq!(
            std::fs::read_to_string(f.data.join("memory/facts.json")).unwrap(),
            "[{\"x\":1}]"
        );
    }

    #[test]
    fn pruning_keeps_the_newest_scheduled_backups_only() {
        let f = fixture();
        let manual = make_backup(&f, false, false);
        let mut scheduled = Vec::new();
        for _ in 0..9 {
            scheduled.push(make_backup(&f, false, true));
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        let removed = prune_backups(&f.out, 7).unwrap();
        assert_eq!(removed.len(), 2);
        assert!(removed.contains(&scheduled[0].file_name));
        assert!(removed.contains(&scheduled[1].file_name));
        assert!(Path::new(&manual.path).exists());
        assert!(Path::new(&scheduled[8].path).exists());
        let left = list_backups(&f.out).unwrap();
        assert_eq!(left.len(), 8);
        // Idempotent.
        assert!(prune_backups(&f.out, 7).unwrap().is_empty());
    }

    #[test]
    fn unreadable_archives_are_listed_with_an_error() {
        let f = fixture();
        std::fs::write(f.out.join("aether-backup-junk.aetherbak"), b"not a zip").unwrap();
        std::fs::write(f.out.join(".aether-backup-x.aetherbak.partial"), b"x").unwrap();
        let listed = list_backups(&f.out).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].error.is_some());
    }

    #[test]
    fn restore_modes_parse() {
        assert_eq!(RestoreMode::parse("merge").unwrap(), RestoreMode::Merge);
        assert_eq!(RestoreMode::parse("Replace").unwrap(), RestoreMode::Replace);
        assert!(RestoreMode::parse("overwrite").is_err());
    }

    #[test]
    fn restored_copy_names() {
        assert_eq!(
            restored_copy_path("vault/a/Note.md", "20260922-140533", 1),
            "vault/a/Note (restored 20260922-140533).md"
        );
        assert_eq!(
            restored_copy_path("vault/README", "x", 2),
            "vault/README (restored x 2)"
        );
    }
}
