use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::engine::terminal::TerminalSession;
use crate::AppState;

/// PTY bytes travel base64-encoded so the webview gets them byte-exact.
/// A lossy UTF-8 round-trip would corrupt escape sequences at chunk
/// boundaries and turn binary output into rows of replacement glyphs.
#[derive(Serialize, Clone)]
struct TerminalOutputEvent<'a> {
    id: &'a str,
    #[serde(rename = "dataBase64")]
    data_base64: &'a str,
}

#[tauri::command]
pub async fn cmd_terminal_spawn(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    cwd: Option<String>,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TerminalSession, String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);

    state
        .terminal
        .spawn(cwd.as_deref(), shell.as_deref(), cols, rows, move |id, output: &[u8]| {
            let _ = app_handle.emit(
                "terminal-output",
                TerminalOutputEvent {
                    id,
                    data_base64: &base64::engine::general_purpose::STANDARD.encode(output),
                },
            );
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_terminal_write(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.terminal.write(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_terminal_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .terminal
        .resize(&id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_terminal_kill(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.terminal.kill(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_terminal_list(
    state: State<'_, AppState>,
) -> Result<Vec<TerminalSession>, String> {
    state.terminal.list().map_err(|e| e.to_string())
}
