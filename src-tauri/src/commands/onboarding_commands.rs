//! Tauri commands for the first-run wizard and the Settings sections of the
//! `onboarding` feature. See `engine/onboarding.rs`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::engine::diagnostics::open_in_file_manager;
use crate::engine::onboarding::{
    create_starter_vault, data_locations, default_scan_roots, detect_vaults, pull_model_at,
    read_log_tail, reset_app_data, resolve_new_vault_path, suggest_vault_path, system_profile,
    AppLogTail, DataLocation, OnboardingState, PullOutcome, ResetOutcome, SystemProfile, VaultInfo,
    VaultPrefs, CHANGELOG, OLLAMA_ENDPOINT, PULL_PROGRESS_EVENT,
};
use crate::AppState;

/// Delay between answering a reset and restarting, so the webview can show
/// the result before it goes away.
const RESTART_DELAY: Duration = Duration::from_millis(1500);

fn home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map_err(|e| format!("cannot find your home folder: {e}"))
}

/// The persisted wizard state (`completed_at: null` on first run).
#[tauri::command]
pub async fn cmd_onboarding_get_state(
    state: State<'_, AppState>,
) -> Result<OnboardingState, String> {
    state.onboarding.get_state().map_err(|e| e.to_string())
}

/// Validate and persist the wizard state; returns what was stored.
#[tauri::command]
pub async fn cmd_onboarding_set_state(
    state: State<'_, AppState>,
    onboarding: OnboardingState,
) -> Result<OnboardingState, String> {
    state
        .onboarding
        .set_state(onboarding)
        .map_err(|e| e.to_string())
}

/// Create a starter vault at `path` (inside the home folder, new or empty).
/// Does not connect it; call `cmd_set_vault_path` afterwards.
#[tauri::command]
pub async fn cmd_onboarding_create_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<VaultInfo, String> {
    let home = home_dir(&app)?;
    let target = resolve_new_vault_path(&path, &home).map_err(|e| e.to_string())?;
    let prefs = state
        .onboarding
        .get_vault_prefs()
        .map_err(|e| e.to_string())?;
    let today = chrono::Local::now().date_naive();
    tauri::async_runtime::spawn_blocking(move || create_starter_vault(&target, &prefs, today))
        .await
        .map_err(|e| format!("vault creation was interrupted: {e}"))?
        .map_err(|e| e.to_string())
}

/// Existing Obsidian / NoPes / plain Markdown vaults under `~/Documents`
/// and `~` (depth 2) and Obsidian's iCloud folder.
#[tauri::command]
pub async fn cmd_onboarding_detect_vaults(app: AppHandle) -> Result<Vec<VaultInfo>, String> {
    let roots = default_scan_roots(&home_dir(&app)?);
    tauri::async_runtime::spawn_blocking(move || detect_vaults(&roots))
        .await
        .map_err(|e| format!("vault detection was interrupted: {e}"))
}

/// A free default location for a new vault (`~/Documents/AETHER Vault`).
#[tauri::command]
pub async fn cmd_onboarding_suggest_vault_path(app: AppHandle) -> Result<String, String> {
    Ok(suggest_vault_path(&home_dir(&app)?)
        .to_string_lossy()
        .to_string())
}

/// RAM, cores and architecture for the model recommendation.
#[tauri::command]
pub async fn cmd_onboarding_system_profile() -> Result<SystemProfile, String> {
    tauri::async_runtime::spawn_blocking(system_profile)
        .await
        .map_err(|e| format!("could not read the system profile: {e}"))
}

/// Download a model with the local Ollama. Progress streams as
/// `ollama-pull-progress { name, status, completed, total }` events; the
/// command resolves when the download finished or was cancelled.
#[tauri::command]
pub async fn cmd_onboarding_pull_model(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<PullOutcome, String> {
    let registration = state
        .onboarding
        .begin_pull(&name)
        .map_err(|e| e.to_string())?;
    pull_model_at(
        OLLAMA_ENDPOINT,
        &name,
        registration.cancel_flag(),
        |progress| {
            // A closed webview must not abort the download.
            let _ = app.emit(PULL_PROGRESS_EVENT, &progress);
        },
    )
    .await
    .map_err(|e| e.to_string())
}

/// Stop a running download. Returns whether one was running.
#[tauri::command]
pub async fn cmd_onboarding_cancel_pull(
    state: State<'_, AppState>,
    name: String,
) -> Result<bool, String> {
    Ok(state.onboarding.cancel_pull(&name))
}

/// Daily-note folder and filename pattern (used for the starter vault).
#[tauri::command]
pub async fn cmd_onboarding_get_vault_prefs(
    state: State<'_, AppState>,
) -> Result<VaultPrefs, String> {
    state
        .onboarding
        .get_vault_prefs()
        .map_err(|e| e.to_string())
}

/// Validate and store the vault preferences; returns what was stored.
#[tauri::command]
pub async fn cmd_onboarding_set_vault_prefs(
    state: State<'_, AppState>,
    prefs: VaultPrefs,
) -> Result<VaultPrefs, String> {
    state
        .onboarding
        .set_vault_prefs(prefs)
        .map_err(|e| e.to_string())
}

/// Reveal the connected vault in Finder / Explorer / the file manager.
#[tauri::command]
pub async fn cmd_onboarding_reveal_vault(state: State<'_, AppState>) -> Result<(), String> {
    let vault = state
        .vault
        .detect_vault_path()
        .ok_or_else(|| "No vault is connected.".to_owned())?;
    open_in_file_manager(Path::new(&vault)).map_err(|e| e.to_string())
}

/// Top-level files and folders of the app data directory with sizes.
#[tauri::command]
pub async fn cmd_onboarding_data_locations(
    state: State<'_, AppState>,
) -> Result<Vec<DataLocation>, String> {
    let dir = state.onboarding.data_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || data_locations(&dir))
        .await
        .map_err(|e| format!("could not list the data folder: {e}"))?
        .map_err(|e| e.to_string())
}

/// The last `max_bytes` of `logs/aether.log` (whole lines).
#[tauri::command]
pub async fn cmd_onboarding_read_app_log(
    state: State<'_, AppState>,
    max_bytes: u64,
) -> Result<AppLogTail, String> {
    read_log_tail(state.onboarding.data_dir(), max_bytes).map_err(|e| e.to_string())
}

/// The changelog bundled with this build (Markdown).
#[tauri::command]
pub async fn cmd_onboarding_read_changelog() -> Result<String, String> {
    Ok(CHANGELOG.to_owned())
}

/// Move the app data directory aside as a dated backup and restart with a
/// fresh one. With `keep_vault` the vault connection survives. The vault
/// folder itself is never touched.
#[tauri::command]
pub async fn cmd_onboarding_reset_app_data(
    app: AppHandle,
    state: State<'_, AppState>,
    keep_vault: bool,
) -> Result<ResetOutcome, String> {
    let (backup, kept) = reset_app_data(
        state.onboarding.data_dir(),
        keep_vault,
        chrono::Local::now(),
    )
    .map_err(|e| e.to_string())?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RESTART_DELAY).await;
        handle.request_restart();
    });
    Ok(ResetOutcome {
        backup_path: backup.to_string_lossy().to_string(),
        kept,
        restarting: true,
    })
}
