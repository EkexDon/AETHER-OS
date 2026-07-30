use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindow};

use crate::engine::browser::BrowserInfo;
use crate::AppState;

/// Track open browser child webviews by label.
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

/// Open a URL as a child webview embedded within the main app window.
/// The child window is borderless, has no taskbar entry, and is positioned
/// by the frontend via `cmd_browser_webview_set_bounds`.
/// Returns the window label so the frontend can track it.
#[tauri::command]
pub async fn cmd_browser_webview_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    let label = state.browser_windows.next_label();

    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;

    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let title: String = url
        .replace("https://", "")
        .replace("http://", "")
        .chars()
        .take(40)
        .collect();

    let child = WebviewWindow::builder(&app, &label, WebviewUrl::External(parsed))
        .title(&format!("AETHER-OS Browser — {}", title))
        .parent(&main_window)
        .map_err(|e| format!("Failed to set parent: {e}"))?
        .decorations(false)
        .skip_taskbar(true)
        .resizable(true)
        .visible(false) // hidden until positioned
        .inner_size(800.0, 600.0)
        .position(0.0, 0.0)
        .build()
        .map_err(|e| format!("Failed to create child webview: {e}"))?;

    state
        .browser_windows
        .windows
        .lock()
        .unwrap()
        .insert(
            label.clone(),
            child.url().map(|u| u.to_string()).unwrap_or_default(),
        );

    Ok(label)
}

/// Position and size a child browser webview to overlay the browser content area.
/// Coordinates are logical (not physical) pixels relative to the main window.
#[tauri::command]
pub async fn cmd_browser_webview_set_bounds(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window {} not found", label))?;

    win.set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("Failed to set position: {e}"))?;

    win.set_size(LogicalSize::new(width, height))
        .map_err(|e| format!("Failed to set size: {e}"))?;

    win.show()
        .map_err(|e| format!("Failed to show webview: {e}"))?;

    Ok(())
}

/// Show a browser child webview.
#[tauri::command]
pub async fn cmd_browser_webview_show(
    app: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window {} not found", label))?;
    win.show()
        .map_err(|e| format!("Failed to show webview: {e}"))?;
    win.set_focus()
        .map_err(|e| format!("Failed to focus webview: {e}"))?;
    Ok(())
}

/// Hide a browser child webview (when switching away from browser view).
#[tauri::command]
pub async fn cmd_browser_webview_hide(
    app: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window {} not found", label))?;
    win.hide()
        .map_err(|e| format!("Failed to hide webview: {e}"))?;
    Ok(())
}

/// Close a browser child webview by label.
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

/// Navigate a browser child webview to a new URL.
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

/// Go back in a browser child webview.
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

/// Go forward in a browser child webview.
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

/// Reload a browser child webview.
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

/// List all open browser child webviews.
#[tauri::command]
pub async fn cmd_browser_webview_list(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    let windows = state.browser_windows.windows.lock().unwrap();
    Ok(windows.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// Hide all browser child webviews (called when switching away from browser view).
#[tauri::command]
pub async fn cmd_browser_webview_hide_all(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let labels: Vec<String> = state
        .browser_windows
        .windows
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    for label in labels {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.hide();
        }
    }
    Ok(())
}
