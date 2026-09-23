//! Tauri commands for encrypted backup & folder sync (`engine::sync`).
//!
//! Heavy work (Argon2id key derivation, sync rounds, backups, restores,
//! passphrase changes) runs on the blocking thread pool so the async runtime
//! stays responsive. Passphrases are moved into `Zeroizing` buffers as soon
//! as they arrive and are never logged or persisted.
//!
//! Events: `sync-status` ([`SyncStatus`]) and `sync-progress`
//! ([`SyncProgress`](crate::engine::sync::SyncProgress)).

use std::path::Path;
use std::sync::Arc;

use tauri::{Emitter, Manager, State};
use zeroize::Zeroizing;

use crate::engine::error::AetherError;
use crate::engine::sync::conflict::KeepChoice;
use crate::engine::sync::folder_sync::SyncReport;
use crate::engine::sync::snapshot::{
    BackupInfo, BackupPreview, BackupReport, BackupVerifyReport, RestoreMode, RestoreReport,
};
use crate::engine::sync::{
    DeviceInfo, PassphraseChangeReport, SyncConflict, SyncConflictDetail, SyncEngine, SyncEvent,
    SyncFolderInfo, SyncSettings, SyncSettingsPatch, SyncStatus,
};
use crate::engine::vault_reader::VaultReader;
use crate::AppState;

/// Build the engine for `AppState`: forwards engine events to the webview,
/// unlocks from the opt-in key file in the background, starts the sync /
/// backup loop and forgets the key when the main window is destroyed.
pub fn init_sync(app: &tauri::AppHandle, data_dir: &Path) -> Result<Arc<SyncEngine>, AetherError> {
    // VaultReader is stateless (it reads the vault config on every call), so
    // a dedicated instance behaves exactly like the shared one.
    let vault = Arc::new(VaultReader::new(data_dir)?);
    let engine = Arc::new(SyncEngine::new(data_dir, vault)?);
    let handle = app.clone();
    engine.set_emitter(Arc::new(move |event| match event {
        SyncEvent::Status(status) => {
            let _ = handle.emit("sync-status", status);
        }
        SyncEvent::Progress(progress) => {
            let _ = handle.emit("sync-progress", progress);
        }
    }));
    let auto = Arc::clone(&engine);
    std::thread::Builder::new()
        .name("aether-sync-unlock".into())
        .spawn(move || {
            auto.try_auto_unlock();
        })?;
    engine.start()?;
    if let Some(window) = app.get_webview_window("main") {
        let on_close = Arc::clone(&engine);
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                on_close.shutdown();
            }
        });
    }
    Ok(engine)
}

