/** Encrypted backup & folder sync commands (`src-tauri/src/commands/sync_commands.rs`). */
import type {
  BackupInfo,
  BackupPreview,
  BackupReport,
  BackupVerifyReport,
  PassphraseChangeReport,
  RestoreMode,
  RestoreReport,
  SyncConflict,
  SyncConflictDetail,
  SyncDeviceInfo,
  SyncFolderInfo,
  SyncKeepChoice,
  SyncProgress,
  SyncReport,
  SyncSettings,
  SyncSettingsPatch,
  SyncStatus,
} from "../../types";
import { call, listenSafe, type UnlistenFn } from "./core";

/** Event carrying a {@link SyncStatus} whenever the sync state changes. */
export const SYNC_STATUS_EVENT = "sync-status";
/** Event carrying {@link SyncProgress} of a running sync, backup, restore or passphrase change. */
export const SYNC_PROGRESS_EVENT = "sync-progress";

/** Current sync & backup settings. */
export const getSyncSettings = () => call<SyncSettings>("cmd_sync_get_settings");
/** Validate and persist a partial settings update; changing the folder locks the key. */
export const setSyncSettings = (patch: SyncSettingsPatch) =>
  call<SyncSettings>("cmd_sync_set_settings", { patch });
/** Does a folder already contain an AETHER sync store (and how many devices)? */
export const inspectSyncFolder = (path: string) => call<SyncFolderInfo>("cmd_sync_inspect_folder", { path });
/** Derive the key and verify it; creates the key on first use. `remember` stores it on this device. */
export const unlockSync = (passphrase: string, remember: boolean) =>
  call<SyncStatus>("cmd_sync_unlock", { passphrase, remember });
/** Forget the key (zeroized in memory). */
export const lockSync = () => call<SyncStatus>("cmd_sync_lock");
/** Run a sync round now. */
export const syncNow = () => call<SyncReport>("cmd_sync_now");
/** Status snapshot. */
export const getSyncStatus = () => call<SyncStatus>("cmd_sync_status");
/** Conflict records, unresolved first. */
export const listSyncConflicts = () => call<SyncConflict[]>("cmd_sync_list_conflicts");
/** Both versions of a conflict for the diff view. */
export const getSyncConflict = (id: string) => call<SyncConflictDetail>("cmd_sync_get_conflict", { id });
/** Settle a conflict: keep the file (`local`), take the conflict copy (`remote`) or keep both. */
export const resolveSyncConflict = (id: string, keep: SyncKeepChoice) =>
  call<SyncConflict>("cmd_sync_resolve_conflict", { id, keep });
/** Change the passphrase and re-encrypt everything in the sync folder. */
export const changeSyncPassphrase = (oldPassphrase: string, newPassphrase: string) =>
  call<PassphraseChangeReport>("cmd_sync_change_passphrase", { oldPassphrase, newPassphrase });
/** Devices registered in the sync folder (this one first). */
export const listSyncDevices = () => call<SyncDeviceInfo[]>("cmd_sync_devices");
/** Create an encrypted `.aetherbak` backup in `destDir` (needs the unlocked key). */
export const createBackup = (destDir: string, includeAppData: boolean) =>
  call<BackupReport>("cmd_sync_backup_create", { destDir, includeAppData });
/** Backups in a folder, newest first (no passphrase needed). */
export const listBackups = (dir: string) => call<BackupInfo[]>("cmd_sync_backup_list", { dir });
/** Decrypt and check every file of a backup. */
export const verifyBackup = (path: string, passphrase: string) =>
  call<BackupVerifyReport>("cmd_sync_backup_verify", { path, passphrase });
/** Dry-run preview: files, bytes, creation time and device. */
export const previewBackup = (path: string, passphrase: string) =>
  call<BackupPreview>("cmd_sync_backup_preview", { path, passphrase });
/** Restore a backup into `targetDir` (`merge` keeps existing files, `replace` moves them aside first). */
export const restoreBackup = (path: string, passphrase: string, targetDir: string, mode: RestoreMode) =>
  call<RestoreReport>("cmd_sync_backup_restore", { path, passphrase, targetDir, mode });

/** Subscribe to status changes. */
export const onSyncStatus = (handler: (status: SyncStatus) => void): Promise<UnlistenFn> =>
  listenSafe<SyncStatus>(SYNC_STATUS_EVENT, handler);
/** Subscribe to progress of long operations. */
export const onSyncProgress = (handler: (progress: SyncProgress) => void): Promise<UnlistenFn> =>
  listenSafe<SyncProgress>(SYNC_PROGRESS_EVENT, handler);
