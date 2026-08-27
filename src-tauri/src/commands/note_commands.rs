use tauri::State;

use crate::engine::agent_actions::{execute_action, AgentAction};
use crate::engine::vault_reader::Backlink;
use crate::engine::web_clipper::ClippedPage;
use crate::AppState;

/// Overwrite a note's content. Path must be inside the vault (enforced by
/// VaultReader::write_note).
#[tauri::command]
pub async fn cmd_write_note(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    state.vault.write_note(&path, &content).map_err(|e| e.to_string())
}

/// Create a new note in the vault. `rel_path` is vault-relative
/// (e.g. "clips/Article.md"); returns the created absolute path.
#[tauri::command]
pub async fn cmd_create_note(
    state: State<'_, AppState>,
    rel_path: String,
    content: String,
) -> Result<String, String> {
    state.vault.create_note(&rel_path, &content).map_err(|e| e.to_string())
}

/// Append content to an existing note.
#[tauri::command]
pub async fn cmd_append_note(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    state.vault.append_note(&path, &content).map_err(|e| e.to_string())
}

/// All notes linking to `note_name` via [[wikilinks]], with line context.
#[tauri::command]
pub async fn cmd_get_backlinks(
    state: State<'_, AppState>,
    note_name: String,
) -> Result<Vec<Backlink>, String> {
    let vault_path = state
        .vault
        .detect_vault_path()
        .ok_or_else(|| "No vault path configured.".to_owned())?;
    state
        .vault
        .get_backlinks(&vault_path, &note_name)
        .map_err(|e| e.to_string())
}

/// Get (creating if necessary) today's daily note. Returns its path.
#[tauri::command]
pub async fn cmd_daily_note(state: State<'_, AppState>) -> Result<String, String> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    state
        .vault
        .get_or_create_daily_note(&today)
        .map_err(|e| e.to_string())
}

/// Append a timestamped bullet to today's daily note. Returns its path.
#[tauri::command]
pub async fn cmd_append_daily(state: State<'_, AppState>, text: String) -> Result<String, String> {
    state.vault.append_daily_note(&text).map_err(|e| e.to_string())
}

/// Fetch a web page and extract its main content for clipping.
#[tauri::command]
pub async fn cmd_clip_url(state: State<'_, AppState>, url: String) -> Result<ClippedPage, String> {
    state.clipper.clip(&url).await.map_err(|e| e.to_string())
}

/// Execute an AI-proposed action after user approval.
#[tauri::command]
pub async fn cmd_execute_agent_action(
    state: State<'_, AppState>,
    action: AgentAction,
) -> Result<String, String> {
    execute_action(&state.vault, &action).map_err(|e| e.to_string())
}
