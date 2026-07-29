use tauri::State;

use crate::engine::browser::BrowserInfo;
use crate::AppState;

#[tauri::command]
pub async fn cmd_browser_info(state: State<'_, AppState>) -> Result<BrowserInfo, String> {
    Ok(state.browser.info())
}

#[tauri::command]
pub async fn cmd_browser_open(state: State<'_, AppState>, url: String) -> Result<(), String> {
    state.browser.open_url(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_browser_open_librewolf(state: State<'_, AppState>, url: String) -> Result<(), String> {
    state.browser.open_in_librewolf(&url).map_err(|e| e.to_string())
}
