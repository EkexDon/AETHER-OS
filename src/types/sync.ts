/**
 * Encrypted backup & folder sync types — mirror `src-tauri/src/engine/sync.rs`
 * and its `folder_sync` / `snapshot` modules (snake_case like the Rust serde
 * structs). Timestamps are RFC 3339 strings.
 */

/** Persistent sync & backup settings. */
export interface SyncSettings {
  /** Background folder sync on/off. */
  enabled: boolean;
  /** The shared folder (the encrypted store lives in `<sync_dir>/aether-sync/v1`). */
  sync_dir: string | null;
  /** Random id generated once per installation. */
  device_id: string;
  /** Human-readable device name (defaults to the host name). */
  device_name: string;
  /** Also sync memory facts, calendar events, tasks and AETHER notes. */
  include_app_data: boolean;
  /** Seconds between background rounds (15 … 86 400). */
  interval_seconds: number;
  /** The key is stored on this device (less secure, opt-in). */
  remember_key: boolean;
  /** Folder for scheduled backups. */
  backup_dir: string | null;
  /** Hours between scheduled backups (0 = off). */
  backup_every_hours: number;
  /** Scheduled backups to keep (1 … 365). */
  backup_keep: number;
  /** Include app data in scheduled backups. */
  backup_include_app_data: boolean;
}

/** Partial settings update. Empty strings clear `sync_dir` / `backup_dir`. */
export type SyncSettingsPatch = Partial<Omit<SyncSettings, "device_id" | "sync_dir" | "backup_dir">> & {
  sync_dir?: string;
  backup_dir?: string;
};

/** Coarse state for the status bar. */
export type SyncState = "idle" | "syncing" | "error" | "locked";

/** Progress of a long operation (`sync-progress` event). */
export interface SyncProgress {
  operation: "sync" | "backup" | "verify" | "restore" | "passphrase" | string;
  done: number;
  total: number;
}

/** Status snapshot (`sync-status` event and `cmd_sync_status`). */
export interface SyncStatus {
  state: SyncState;
  enabled: boolean;
  /** A sync folder is set. */
  configured: boolean;
  /** The key is in memory. */
  unlocked: boolean;
  /** A passphrase was set up on this device. */
  initialized: boolean;
  /** The key is remembered on this device. */
  remembered: boolean;
  last_sync_at: string | null;
  pending_uploads: number;
  pending_downloads: number;
  /** Unresolved conflicts. */
  conflicts: number;
  message: string | null;
  device_id: string;
  device_name: string;
  last_backup_at: string | null;
  next_backup_at: string | null;
  progress: SyncProgress | null;
}

/** A per-file problem that did not stop the operation. */
export interface SyncIssue {
  /** Logical path (`vault/…`, `app/…`) or store object. */
  path: string;
  message: string;
}

/** Result of one sync round. */
export interface SyncReport {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  uploaded: number;
  downloaded: number;
  deleted_local: number;
  deleted_remote: number;
  adopted: number;
  conflicts: number;
  pending_uploads: number;
  pending_downloads: number;
  bytes_up: number;
  bytes_down: number;
  devices: number;
  files: number;
  issues: SyncIssue[];
}

/** A device that syncs through the folder. */
export interface SyncDeviceInfo {
  device_id: string;
  device_name: string;
  platform: string;
  app_version: string;
  last_seen: string | null;
  file_count: number;
  is_current: boolean;
}

/** One side of a conflict. */
export interface SyncConflictSide {
  device_id: string;
  device_name: string;
  modified_at: string;
  is_this_device: boolean;
}

/** How a conflict is settled: keep the file (`local`), take the copy (`remote`), keep both. */
export type SyncKeepChoice = "local" | "remote" | "both";

/**
 * A conflict. `current` is the version at the file's own path
 * (`keep: "local"`), `other` is the conflict copy (`keep: "remote"`).
 */
export interface SyncConflict {
  id: string;
  path: string;
  display_path: string;
  copy_path: string;
  display_copy_path: string;
  kind: "vault" | "app";
  detected_at: string;
  detected_by_name: string;
  current: SyncConflictSide;
  other: SyncConflictSide;
  resolved: boolean;
  resolution: SyncKeepChoice | null;
  resolved_at: string | null;
  resolved_by_name: string | null;
  copy_exists: boolean;
}

/** Both versions of a conflict for the side-by-side diff. */
export interface SyncConflictDetail {
  conflict: SyncConflict;
  current_content: string | null;
  other_content: string | null;
  /** At least one side is binary or too large to diff. */
  binary: boolean;
}

/** What a folder contains (setup wizard). */
export interface SyncFolderInfo {
  path: string;
  /** An AETHER sync store already exists there. */
  initialized: boolean;
  device_count: number;
  created_at: string | null;
  created_by: string | null;
}

/** Result of a passphrase change. */
export interface PassphraseChangeReport {
  blobs: number;
  indexes: number;
  devices: number;
  conflicts: number;
  /** A sync folder was re-encrypted (false = only this device). */
  sync_folder: boolean;
  issues: SyncIssue[];
}

/** Result of creating a backup. */
export interface BackupReport {
  path: string;
  file_name: string;
  created_at: string;
  files: number;
  bytes: number;
  archive_bytes: number;
  skipped: SyncIssue[];
  pruned: string[];
}

/** A backup found in a folder (read from its plaintext manifest). */
export interface BackupInfo {
  path: string;
  file_name: string;
  /** Empty when the archive is unreadable. */
  created_at: string;
  device_name: string;
  files: number;
  bytes: number;
  archive_bytes: number;
  include_app_data: boolean;
  scheduled: boolean;
  error: string | null;
}

/** One file in a restore preview. */
export interface BackupPreviewFile {
  path: string;
  size: number;
  modified_at: string;
}

/** Dry-run view of a backup. */
export interface BackupPreview {
  path: string;
  created_at: string;
  device: string;
  device_id: string;
  include_app_data: boolean;
  file_count: number;
  bytes: number;
  files: BackupPreviewFile[];
}

/** Result of verifying every blob of a backup. */
export interface BackupVerifyReport {
  path: string;
  ok: boolean;
  files_checked: number;
  bytes: number;
  issues: SyncIssue[];
}

/** How a restore treats existing data. */
export type RestoreMode = "merge" | "replace";

/** Result of a restore. */
export interface RestoreReport {
  target_dir: string;
  mode: RestoreMode;
  restored: number;
  unchanged: number;
  restored_copies: number;
  app_files_restored: number;
  app_files_kept: number;
  moved_existing_to: string | null;
  app_data_moved_to: string | null;
  issues: SyncIssue[];
}
