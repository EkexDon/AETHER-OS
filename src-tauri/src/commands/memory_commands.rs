use tauri::State;

use crate::engine::memory_store::{ChatMessageRecord, Conversation, MemoryFact};
use crate::AppState;

#[tauri::command]
pub async fn cmd_save_conversation(
    state: State<'_, AppState>,
    messages: Vec<ChatMessageRecord>,
    context_notes: Vec<String>,
) -> Result<Conversation, String> {
    state
        .memory
        .save_conversation(messages, context_notes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_recent_conversations(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<Conversation>, String> {
    state
        .memory
        .load_recent(limit.unwrap_or(20))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_delete_conversation(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state
        .memory
        .delete_conversation(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_save_memory_fact(
    state: State<'_, AppState>,
    fact: String,
    category: String,
) -> Result<Vec<MemoryFact>, String> {
    state
        .memory
        .save_fact(&fact, &category)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_memory_facts(
    state: State<'_, AppState>,
) -> Result<Vec<MemoryFact>, String> {
    state.memory.load_facts().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_delete_memory_fact(
    state: State<'_, AppState>,
    fact: String,
) -> Result<Vec<MemoryFact>, String> {
    state
        .memory
        .delete_fact(&fact)
        .map_err(|e| e.to_string())
}
