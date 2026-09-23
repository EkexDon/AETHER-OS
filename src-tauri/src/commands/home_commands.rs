//! Tauri commands for the Home feature's focus log (Pomodoro sessions and
//! daily focus statistics). See `engine/focus_log.rs`.

use tauri::State;

use crate::engine::focus_log::{FocusSession, FocusSessionInput, FocusStats};
use crate::AppState;

/// Append a completed focus session to `<data_dir>/focus/sessions.jsonl`.
#[tauri::command]
pub async fn cmd_focus_log_session(
    state: State<'_, AppState>,
    session: FocusSessionInput,
) -> Result<FocusSession, String> {
    state
        .focus_log
        .log_session(session)
        .map_err(|e| e.to_string())
}

/// Focus statistics for the last `days` days (1–366) ending today, in the
/// machine's local time zone.
#[tauri::command]
pub async fn cmd_focus_stats(state: State<'_, AppState>, days: u32) -> Result<FocusStats, String> {
    let today = chrono::Local::now().date_naive();
    state
        .focus_log
        .stats(days, today)
        .map_err(|e| e.to_string())
}

/// The `limit` (1–1000) most recent sessions, newest first.
#[tauri::command]
pub async fn cmd_focus_list(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<FocusSession>, String> {
    state.focus_log.list(limit).map_err(|e| e.to_string())
}
