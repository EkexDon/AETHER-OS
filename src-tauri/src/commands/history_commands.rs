//! Tauri commands for note history (automatic Git versioning of the vault).
//!
//! Every command resolves the vault path anew (`VaultReader::detect_vault_path`),
//! so switching vaults at runtime is picked up without a restart. Git work
//! runs on the blocking pool: an initial snapshot of a large vault must not
//! stall the async runtime.

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::engine::error::AetherError;
use crate::engine::git_repo::FileDiff;
use crate::engine::note_history::{
    HistoryActivity, HistoryRestore, HistoryStatus, NoteHistory, NoteVersion, HISTORY_COMMIT_EVENT,
};
use crate::engine::vault_reader::VaultReader;
use crate::AppState;

const NO_VAULT: &str = "No vault path configured. Open Settings to set a vault path.";

/// Build the engine for `AppState`: settings live in `<data_dir>/history`,
/// the watcher follows the vault of the shared `reader` (configured in
/// `<data_dir>/config.json`), and every commit is broadcast as a
/// `history-commit` event.
pub fn start_note_history(
    app: &AppHandle,
    data_dir: &Path,
    reader: Arc<VaultReader>,
) -> Result<Arc<NoteHistory>, AetherError> {
    let history = Arc::new(NoteHistory::new(&data_dir.join("history"), move || {
        reader.detect_vault_path()
    })?);
    let handle = app.clone();
    history.set_commit_listener(move |activity| {
        let _ = handle.emit(HISTORY_COMMIT_EVENT, activity);
    });
    history.start()?;
    Ok(history)
}

fn vault_path(state: &State<'_, AppState>) -> Result<String, String> {
    state
        .vault
        .detect_vault_path()
        .ok_or_else(|| NO_VAULT.to_owned())
}

/// Run blocking history work off the async runtime.
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, AetherError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| format!("note history task failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// Enabled flag, repository, commit count, last snapshot and watcher state.
#[tauri::command]
pub async fn cmd_history_status(state: State<'_, AppState>) -> Result<HistoryStatus, String> {
    let history = state.history.clone();
    let vault = state.vault.detect_vault_path();
    blocking(move || Ok(history.status(vault.as_deref()))).await
}

/// Versions of one note (absolute or vault-relative path), newest first.
#[tauri::command]
pub async fn cmd_history_list(
    state: State<'_, AppState>,
    path: String,
    limit: Option<usize>,
) -> Result<Vec<NoteVersion>, String> {
    let history = state.history.clone();
    let vault = vault_path(&state)?;
    blocking(move || history.list_versions(&vault, &path, limit)).await
}

/// Content of a note in one version.
#[tauri::command]
pub async fn cmd_history_read(
    state: State<'_, AppState>,
    path: String,
    commit_id: String,
) -> Result<String, String> {
    let history = state.history.clone();
    let vault = vault_path(&state)?;
    blocking(move || history.read_version(&vault, &path, &commit_id)).await
}

/// Old/new content of a note between two versions (`to: None` = the file on
/// disk, `from: None` = the version before `to`).
#[tauri::command]
pub async fn cmd_history_diff(
    state: State<'_, AppState>,
    path: String,
    from: Option<String>,
    to: Option<String>,
) -> Result<FileDiff, String> {
    let history = state.history.clone();
    let vault = vault_path(&state)?;
    blocking(move || history.diff(&vault, &path, from.as_deref(), to.as_deref())).await
}

/// Restore a note to a version (written like an editor save, then committed).
#[tauri::command]
pub async fn cmd_history_restore(
    state: State<'_, AppState>,
    path: String,
    commit_id: String,
) -> Result<HistoryRestore, String> {
    let history = state.history.clone();
    let reader = state.vault.clone();
    let vault = vault_path(&state)?;
    blocking(move || history.restore(&vault, &path, &commit_id, &reader)).await
}

/// Vault-wide activity feed, newest first.
#[tauri::command]
pub async fn cmd_history_recent(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<HistoryActivity>, String> {
    let history = state.history.clone();
    let vault = vault_path(&state)?;
    blocking(move || history.recent(&vault, limit)).await
}

/// Switch automatic versioning on or off (persisted); returns the new status.
#[tauri::command]
pub async fn cmd_history_set_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<HistoryStatus, String> {
    let history = state.history.clone();
    let vault = state.vault.detect_vault_path();
    blocking(move || {
        history.set_enabled(enabled)?;
        Ok(history.status(vault.as_deref()))
    })
    .await
}

/// Snapshot now: one note (`path`) or every pending change. Returns the new
/// commit, `null` when nothing changed.
#[tauri::command]
pub async fn cmd_history_commit_now(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<Option<HistoryActivity>, String> {
    let history = state.history.clone();
    let vault = vault_path(&state)?;
    blocking(move || history.commit_now(&vault, path.as_deref())).await
}
