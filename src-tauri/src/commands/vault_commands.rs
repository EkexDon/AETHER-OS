use tauri::State;

use crate::engine::vault_reader::{
    validate_vault_dir, GraphData, VaultAsset, VaultIndex, VaultNote, VaultStats,
};
use crate::AppState;

#[tauri::command]
pub async fn cmd_get_vault_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.vault.detect_vault_path())
}

/// Connect a vault folder: an absolute path to an existing directory that
/// is not a filesystem root or system folder.
#[tauri::command]
pub async fn cmd_set_vault_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let path = validate_vault_dir(&path).map_err(|e| e.to_string())?;
    state.vault.set_vault_path(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_vault_notes(state: State<'_, AppState>) -> Result<Vec<VaultNote>, String> {
    let vault_path = state
        .vault
        .detect_vault_path()
        .ok_or_else(|| "No vault path configured. Open Settings to set a vault path.".to_owned())?;
    state
        .vault
        .scan_vault(&vault_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_note_content(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    state.vault.read_note(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_vault_index(state: State<'_, AppState>) -> Result<Option<VaultIndex>, String> {
    let vault_path = state
        .vault
        .detect_vault_path()
        .ok_or_else(|| "No vault path configured.".to_owned())?;
    state
        .vault
        .load_vault_index(&vault_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_vault_graph(state: State<'_, AppState>) -> Result<GraphData, String> {
    let vault_path = state
        .vault
        .detect_vault_path()
        .ok_or_else(|| "No vault path configured.".to_owned())?;
    state
        .vault
        .build_graph(&vault_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_vault_stats(state: State<'_, AppState>) -> Result<VaultStats, String> {
    let vault_path = state
        .vault
        .detect_vault_path()
        .ok_or_else(|| "No vault path configured.".to_owned())?;
    state
        .vault
        .get_vault_stats(&vault_path)
        .map_err(|e| e.to_string())
}

/// An image, video, audio or PDF file embedded in a note, base64-encoded.
/// `path` is vault-relative or absolute and must resolve inside the vault
/// (see `VaultReader::read_asset` for the allowed types and the size cap).
#[tauri::command]
pub async fn cmd_read_vault_asset(
    state: State<'_, AppState>,
    path: String,
) -> Result<VaultAsset, String> {
    let vault = state.vault.clone();
    tauri::async_runtime::spawn_blocking(move || vault.read_asset(&path))
        .await
        .map_err(|e| format!("asset read failed: {e}"))?
        .map_err(|e| e.to_string())
}
