use tauri::State;

use crate::commands::project_commands::ProjectDirsConfig;
use crate::engine::error::AetherError;
use crate::engine::workspace::{FsEntry, Workspace};
use crate::AppState;

/// Build the sandbox for the current request.
///
/// The allowed roots are the user's configured project directories plus the
/// vault. Rebuilding per call (rather than caching in `AppState`) keeps the
/// sandbox in sync when a directory is added or removed at runtime, and costs
/// only a handful of `canonicalize` calls.
pub(crate) fn workspace(state: &State<'_, AppState>) -> Workspace {
    let mut roots: Vec<String> = Vec::new();

    let config_path = state.vault.config_dir().join("project_dirs.json");
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<ProjectDirsConfig>(&content) {
            roots.extend(config.directories);
        }
    }

    if let Some(vault_path) = state.vault.detect_vault_path() {
        roots.push(vault_path);
    }

    Workspace::new(roots)
}

#[tauri::command]
pub async fn cmd_ide_roots(state: State<'_, AppState>) -> Result<Vec<String>, AetherError> {
    Ok(workspace(&state)
        .roots()
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
pub async fn cmd_ide_list_dir(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<FsEntry>, AetherError> {
    workspace(&state).list_dir(&path)
}

#[tauri::command]
pub async fn cmd_ide_read_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, AetherError> {
    workspace(&state).read_file(&path)
}

#[tauri::command]
pub async fn cmd_ide_write_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), AetherError> {
    workspace(&state).write_file(&path, &content)
}

#[tauri::command]
pub async fn cmd_ide_create_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<String, AetherError> {
    workspace(&state).create_file(&path, &content)
}

#[tauri::command]
pub async fn cmd_ide_create_dir(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, AetherError> {
    workspace(&state).create_dir(&path)
}
