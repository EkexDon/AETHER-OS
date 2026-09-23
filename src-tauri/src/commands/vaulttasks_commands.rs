//! Tauri commands for vault tasks — checkboxes aggregated from every note
//! (`engine/vault_tasks.rs`).
//!
//! Scans and edits touch the filesystem, so they run on the blocking pool
//! instead of an async worker. Every edit takes the `expected_text` the UI
//! last saw; when the line changed on disk the command fails with
//! "note changed, rescan" and nothing is written.

use std::sync::Arc;

use tauri::State;

use crate::engine::error::AetherError;
use crate::engine::vault_reader::VaultReader;
use crate::engine::vault_tasks::{
    parse_due_arg, VaultTaskFilter, VaultTaskItem, VaultTaskPriority, VaultTaskStats,
    VaultTaskStatus, VaultTasksEngine,
};
use crate::AppState;

/// Run `job` with the vault reader and task engine on the blocking pool.
async fn blocking<T, F>(state: &State<'_, AppState>, job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&VaultReader, &VaultTasksEngine) -> Result<T, AetherError> + Send + 'static,
{
    let vault: Arc<VaultReader> = state.vault.clone();
    let engine: Arc<VaultTasksEngine> = state.vaulttasks.clone();
    tauri::async_runtime::spawn_blocking(move || job(&vault, &engine))
        .await
        .map_err(|e| format!("vault tasks worker failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// Tasks from all notes matching `filter` (all tasks when omitted).
#[tauri::command]
pub async fn cmd_vault_tasks_list(
    state: State<'_, AppState>,
    filter: Option<VaultTaskFilter>,
) -> Result<Vec<VaultTaskItem>, String> {
    let filter = filter.unwrap_or_default();
    blocking(&state, move |vault, engine| engine.list(vault, &filter)).await
}

/// Check or uncheck the task at `line` of `note_path`.
#[tauri::command]
pub async fn cmd_vault_tasks_toggle(
    state: State<'_, AppState>,
    note_path: String,
    line: usize,
    checked: bool,
    expected_text: String,
) -> Result<VaultTaskItem, String> {
    blocking(&state, move |vault, engine| {
        engine.toggle(vault, &note_path, line, checked, &expected_text)
    })
    .await
}

/// Rewrite the checkbox character (todo / in progress / done / cancelled).
#[tauri::command]
pub async fn cmd_vault_tasks_set_status(
    state: State<'_, AppState>,
    note_path: String,
    line: usize,
    status: VaultTaskStatus,
    expected_text: String,
) -> Result<VaultTaskItem, String> {
    blocking(&state, move |vault, engine| {
        engine.set_status(vault, &note_path, line, status, &expected_text)
    })
    .await
}

/// Set (`YYYY-MM-DD`) or clear (`null`) a task's due date.
#[tauri::command]
pub async fn cmd_vault_tasks_set_due(
    state: State<'_, AppState>,
    note_path: String,
    line: usize,
    due: Option<String>,
    expected_text: String,
) -> Result<VaultTaskItem, String> {
    let due = parse_due_arg(due.as_deref()).map_err(|e| e.to_string())?;
    blocking(&state, move |vault, engine| {
        engine.set_due(vault, &note_path, line, due, &expected_text)
    })
    .await
}

/// Set or clear (`"none"`) a task's priority.
#[tauri::command]
pub async fn cmd_vault_tasks_set_priority(
    state: State<'_, AppState>,
    note_path: String,
    line: usize,
    priority: VaultTaskPriority,
    expected_text: String,
) -> Result<VaultTaskItem, String> {
    blocking(&state, move |vault, engine| {
        engine.set_priority(vault, &note_path, line, priority, &expected_text)
    })
    .await
}

/// Add `- [ ] text` to a note (under its `Tasks` heading, else at the end).
#[tauri::command]
pub async fn cmd_vault_tasks_append(
    state: State<'_, AppState>,
    note_path: String,
    text: String,
) -> Result<VaultTaskItem, String> {
    blocking(&state, move |vault, engine| {
        engine.append_task(vault, &note_path, &text)
    })
    .await
}

/// Open / done / overdue / due-today counters.
#[tauri::command]
pub async fn cmd_vault_tasks_stats(state: State<'_, AppState>) -> Result<VaultTaskStats, String> {
    blocking(&state, |vault, engine| engine.stats(vault)).await
}

/// Drop the cache, re-parse every note and return all tasks.
#[tauri::command]
pub async fn cmd_vault_tasks_rescan(
    state: State<'_, AppState>,
) -> Result<Vec<VaultTaskItem>, String> {
    blocking(&state, |vault, engine| engine.rescan(vault)).await
}
