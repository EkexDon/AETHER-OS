//! Tauri commands for the clipboard history (`engine/clipboard.rs`).
//!
//! Every mutation emits `clipboard-changed` so all open views (history,
//! status bar, settings) refresh; the watcher thread emits the same event
//! for every new capture.

use tauri::{AppHandle, Emitter, State};

use crate::engine::clipboard::{
    ChangeReason, ClipItem, ClipKind, ClipboardChanged, ClipboardSettings, ClipboardStats,
    ListQuery, CLIPBOARD_CHANGED_EVENT,
};
use crate::AppState;

/// Notify the webview; a failed emit only means no window is listening.
fn notify(app: &AppHandle, event: ClipboardChanged) {
    if let Err(e) = app.emit(CLIPBOARD_CHANGED_EVENT, event) {
        eprintln!("[clipboard] failed to emit {CLIPBOARD_CHANGED_EVENT}: {e}");
    }
}

/// Parse the optional kind filter (`"all"` / empty = no filter).
fn parse_kind(kind: Option<String>) -> Result<Option<ClipKind>, String> {
    match kind.as_deref().map(str::trim) {
        None | Some("") | Some("all") => Ok(None),
        Some(value) => ClipKind::parse(value)
            .map(Some)
            .ok_or_else(|| format!("invalid input: unknown clip kind {value}")),
    }
}

/// History page, newest first, optionally filtered by full-text query,
/// kind and pin state.
#[tauri::command]
pub async fn cmd_clipboard_list(
    state: State<'_, AppState>,
    query: Option<String>,
    kind: Option<String>,
    pinned_only: bool,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<ClipItem>, String> {
    let query = ListQuery {
        query,
        kind: parse_kind(kind)?,
        pinned_only,
        limit,
        offset,
    };
    state.clipboard.list(&query).map_err(|e| e.to_string())
}

/// One clip with its full (untruncated) content.
#[tauri::command]
pub async fn cmd_clipboard_get(state: State<'_, AppState>, id: String) -> Result<ClipItem, String> {
    state.clipboard.get(&id).map_err(|e| e.to_string())
}

/// Write a clip back to the system clipboard; bumps its counters.
#[tauri::command]
pub async fn cmd_clipboard_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<ClipItem, String> {
    let engine = state.clipboard.clone();
    let item = tauri::async_runtime::spawn_blocking(move || engine.copy_to_system(&id))
        .await
        .map_err(|e| format!("clipboard copy failed: {e}"))?
        .map_err(|e| e.to_string())?;
    notify(&app, ClipboardChanged::clip(&item.id, ChangeReason::Copied));
    Ok(item)
}

/// Pin or unpin a clip (pinned clips are never pruned).
#[tauri::command]
pub async fn cmd_clipboard_pin(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<ClipItem, String> {
    let item = state
        .clipboard
        .set_pinned(&id, pinned)
        .map_err(|e| e.to_string())?;
    notify(
        &app,
        ClipboardChanged::clip(&item.id, ChangeReason::Updated),
    );
    Ok(item)
}

/// Delete one clip (and its image files).
#[tauri::command]
pub async fn cmd_clipboard_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.clipboard.delete(&id).map_err(|e| e.to_string())?;
    notify(&app, ClipboardChanged::clip(&id, ChangeReason::Deleted));
    Ok(())
}

/// Delete the history; `keep_pinned` spares pinned clips. Returns the
/// number of clips removed.
#[tauri::command]
pub async fn cmd_clipboard_clear(
    app: AppHandle,
    state: State<'_, AppState>,
    keep_pinned: bool,
) -> Result<usize, String> {
    let removed = state
        .clipboard
        .clear(keep_pinned)
        .map_err(|e| e.to_string())?;
    notify(&app, ClipboardChanged::general(ChangeReason::Cleared));
    Ok(removed)
}

/// Current capture and retention settings.
#[tauri::command]
pub async fn cmd_clipboard_get_settings(
    state: State<'_, AppState>,
) -> Result<ClipboardSettings, String> {
    Ok(state.clipboard.settings())
}

/// Validate, persist and apply settings (prunes right away).
#[tauri::command]
pub async fn cmd_clipboard_set_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: ClipboardSettings,
) -> Result<ClipboardSettings, String> {
    let saved = state
        .clipboard
        .set_settings(settings)
        .map_err(|e| e.to_string())?;
    notify(&app, ClipboardChanged::general(ChangeReason::Settings));
    Ok(saved)
}

/// Pause or resume capture for this session; returns the new state.
#[tauri::command]
pub async fn cmd_clipboard_set_paused(
    app: AppHandle,
    state: State<'_, AppState>,
    paused: bool,
) -> Result<bool, String> {
    let paused = state.clipboard.set_paused(paused);
    notify(&app, ClipboardChanged::general(ChangeReason::Settings));
    Ok(paused)
}

/// Totals, pause state and watcher health.
#[tauri::command]
pub async fn cmd_clipboard_stats(state: State<'_, AppState>) -> Result<ClipboardStats, String> {
    state.clipboard.stats().map_err(|e| e.to_string())
}

/// Save a clip as a vault note (`clipboard/<title>.md`); returns its path.
#[tauri::command]
pub async fn cmd_clipboard_save_as_note(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<String, String> {
    state
        .clipboard
        .save_as_note(&state.vault, &id, &title)
        .map_err(|e| e.to_string())
}

/// An image clip as a PNG data URL (`thumbnail` = ≤ 256 px version).
#[tauri::command]
pub async fn cmd_clipboard_image(
    state: State<'_, AppState>,
    id: String,
    thumbnail: bool,
) -> Result<String, String> {
    let engine = state.clipboard.clone();
    tauri::async_runtime::spawn_blocking(move || engine.image_data_url(&id, thumbnail))
        .await
        .map_err(|e| format!("image load failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// The latest clip, copied back to the system clipboard (`None` when the
/// history is empty). Backs the "Paste last clip into note" command.
#[tauri::command]
pub async fn cmd_clipboard_copy_latest(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ClipItem>, String> {
    let engine = state.clipboard.clone();
    let item = tauri::async_runtime::spawn_blocking(move || match engine.latest()? {
        Some(latest) => engine.copy_to_system(&latest.id).map(Some),
        None => Ok(None),
    })
    .await
    .map_err(|e| format!("clipboard copy failed: {e}"))?
    .map_err(|e| e.to_string())?;
    if let Some(item) = &item {
        notify(&app, ClipboardChanged::clip(&item.id, ChangeReason::Copied));
    }
    Ok(item)
}
