use std::path::Path;

use serde_json::Value;
use tauri::{Emitter, State};

use crate::commands::ide_commands::workspace;
use crate::engine::error::AetherError;
use crate::engine::lsp::{self, LspSessionInfo};
use crate::AppState;

const LSP_EVENT: &str = "lsp-message";

fn validate_root(state: &State<'_, AppState>, root_path: &str) -> Result<String, AetherError> {
    let resolved = workspace(state).resolve_existing(root_path)?;
    Ok(resolved.to_string_lossy().to_string())
}

/// Start (or attach to) the language server for `language` rooted at
/// `root_path`. Returns `Ok(None)` when no known server is installed — the
/// frontend then silently keeps its built-in single-file features.
#[tauri::command]
pub async fn cmd_lsp_start(
    state: State<'_, AppState>,
    root_path: String,
    language: String,
) -> Result<Option<LspSessionInfo>, AetherError> {
    let canonical_root = validate_root(&state, &root_path)?;
    let key = lsp::session_key(&language, &canonical_root);

    if state.lsp.running().contains(&key) {
        let command = first_candidate_command(&language);
        return Ok(Some(LspSessionInfo { key, language, command }));
    }

    // Pick the first candidate that exists on this machine.
    let mut chosen: Option<Vec<String>> = None;
    for candidate in lsp::server_candidates(&language) {
        let argv: Vec<String> = candidate.iter().map(|s| s.to_string()).collect();
        if lsp::find_in_path(candidate[0]).is_some() {
            chosen = Some(argv);
            break;
        }
    }
    let Some(argv) = chosen else {
        return Ok(None);
    };
    let command = argv.join(" ");

    let app = state.lsp_app.clone();
    let exit_app = app.clone();
    state.lsp.start(
        &key,
        Path::new(&canonical_root),
        &argv,
        // On exit tell the frontend so it can drop stale providers.
        move |key| {
            let _ = exit_app.emit(
                LSP_EVENT,
                serde_json::json!({ "key": key, "message": { "aetherServerExit": true } }),
            );
        },
        move |key, message| {
            let _ = app.emit(LSP_EVENT, serde_json::json!({ "key": key, "message": message }));
        },
    )?;

    Ok(Some(LspSessionInfo { key, language, command }))
}

fn first_candidate_command(language: &str) -> String {
    lsp::server_candidates(language)[0].join(" ")
}

/// Forward one JSON-RPC message from the webview to the server.
#[tauri::command]
pub async fn cmd_lsp_send(
    state: State<'_, AppState>,
    key: String,
    message: Value,
) -> Result<(), AetherError> {
    state.lsp.send(&key, &message)
}

/// Stop a specific server (used when a project folder is closed).
#[tauri::command]
pub async fn cmd_lsp_stop(state: State<'_, AppState>, key: String) -> Result<(), AetherError> {
    state.lsp.stop(&key);
    Ok(())
}

/// Stop every server (used when leaving the IDE view).
#[tauri::command]
pub async fn cmd_lsp_stop_all(state: State<'_, AppState>) -> Result<(), AetherError> {
    state.lsp.stop_all();
    Ok(())
}
