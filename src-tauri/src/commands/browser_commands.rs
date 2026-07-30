use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{Manager, State, WebviewUrl, WebviewWindow};

use crate::engine::browser::BrowserInfo;
use crate::AppState;

/// Track open browser webview windows by label.
pub struct BrowserWindows {
    windows: Mutex<HashMap<String, String>>, // label -> url
    counter: Mutex<u32>,
}

impl BrowserWindows {
    pub fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
            counter: Mutex::new(0),
        }
    }

    fn next_label(&self) -> String {
        let mut c = self.counter.lock().unwrap();
        *c += 1;
        format!("browser-{}", *c)
    }
}

#[tauri::command]
pub async fn cmd_browser_info(state: State<'_, AppState>) -> Result<BrowserInfo, String> {
    Ok(state.browser.info())
}

#[tauri::command]
pub async fn cmd_browser_open(state: State<'_, AppState>, url: String) -> Result<(), String> {
    state.browser.open_url(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_browser_open_librewolf(
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    state.browser.open_in_librewolf(&url).map_err(|e| e.to_string())
}

/// Open a URL in a native Tauri WebviewWindow (bypasses iframe restrictions).
/// Returns the window label so the frontend can track it.
#[tauri::command]
pub async fn cmd_browser_webview_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    let label = state.browser_windows.next_label();

    let title: String = url
        .replace("https://", "")
        .replace("http://", "")
        .chars()
        .take(40)
        .collect();

    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;

    let window = WebviewWindow::builder(&app, &label, WebviewUrl::External(parsed))
        .title(&format!("AETHER-OS Browser — {}", title))
        .inner_size(1200.0, 800.0)
        .min_inner_size(400.0, 300.0)
        .build()
        .map_err(|e| format!("Failed to create webview window: {e}"))?;

    state
        .browser_windows
        .windows
        .lock()
        .unwrap()
        .insert(
            label.clone(),
            window.url().map(|u| u.to_string()).unwrap_or_default(),
        );

    Ok(label)
}

/// Close a browser webview window by label.
#[tauri::command]
pub async fn cmd_browser_webview_close(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    label: String,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.close()
            .map_err(|e| format!("Failed to close window: {e}"))?;
    }
    state
        .browser_windows
        .windows
        .lock()
        .unwrap()
        .remove(&label);
    Ok(())
}

/// Navigate a browser webview window to a new URL.
#[tauri::command]
pub async fn cmd_browser_webview_navigate(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    label: String,
    url: String,
) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window {} not found", label))?;

    let js = format!(
        "window.location.href = {};",
        serde_json::to_string(&url).map_err(|e| e.to_string())?
    );
    win.eval(&js)
        .map_err(|e| format!("Failed to navigate: {e}"))?;

    state
        .browser_windows
        .windows
        .lock()
        .unwrap()
        .insert(label, url);

    Ok(())
}

/// Go back in a browser webview window.
#[tauri::command]
pub async fn cmd_browser_webview_back(
    app: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window {} not found", label))?;
    win.eval("window.history.back();")
        .map_err(|e| format!("Failed to go back: {e}"))?;
    Ok(())
}

/// Go forward in a browser webview window.
#[tauri::command]
pub async fn cmd_browser_webview_forward(
    app: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window {} not found", label))?;
    win.eval("window.history.forward();")
        .map_err(|e| format!("Failed to go forward: {e}"))?;
    Ok(())
}

/// Reload a browser webview window.
#[tauri::command]
pub async fn cmd_browser_webview_reload(
    app: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window {} not found", label))?;
    win.eval("window.location.reload();")
        .map_err(|e| format!("Failed to reload: {e}"))?;
    Ok(())
}

/// List all open browser webview windows.
#[tauri::command]
pub async fn cmd_browser_webview_list(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    let windows = state.browser_windows.windows.lock().unwrap();
    Ok(windows.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}
