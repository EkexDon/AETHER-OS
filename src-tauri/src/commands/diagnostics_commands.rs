//! Tauri commands for local crash reports, the frontend error sink and
//! basic app information. See `engine/diagnostics.rs`.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::engine::diagnostics::{
    open_in_file_manager, CrashReport, CrashReportSummary, FrontendErrorPayload,
};
use crate::AppState;

/// Static information about the running build, shown in About/diagnostics.
#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub version: String,
    pub tauri_version: String,
    pub os: String,
    pub arch: String,
    pub data_dir: String,
}

/// List all crash reports, newest first.
#[tauri::command]
pub async fn cmd_list_crash_reports(
    state: State<'_, AppState>,
) -> Result<Vec<CrashReportSummary>, String> {
    state
        .diagnostics
        .list_crash_reports()
        .map_err(|e| e.to_string())
}

/// Read one crash report by id (as returned by `cmd_list_crash_reports`).
#[tauri::command]
pub async fn cmd_read_crash_report(
    state: State<'_, AppState>,
    id: String,
) -> Result<CrashReport, String> {
    state
        .diagnostics
        .read_crash_report(&id)
        .map_err(|e| e.to_string())
}

/// Delete every crash report. Returns the number of removed reports.
#[tauri::command]
pub async fn cmd_clear_crash_reports(state: State<'_, AppState>) -> Result<usize, String> {
    state
        .diagnostics
        .clear_crash_reports()
        .map_err(|e| e.to_string())
}

/// Record an error reported by the webview (error boundary, `window.onerror`,
/// unhandled promise rejections). Fatal errors also produce a crash report.
#[tauri::command]
pub async fn cmd_log_frontend_error(
    state: State<'_, AppState>,
    payload: FrontendErrorPayload,
) -> Result<(), String> {
    state
        .diagnostics
        .log_frontend_error(&payload)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Reveal the app data directory (logs, crash reports, stores) in the
/// platform file manager.
#[tauri::command]
pub async fn cmd_open_app_data_dir(state: State<'_, AppState>) -> Result<(), String> {
    open_in_file_manager(state.diagnostics.data_dir()).map_err(|e| e.to_string())
}

/// Version, platform and data location of the running app.
#[tauri::command]
pub async fn cmd_get_app_info(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppInfo, String> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        tauri_version: tauri::VERSION.to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        data_dir: state.diagnostics.data_dir().to_string_lossy().to_string(),
    })
}
