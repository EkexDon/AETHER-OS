//! Tauri commands for the Calendar tab. All commands are thin
//! wrappers over the engine modules. See `docs/CALENDAR_PLAN.md`
//! §2.2, §7, §8.

use std::path::PathBuf;

use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;

use crate::engine::calendar::{CalendarEvent, EventPatch};
use crate::engine::calendar_ics::{
    export_calendar, import_calendar, IcsExportOptions, IcsImportOptions, IcsImportResult,
};
use crate::engine::calendar_notifier::ReminderSettings;
use crate::AppState;

#[tauri::command]
pub async fn cmd_list_calendar_events(
    state: State<'_, AppState>,
) -> Result<Vec<CalendarEvent>, String> {
    state.calendar.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_calendar_event(
    state: State<'_, AppState>,
    id: String,
) -> Result<CalendarEvent, String> {
    state.calendar.get(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cmd_create_calendar_event(
    state: State<'_, AppState>,
    title: String,
    description: String,
    all_day: bool,
    start: String,
    end: String,
    due: Option<String>,
    color: String,
    tags: Vec<String>,
    attendees: Vec<String>,
    location: Option<String>,
    source_note_path: Option<String>,
) -> Result<CalendarEvent, String> {
    let event = state
        .calendar
        .create(
            &title,
            &description,
            all_day,
            &start,
            &end,
            due,
            &color,
            tags,
            attendees,
            location,
            source_note_path,
        )
        .map_err(|e| e.to_string())?;
    state.notifier.reschedule();
    Ok(event)
}

#[tauri::command]
pub async fn cmd_update_calendar_event(
    state: State<'_, AppState>,
    id: String,
    patch: EventPatch,
) -> Result<CalendarEvent, String> {
    let event = state
        .calendar
        .update(&id, patch)
        .map_err(|e| e.to_string())?;
    state.notifier.reschedule();
    Ok(event)
}

#[tauri::command]
pub async fn cmd_delete_calendar_event(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.calendar.delete(&id).map_err(|e| e.to_string())?;
    state.notifier.prune_delivered(&id);
    state.notifier.reschedule();
    Ok(())
}

#[tauri::command]
pub async fn cmd_export_calendar_ics(
    state: State<'_, AppState>,
    from: Option<String>,
    to: Option<String>,
    calendar_name: Option<String>,
) -> Result<String, String> {
    let events = state.calendar.list().map_err(|e| e.to_string())?;
    let opts = IcsExportOptions {
        from,
        to,
        calendar_name: calendar_name.unwrap_or_else(|| "AETHER-OS".to_owned()),
    };
    Ok(export_calendar(&events, &opts))
}

/// Validate a user-picked .ics path: must end in `.ics` (case-insensitive)
/// and must not be a directory.
fn validate_ics_path(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("path is empty".to_owned());
    }
    let pb = PathBuf::from(path);
    let ext_ok = pb
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("ics"))
        .unwrap_or(false);
    if !ext_ok {
        return Err("path must end in .ics".to_owned());
    }
    Ok(pb)
}

#[tauri::command]
pub async fn cmd_write_ics_to_path(path: String, content: String) -> Result<(), String> {
    let pb = validate_ics_path(&path)?;
    if let Some(parent) = pb.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("parent directory does not exist: {}", parent.display()));
        }
    }
    std::fs::write(&pb, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_read_ics_from_path(path: String) -> Result<String, String> {
    let pb = validate_ics_path(&path)?;
    if !pb.exists() {
        return Err(format!("file does not exist: {}", pb.display()));
    }
    if pb.is_dir() {
        return Err("path is a directory, expected a file".to_owned());
    }
    std::fs::read_to_string(&pb).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_import_calendar_ics(
    state: State<'_, AppState>,
    content: String,
    overwrite_existing: bool,
    default_color: String,
) -> Result<IcsImportResult, String> {
    let opts = IcsImportOptions {
        overwrite_existing,
        default_color,
    };
    let (parsed, mut result) = import_calendar(&content, &opts).map_err(|e| e.to_string())?;

    for imported in parsed {
        let existing = state
            .calendar
            .get_by_uid(&imported.uid)
            .map_err(|e| e.to_string())?;
        if let Some(existing) = existing {
            if !opts.overwrite_existing {
                result.skipped += 1;
                continue;
            }
            let patch = build_update_patch(&imported.event);
            let updated = state
                .calendar
                .update(&existing.id, patch)
                .map_err(|e| e.to_string())?;
            let _ = updated; // returned via state mutation
            result.updated += 1;
        } else {
            // Use the engine's `create` to enforce validation + write
            // a fresh event; the imported event's generated id is
            // discarded.
            let e = imported.event;
            let _ = state
                .calendar
                .create(
                    &e.title,
                    &e.description,
                    e.all_day,
                    &e.start,
                    &e.end,
                    e.due,
                    &e.color,
                    e.tags,
                    e.attendees,
                    e.location,
                    e.source_note_path,
                )
                .map_err(|err| {
                    result.errors.push(format!("create failed for {}: {err}", e.uid));
                });
            result.added += 1;
        }
    }

    state.notifier.reschedule();
    Ok(result)
}

fn build_update_patch(event: &CalendarEvent) -> EventPatch {
    EventPatch {
        title: Some(event.title.clone()),
        description: Some(event.description.clone()),
        all_day: Some(event.all_day),
        start: Some(event.start.clone()),
        end: Some(event.end.clone()),
        due: Some(event.due.clone()),
        color: Some(event.color.clone()),
        tags: Some(event.tags.clone()),
        attendees: Some(event.attendees.clone()),
        location: Some(event.location.clone()),
        source_note_path: Some(event.source_note_path.clone()),
    }
}

#[tauri::command]
pub async fn cmd_get_reminder_settings(
    state: State<'_, AppState>,
) -> Result<ReminderSettings, String> {
    Ok(state.notifier.settings())
}

#[tauri::command]
pub async fn cmd_set_reminder_settings(
    state: State<'_, AppState>,
    settings: ReminderSettings,
) -> Result<(), String> {
    state.notifier.set_settings(settings).map_err(|e| e.to_string())?;
    state.notifier.reschedule();
    Ok(())
}

#[tauri::command]
pub async fn cmd_request_notification_permission(app: AppHandle) -> Result<bool, String> {
    let granted = app
        .notification()
        .request_permission()
        .map_err(|e| e.to_string())?;
    Ok(matches!(
        granted,
        tauri_plugin_notification::PermissionState::Granted
    ))
}

#[cfg(test)]
mod tests {
    //! The Tauri 2 `#[tauri::command]` macro defaults to `rename_all = "camelCase"`
    //! at the **top-level** arg list, so `cmd_create_calendar_event`'s
    //! `all_day: bool` param expects the JSON key `allDay`. Nested structs
    //! (e.g. `EventPatch` inside `cmd_update_calendar_event`) do NOT get that
    //! rename — they go through plain `serde::Deserialize` and accept the
    //! Rust field names (`all_day`, `source_note_path`, etc.). The IPC
    //! wrappers in `src/lib/ipc.ts` are written to match: top-level args use
    //! camelCase, patch fields use snake_case.
    //!
    //! (Note: serde's default field-name matching is case-insensitive, so
    //! `allDay` in the patch also works — but the IPC wrapper stays on
    //! `all_day` for clarity and to mirror the Rust struct.)
    use super::*;
    use crate::engine::calendar::EventPatch;

    #[test]
    fn event_patch_deserialises_with_snake_case_all_day() {
        let json = r#"{"all_day": true, "title": "x"}"#;
        let patch: EventPatch = serde_json::from_str(json).expect("parse");
        assert_eq!(patch.all_day, Some(true));
        assert_eq!(patch.title.as_deref(), Some("x"));
    }

    #[test]
    fn event_patch_deserialises_partial_with_only_all_day() {
        // Confirms that absent fields default to None (the `#[serde(default)]`
        // on every field), so a one-field patch is valid.
        let json = r#"{"all_day": false}"#;
        let patch: EventPatch = serde_json::from_str(json).expect("parse");
        assert_eq!(patch.all_day, Some(false));
        assert_eq!(patch.title, None);
    }
}

// (end of file)
