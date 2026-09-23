//! Tauri commands for the Quick Launcher and Universal Search
//! (`engine/search_index.rs`), plus the system-wide launcher shortcut.
//!
//! Heavy work (SQLite, directory walks) runs on the blocking thread pool so
//! the async runtime stays responsive while the index is being built.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::engine::search_index::apps::{default_app_roots, resolve_app_path, AppEntry};
use crate::engine::search_index::settings::{parse_global_shortcut, SearchSettings};
use crate::engine::search_index::{
    parse_kinds, IndexReport, IndexSources, RecentHit, SearchHit, SearchIndex, SearchKind,
    SearchRequest, SearchStatus, SemanticMatch,
};
use crate::AppState;

/// Emitted (payload `null`) when the global shortcut asks for the launcher.
pub const LAUNCHER_OPEN_EVENT: &str = "launcher-open";
/// Emitted after each kind during an indexing run (payload `KindReport`).
pub const INDEX_PROGRESS_EVENT: &str = "search-index-progress";
/// Emitted when a background indexing run finished (payload `IndexReport`).
pub const INDEX_UPDATED_EVENT: &str = "search-index-updated";

/// Semantic neighbours fused into a query.
const SEMANTIC_TOP_K: usize = 30;
/// Error returned when semantic search is requested without a vault index.
/// The UI matches on "vault index" to offer the "Index vault" action.
pub const SEMANTIC_INDEX_MISSING: &str =
    "Semantic search needs the vault index. Run \"Index vault\" first, then try again.";

#[derive(Deserialize)]
struct ProjectDirsConfig {
    directories: Vec<String>,
}

/// Project directories configured in the Projects view
/// (`<data_dir>/project_dirs.json`, written by `project_commands.rs`).
fn read_project_dirs(config_dir: &Path) -> Vec<PathBuf> {
    std::fs::read_to_string(config_dir.join("project_dirs.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<ProjectDirsConfig>(&raw).ok())
        .map(|c| c.directories.into_iter().map(PathBuf::from).collect())
        .unwrap_or_default()
}

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Create the search engine, register the global-shortcut plugin and the
/// configured launcher shortcut, and start the initial index in the
/// background. Called from `lib.rs` setup.
pub fn init(
    app: &tauri::App,
    data_dir: &Path,
) -> Result<Arc<SearchIndex>, Box<dyn std::error::Error>> {
    let index = Arc::new(SearchIndex::new(&data_dir.join("search"))?);
    app.handle()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
    apply_global_shortcut(app.handle(), &index, &index.settings());
    spawn_background_index(app.handle().clone(), Vec::new(), false);
    Ok(index)
}

/// Bring the main window to the front and ask the UI to open the launcher.
fn reveal_launcher(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit(LAUNCHER_OPEN_EVENT, ());
}

/// (Re-)register the launcher shortcut according to `settings`. Failures
/// (e.g. the combination is taken by another app) are recorded in the
/// engine and shown in Settings → Search instead of failing start-up.
fn apply_global_shortcut(app: &AppHandle, index: &SearchIndex, settings: &SearchSettings) {
    let manager = app.global_shortcut();
    if let Some(previous) = index.registered_shortcut() {
        if let Ok(shortcut) = parse_global_shortcut(&previous) {
            let _ = manager.unregister(shortcut);
        }
    }
    if !settings.global_shortcut_enabled {
        index.set_shortcut_state(None, None);
        return;
    }
    let shortcut = match parse_global_shortcut(&settings.global_shortcut) {
        Ok(s) => s,
        Err(e) => {
            index.set_shortcut_state(None, Some(e.to_string()));
            return;
        }
    };
    let result = manager.on_shortcut(shortcut, |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            reveal_launcher(app);
        }
    });
    match result {
        Ok(()) => index.set_shortcut_state(Some(settings.global_shortcut.clone()), None),
        Err(e) => index.set_shortcut_state(
            None,
            Some(format!(
                "Could not register {}: {e}",
                settings.global_shortcut
            )),
        ),
    }
}