/// Run `f` with the engine on the blocking pool.
async fn blocking<T, F>(state: &State<'_, AppState>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Arc<SyncEngine>) -> Result<T, AetherError> + Send + 'static,
{
    let engine = Arc::clone(&state.sync);
    tauri::async_runtime::spawn_blocking(move || f(engine))
        .await
        .map_err(|e| format!("sync task failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// Current sync & backup settings.
#[tauri::command]
pub async fn cmd_sync_get_settings(state: State<'_, AppState>) -> Result<SyncSettings, String> {
    Ok(state.sync.settings())
}

/// Update settings (partial). Changing the folder locks the key.
#[tauri::command]
pub async fn cmd_sync_set_settings(
    state: State<'_, AppState>,
    patch: SyncSettingsPatch,
) -> Result<SyncSettings, String> {
    blocking(&state, move |e| e.update_settings(patch)).await
}

/// Describe a folder (does it already contain an AETHER sync store?).
#[tauri::command]
pub async fn cmd_sync_inspect_folder(
    state: State<'_, AppState>,
    path: String,
) -> Result<SyncFolderInfo, String> {
    blocking(&state, move |e| e.inspect_folder(&path)).await
}

/// Derive the key from the passphrase and verify it (creates the key on
/// first use). `remember` stores the key on this device (opt-in).
#[tauri::command]
pub async fn cmd_sync_unlock(
    state: State<'_, AppState>,
    passphrase: String,
    remember: bool,
) -> Result<SyncStatus, String> {
    let passphrase = Zeroizing::new(passphrase);
    blocking(&state, move |e| e.unlock(&passphrase, remember)).await
}

/// Forget the key.
#[tauri::command]
pub async fn cmd_sync_lock(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    Ok(state.sync.lock())
}

/// Run a sync round now.
#[tauri::command]
pub async fn cmd_sync_now(state: State<'_, AppState>) -> Result<SyncReport, String> {
    blocking(&state, |e| e.sync_now()).await
}

/// Status snapshot.
#[tauri::command]
pub async fn cmd_sync_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    Ok(state.sync.status())
}

/// Conflict records (unresolved first).
#[tauri::command]
pub async fn cmd_sync_list_conflicts(
    state: State<'_, AppState>,
) -> Result<Vec<SyncConflict>, String> {
    blocking(&state, |e| e.list_conflicts()).await
}

/// Both versions of one conflict (for the side-by-side diff).
#[tauri::command]
pub async fn cmd_sync_get_conflict(
    state: State<'_, AppState>,
    id: String,
) -> Result<SyncConflictDetail, String> {
    blocking(&state, move |e| e.get_conflict(&id)).await
}

/// Settle a conflict: `local` | `remote` | `both`.
#[tauri::command]
pub async fn cmd_sync_resolve_conflict(
    state: State<'_, AppState>,
    id: String,
    keep: String,
) -> Result<SyncConflict, String> {
    let keep = KeepChoice::parse(&keep).map_err(|e| e.to_string())?;
    blocking(&state, move |e| e.resolve_conflict(&id, keep)).await
}

/// Change the passphrase and re-encrypt the sync folder.
#[tauri::command]
pub async fn cmd_sync_change_passphrase(
    state: State<'_, AppState>,
    old_passphrase: String,
    new_passphrase: String,
) -> Result<PassphraseChangeReport, String> {
    let old = Zeroizing::new(old_passphrase);
    let new = Zeroizing::new(new_passphrase);
    blocking(&state, move |e| e.change_passphrase(&old, &new)).await
}

/// Devices registered in the sync folder.
#[tauri::command]
pub async fn cmd_sync_devices(state: State<'_, AppState>) -> Result<Vec<DeviceInfo>, String> {
    blocking(&state, |e| e.devices()).await
}

/// Create an encrypted backup in `dest_dir` (requires the unlocked key).
#[tauri::command]
pub async fn cmd_sync_backup_create(
    state: State<'_, AppState>,
    dest_dir: String,
    include_app_data: bool,
) -> Result<BackupReport, String> {
    blocking(&state, move |e| {
        e.backup_create(&dest_dir, include_app_data)
    })
    .await
}

/// Backups in a folder, newest first.
#[tauri::command]
pub async fn cmd_sync_backup_list(
    state: State<'_, AppState>,
    dir: String,
) -> Result<Vec<BackupInfo>, String> {
    blocking(&state, move |e| e.backup_list(&dir)).await
}

/// Decrypt and check every file of a backup.
#[tauri::command]
pub async fn cmd_sync_backup_verify(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<BackupVerifyReport, String> {
    let passphrase = Zeroizing::new(passphrase);
    blocking(&state, move |e| e.backup_verify(&path, &passphrase)).await
}

/// Dry-run preview of a backup: files, bytes, creation time, device.
#[tauri::command]
pub async fn cmd_sync_backup_preview(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<BackupPreview, String> {
    let passphrase = Zeroizing::new(passphrase);
    blocking(&state, move |e| e.backup_preview(&path, &passphrase)).await
}

/// Restore a backup into `target_dir` (`merge` | `replace`).
#[tauri::command]
pub async fn cmd_sync_backup_restore(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
    target_dir: String,
    mode: String,
) -> Result<RestoreReport, String> {
    let passphrase = Zeroizing::new(passphrase);
    let mode = RestoreMode::parse(&mode).map_err(|e| e.to_string())?;
    blocking(&state, move |e| {
        e.backup_restore(&path, &passphrase, &target_dir, mode)
    })
    .await
}
