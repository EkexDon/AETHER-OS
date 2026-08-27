use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl};

use crate::engine::browser::BrowserInfo;
use crate::AppState;

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/// Tracks embedded browser webviews (label -> current URL).
/// The webviews themselves live in Tauri's window manager and are
/// retrieved via `app.get_webview(label)`.
pub struct BrowserWebviews {
    urls: Mutex<HashMap<String, String>>,
    counter: Mutex<u32>,
}

impl BrowserWebviews {
    pub fn new() -> Self {
        Self {
            urls: Mutex::new(HashMap::new()),
            counter: Mutex::new(0),
        }
    }

    fn next_label(&self) -> String {
        let mut c = self.counter.lock().unwrap();
        *c += 1;
        format!("browser-webview-{}", *c)
    }

    fn insert(&self, label: String, url: String) {
        self.urls.lock().unwrap().insert(label, url);
    }

    fn remove(&self, label: &str) {
        self.urls.lock().unwrap().remove(label);
    }

    fn list(&self) -> Vec<(String, String)> {
        self.urls
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

#[derive(Clone, Serialize)]
struct BrowserNavPayload {
    label: String,
    url: String,
}

#[derive(Clone, Serialize)]
struct BrowserTitlePayload {
    label: String,
    title: String,
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

/// Open a URL in a native webview embedded as a subview of the main window.
/// Coordinates are logical pixels relative to the main window's content area
/// (identical to getBoundingClientRect() values from the frontend).
#[tauri::command]
pub async fn cmd_browser_webview_open(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let label = state.browser_webviews.next_label();
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;

    let main_window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let nav_handle = app.clone();
    let nav_label = label.clone();
    let title_handle = app.clone();
    let title_label = label.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .user_agent(BROWSER_USER_AGENT)
        .devtools(true)
        .on_navigation(move |nav_url| {
            let _ = nav_handle.emit(
                "browser-webview-nav",
                BrowserNavPayload {
                    label: nav_label.clone(),
                    url: nav_url.to_string(),
                },
            );
            true
        })
        .on_document_title_changed(move |_webview, title| {
            let _ = title_handle.emit(
                "browser-webview-title",
                BrowserTitlePayload {
                    label: title_label.clone(),
                    title,
                },
            );
        });

    main_window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| format!("Failed to create embedded webview: {e}"))?;

    state.browser_webviews.insert(label.clone(), url);
    Ok(label)
}

/// Resize/reposition an embedded browser webview.
#[tauri::command]
pub async fn cmd_browser_webview_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
        })
        .map_err(|e| format!("Failed to set bounds: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_browser_webview_show(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    webview.show().map_err(|e| format!("Failed to show: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_browser_webview_hide(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    webview.hide().map_err(|e| format!("Failed to hide: {e}"))?;
    Ok(())
}

/// Close an embedded browser webview and remove it from tracking.
#[tauri::command]
pub async fn cmd_browser_webview_close(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|e| format!("Failed to close webview: {e}"))?;
    }
    state.browser_webviews.remove(&label);
    Ok(())
}

/// Navigate an embedded browser webview to a new URL.
#[tauri::command]
pub async fn cmd_browser_webview_navigate(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
    url: String,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    webview
        .navigate(parsed)
        .map_err(|e| format!("Failed to navigate: {e}"))?;
    state.browser_webviews.insert(label, url);
    Ok(())
}

#[tauri::command]
pub async fn cmd_browser_webview_back(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    webview
        .eval("window.history.back();")
        .map_err(|e| format!("Failed to go back: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_browser_webview_forward(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    webview
        .eval("window.history.forward();")
        .map_err(|e| format!("Failed to go forward: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_browser_webview_reload(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    webview
        .eval("window.location.reload();")
        .map_err(|e| format!("Failed to reload: {e}"))?;
    Ok(())
}

/// List all open embedded browser webviews (label, url).
#[tauri::command]
pub async fn cmd_browser_webview_list(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    Ok(state.browser_webviews.list())
}

/// Hide all embedded browser webviews (e.g. when leaving the browser view).
#[tauri::command]
pub async fn cmd_browser_webview_hide_all(app: AppHandle) -> Result<(), String> {
    for webview in app.webviews().values() {
        if webview.label().starts_with("browser-webview-") {
            let _ = webview.hide();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_next_label_increments() {
        let wv = BrowserWebviews::new();
        let a = wv.next_label();
        let b = wv.next_label();
        assert_ne!(a, b);
        assert!(a.starts_with("browser-webview-"));
        assert!(b.starts_with("browser-webview-"));
    }

    #[test]
    fn test_insert_list_remove() {
        let wv = BrowserWebviews::new();
        let label = wv.next_label();
        wv.insert(label.clone(), "https://example.com".to_string());
        let list = wv.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].0, label);
        assert_eq!(list[0].1, "https://example.com");

        wv.remove(&label);
        assert!(wv.list().is_empty());
    }

    #[test]
    fn test_insert_updates_url() {
        let wv = BrowserWebviews::new();
        let label = wv.next_label();
        wv.insert(label.clone(), "https://a.com".to_string());
        wv.insert(label.clone(), "https://b.com".to_string());
        let list = wv.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].1, "https://b.com");
    }
}
