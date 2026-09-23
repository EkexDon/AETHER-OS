//! Tauri command for the GitHub release update check. See
//! `engine/updater.rs`.

use tauri::AppHandle;

use crate::engine::updater::{check_for_updates, UpdateInfo};

/// Compare the running version with the latest GitHub release.
#[tauri::command]
pub async fn cmd_check_for_updates(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    check_for_updates(&current).await.map_err(|e| e.to_string())
}
