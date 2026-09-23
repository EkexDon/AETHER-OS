//! Tauri commands for the plugin system (`engine/plugins.rs`).
//!
//! Management commands are called by the plugin manager UI. The
//! capability-checked host operations (`cmd_plugins_vault_*`,
//! `cmd_plugins_note_create`, `cmd_plugins_fetch`) are called by the plugin
//! host on behalf of a running plugin; they take the plugin id and verify
//! the granted permission again here, independently of the host's check.

use serde_json::{Map, Value};
use tauri::State;

use crate::engine::plugins::{PluginFetchResponse, PluginInfo, PluginVaultNote};
use crate::AppState;

/// Every installed plugin (valid or broken), sorted by name.
#[tauri::command]
pub async fn cmd_plugins_list(state: State<'_, AppState>) -> Result<Vec<PluginInfo>, String> {
    state.plugins.list().map_err(|e| e.to_string())
}

/// Copy the bundled example plugins into the plugins folder once. Returns
/// the ids installed by this call (empty when nothing was new).
#[tauri::command]
pub async fn cmd_plugins_install_examples(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    state.plugins.install_examples().map_err(|e| e.to_string())
}

/// Source of an enabled plugin's entry module, loaded into its worker.
#[tauri::command]
pub async fn cmd_plugins_read_source(
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    state.plugins.read_source(&id).map_err(|e| e.to_string())
}

/// Enable or disable a plugin.
#[tauri::command]
pub async fn cmd_plugins_set_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<PluginInfo, String> {
    state
        .plugins
        .set_enabled(&id, enabled)
        .map_err(|e| e.to_string())
}

/// Replace the permissions granted to a plugin (a subset of its manifest's).
#[tauri::command]
pub async fn cmd_plugins_set_permissions(
    state: State<'_, AppState>,
    id: String,
    permissions: Vec<String>,
) -> Result<PluginInfo, String> {
    state
        .plugins
        .set_permissions(&id, &permissions)
        .map_err(|e| e.to_string())
}

/// Install or update a plugin from an absolute folder or `.zip` path.
#[tauri::command]
pub async fn cmd_plugins_install_from_path(
    state: State<'_, AppState>,
    path: String,
) -> Result<PluginInfo, String> {
    state
        .plugins
        .install_from_path(&path)
        .map_err(|e| e.to_string())
}

/// Remove a plugin together with its settings and storage.
#[tauri::command]
pub async fn cmd_plugins_uninstall(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.plugins.uninstall(&id).map_err(|e| e.to_string())
}

/// Effective settings of a plugin (stored values over manifest defaults).
#[tauri::command]
pub async fn cmd_plugins_get_settings(
    state: State<'_, AppState>,
    id: String,
) -> Result<Map<String, Value>, String> {
    state.plugins.get_settings(&id).map_err(|e| e.to_string())
}

/// Update some settings (`{ key: value }`); returns all settings.
#[tauri::command]
pub async fn cmd_plugins_set_settings(
    state: State<'_, AppState>,
    id: String,
    values: Value,
) -> Result<Map<String, Value>, String> {
    state
        .plugins
        .set_settings(&id, &values)
        .map_err(|e| e.to_string())
}

/// Read one value from a plugin's storage (`null` when missing).
#[tauri::command]
pub async fn cmd_plugins_storage_get(
    state: State<'_, AppState>,
    id: String,
    key: String,
) -> Result<Option<Value>, String> {
    state
        .plugins
        .storage_get(&id, &key)
        .map_err(|e| e.to_string())
}

/// Store a value in a plugin's storage; `null` deletes the key.
#[tauri::command]
pub async fn cmd_plugins_storage_set(
    state: State<'_, AppState>,
    id: String,
    key: String,
    value: Option<Value>,
) -> Result<(), String> {
    state
        .plugins
        .storage_set(&id, &key, value)
        .map_err(|e| e.to_string())
}

/// Reveal the plugins folder (or one plugin's folder) in the file manager.
#[tauri::command]
pub async fn cmd_plugins_open_folder(
    state: State<'_, AppState>,
    id: Option<String>,
) -> Result<(), String> {
    state
        .plugins
        .open_folder(id.as_deref())
        .map_err(|e| e.to_string())
}

/// Vault notes with vault-relative paths (requires `vault:read`).
#[tauri::command]
pub async fn cmd_plugins_vault_list(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<PluginVaultNote>, String> {
    state
        .plugins
        .vault_list(&state.vault, &id)
        .map_err(|e| e.to_string())
}

/// Content of a vault note (requires `vault:read`).
#[tauri::command]
pub async fn cmd_plugins_vault_read(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<String, String> {
    state
        .plugins
        .vault_read(&state.vault, &id, &path)
        .map_err(|e| e.to_string())
}

/// Create or overwrite a vault note (requires `vault:write`).
#[tauri::command]
pub async fn cmd_plugins_vault_write(
    state: State<'_, AppState>,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    state
        .plugins
        .vault_write(&state.vault, &id, &path, &content)
        .map_err(|e| e.to_string())
}

/// Create a new note without overwriting an existing one (requires
/// `notes:create`). Returns the vault-relative path.
#[tauri::command]
pub async fn cmd_plugins_note_create(
    state: State<'_, AppState>,
    id: String,
    title: String,
    content: String,
) -> Result<String, String> {
    state
        .plugins
        .note_create(&state.vault, &id, &title, &content)
        .map_err(|e| e.to_string())
}

/// HTTPS GET for a plugin, limited to hosts granted via `net:fetch:<host>`.
#[tauri::command]
pub async fn cmd_plugins_fetch(
    state: State<'_, AppState>,
    id: String,
    url: String,
) -> Result<PluginFetchResponse, String> {
    state
        .plugins
        .fetch(&id, &url)
        .await
        .map_err(|e| e.to_string())
}