/// Gather every data source from `AppState` and run an indexing run,
/// emitting progress per kind.
fn run_reindex(
    app: &AppHandle,
    state: &AppState,
    kinds: &[SearchKind],
    force: bool,
) -> IndexReport {
    let sources = IndexSources {
        vault: state
            .vault
            .detect_vault_path()
            .map(|path| (state.vault.as_ref(), path)),
        project_dirs: read_project_dirs(state.vault.config_dir()),
        memory: &state.memory,
        calendar: &state.calendar,
        tasks: &state.task_board,
        app_roots: default_app_roots(),
    };
    state.search.reindex(&sources, kinds, force, &mut |report| {
        let _ = app.emit(INDEX_PROGRESS_EVENT, report);
    })
}

/// Index `kinds` (all when empty) on a background thread once `AppState`
/// is available, then emit [`INDEX_UPDATED_EVENT`].
fn spawn_background_index(app: AppHandle, kinds: Vec<SearchKind>, force: bool) {
    let spawned = std::thread::Builder::new()
        .name("aether-search-index".into())
        .spawn(move || {
            // `init` runs before `app.manage(AppState)`; wait for it.
            let mut state = None;
            for _ in 0..600 {
                if let Some(s) = app.try_state::<AppState>() {
                    state = Some(s);
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let Some(state) = state else {
                eprintln!("[AETHER] search index: application state never became available");
                return;
            };
            let report = run_reindex(&app, &state, &kinds, force);
            let _ = app.emit(INDEX_UPDATED_EVENT, &report);
        });
    if let Err(e) = spawned {
        eprintln!("[AETHER] search index: failed to start the indexing thread: {e}");
    }
}

fn parse_optional_kinds(kinds: Option<Vec<String>>) -> Result<Option<Vec<SearchKind>>, String> {
    kinds.map(|k| parse_kinds(&k)).transpose().map_err(map_err)
}

/// Search the index. `q` may start with `#` to search tags only. With
/// `semantic: true` the vault's vector index is fused in (fails with
/// [`SEMANTIC_INDEX_MISSING`] when the vault has not been embedded). The
/// vault is re-scanned lazily when the last scan is older than 10 s.
#[tauri::command]
pub async fn cmd_search_query(
    state: State<'_, AppState>,
    q: String,
    kinds: Option<Vec<String>>,
    limit: usize,
    per_kind: Option<usize>,
    semantic: Option<bool>,
) -> Result<Vec<SearchHit>, String> {
    let kinds = parse_optional_kinds(kinds)?;
    let trimmed = q.trim().to_owned();
    let mut semantic_matches = Vec::new();
    if semantic.unwrap_or(false) && !trimmed.is_empty() && !trimmed.starts_with('#') {
        if state.vectors.dimension().is_none() {
            return Err(SEMANTIC_INDEX_MISSING.to_owned());
        }
        let embedding = state
            .ai
            .generate_embedding(&trimmed, &state.ai_config.embedding_model())
            .await
            .map_err(|e| format!("Semantic search is unavailable: {e}"))?;
        semantic_matches = state
            .vectors
            .search_similar(embedding, SEMANTIC_TOP_K)
            .await
            .map_err(map_err)?
            .into_iter()
            .map(|m| SemanticMatch {
                note_path: m.id,
                score: m.score,
                text: m.text,
            })
            .collect();
    }

    let search = state.search.clone();
    let vault = state.vault.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(root) = vault.detect_vault_path() {
            if let Err(e) = search.maybe_sync_vault(&vault, &root) {
                eprintln!("[AETHER] search: vault re-scan failed: {e}");
            }
        }
        search.query(&SearchRequest {
            query: trimmed,
            kinds,
            limit,
            per_kind,
            semantic: semantic_matches,
        })
    })
    .await
    .map_err(map_err)?
    .map_err(map_err)
}

/// Rebuild the index for `kinds` (all when omitted). Every note is
/// re-read; progress is emitted per kind as `search-index-progress`.
#[tauri::command]
pub async fn cmd_search_reindex(
    app: AppHandle,
    kinds: Option<Vec<String>>,
) -> Result<IndexReport, String> {
    let kinds = parse_optional_kinds(kinds)?.unwrap_or_default();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let report = run_reindex(&app, &state, &kinds, true);
        let _ = app.emit(INDEX_UPDATED_EVENT, &report);
        report
    })
    .await
    .map_err(map_err)?;
    Ok(report)
}

