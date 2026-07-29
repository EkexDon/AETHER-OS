use tauri::State;

use crate::engine::system_monitor::SystemMetrics;
use crate::AppState;

#[tauri::command]
pub async fn cmd_get_system_metrics(state: State<'_, AppState>) -> Result<SystemMetrics, String> {
    let metrics = state.system_monitor.collect();
    Ok(metrics)
}
