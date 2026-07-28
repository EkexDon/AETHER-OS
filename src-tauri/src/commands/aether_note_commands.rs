use tauri::State;

use crate::engine::aether_notes::AetherNote;
use crate::AppState;

#[tauri::command]
pub async fn cmd_create_aether_note(
    state: State<'_, AppState>,
    title: String,
    content: String,
    source_query: String,
    related_notes: Vec<String>,
) -> Result<AetherNote, String> {
    state
        .aether_notes
        .create(&title, &content, &source_query, related_notes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_aether_notes(
    state: State<'_, AppState>,
) -> Result<Vec<AetherNote>, String> {
    state.aether_notes.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_delete_aether_note(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.aether_notes.delete(&id).map_err(|e| e.to_string())
}