/// Installed applications (cached for five minutes).
#[tauri::command]
pub async fn cmd_search_apps(state: State<'_, AppState>) -> Result<Vec<AppEntry>, String> {
    let search = state.search.clone();
    tauri::async_runtime::spawn_blocking(move || search.apps(&default_app_roots(), false))
        .await
        .map_err(map_err)
}

/// Launch an application bundle. The path must be a `.app` inside one of
/// the application folders (paths from the UI are untrusted).
#[tauri::command]
pub async fn cmd_launch_app(path: String) -> Result<(), String> {
    let resolved = resolve_app_path(&path, &default_app_roots()).map_err(map_err)?;
    launch(&resolved)
}

#[cfg(target_os = "macos")]
fn launch(app: &Path) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .arg("-a")
        .arg(app)
        .status()
        .map_err(|e| format!("Failed to launch {}: {e}", app.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open exited with {status} for {}", app.display()))
    }
}

#[cfg(not(target_os = "macos"))]
fn launch(app: &Path) -> Result<(), String> {
    Err(format!(
        "Launching applications is only supported on macOS ({}).",
        app.display()
    ))
}

/// Remember that the user opened a result (drives Recents and frecency).
#[tauri::command]
pub async fn cmd_search_recents_record(
    state: State<'_, AppState>,
    id: String,
    kind: String,
    title: Option<String>,
) -> Result<(), String> {
    state
        .search
        .record_recent(&id, &kind, title)
        .map(|_| ())
        .map_err(map_err)
}

/// Recent results, most recent first (default 20, at most 50).
#[tauri::command]
pub async fn cmd_search_recents_list(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<RecentHit>, String> {
    let search = state.search.clone();
    let limit = limit.unwrap_or(20).clamp(1, 50);
    tauri::async_runtime::spawn_blocking(move || search.recent_hits(limit))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

/// Forget all recents.
#[tauri::command]
pub async fn cmd_search_recents_clear(state: State<'_, AppState>) -> Result<(), String> {
    state.search.clear_recents().map_err(map_err)
}

/// Current search settings.
#[tauri::command]
pub async fn cmd_search_get_settings(state: State<'_, AppState>) -> Result<SearchSettings, String> {
    Ok(state.search.settings())
}

/// Validate and save settings. Re-registers the global shortcut when it
/// changed and re-indexes the kinds affected by the change in the
/// background (newly enabled kinds, disabled kinds are purged, files when
/// the file index folders changed).
#[tauri::command]
pub async fn cmd_search_set_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: SearchSettings,
) -> Result<SearchSettings, String> {
    let previous = state.search.settings();
    let saved = state.search.set_settings(settings).map_err(map_err)?;
    let shortcut_changed = previous.global_shortcut_enabled != saved.global_shortcut_enabled
        || previous.global_shortcut != saved.global_shortcut
        || state.search.registered_shortcut().is_none();
    if shortcut_changed {
        apply_global_shortcut(&app, &state.search, &saved);
    }
    let mut affected: Vec<SearchKind> = SearchKind::all()
        .into_iter()
        .filter(|k| previous.includes(*k) != saved.includes(*k))
        .collect();
    if previous.file_roots != saved.file_roots && !affected.contains(&SearchKind::File) {
        affected.push(SearchKind::File);
    }
    if !affected.is_empty() {
        spawn_background_index(app.clone(), affected, false);
    }
    Ok(saved)
}

/// Document counts, last indexing run and global-shortcut state.
#[tauri::command]
pub async fn cmd_search_status(state: State<'_, AppState>) -> Result<SearchStatus, String> {
    state.search.status().map_err(map_err)
}

#[cfg(test)]
mod tests {
    use super::read_project_dirs;

    #[test]
    fn project_dirs_are_read_from_the_projects_config() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(
            read_project_dirs(dir.path()).is_empty(),
            "missing file → no dirs"
        );
        std::fs::write(
            dir.path().join("project_dirs.json"),
            r#"{"directories":["/a","/b"]}"#,
        )
        .expect("write");
        let dirs = read_project_dirs(dir.path());
        assert_eq!(
            dirs,
            vec![
                std::path::PathBuf::from("/a"),
                std::path::PathBuf::from("/b")
            ]
        );
        std::fs::write(dir.path().join("project_dirs.json"), "broken").expect("write");
        assert!(
            read_project_dirs(dir.path()).is_empty(),
            "invalid file → no dirs"
        );
    }
}
