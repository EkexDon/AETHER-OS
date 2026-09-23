mod commands;
mod engine;

use std::sync::Arc;

use commands::browser_commands::BrowserWebviews;
use engine::{
    aether_notes::AetherNotes, ai_config::AiConfigStore, browser::BrowserManager,
    calendar::Calendar, calendar_notifier::CalendarNotifier, cloud_ai::CloudAiEngine,
    diagnostics::Diagnostics, local_ai::LocalAiEngine, lsp::LspManager, memory_store::MemoryStore,
    system_monitor::SystemMonitor, task_board::TaskBoardEngine, terminal::TerminalManager,
    vault_reader::VaultReader, vector_db::VectorEngine, web_clipper::WebClipper,
};
use tauri::Manager;

pub struct AppState {
    pub vault: Arc<VaultReader>,
    pub vectors: Arc<VectorEngine>,
    /// Local Ollama client.
    pub ai: Arc<LocalAiEngine>,
    /// Cloud client (OpenRouter).
    pub cloud_ai: Arc<CloudAiEngine>,
    /// AI provider settings (API keys), stored app-side only.
    pub ai_config: Arc<AiConfigStore>,
    pub aether_notes: Arc<AetherNotes>,
    pub memory: Arc<MemoryStore>,
    pub terminal: Arc<TerminalManager>,
    pub system_monitor: Arc<SystemMonitor>,
    pub browser: Arc<BrowserManager>,
    pub browser_webviews: Arc<BrowserWebviews>,
    pub clipper: Arc<WebClipper>,
    pub lsp: Arc<LspManager>,
    /// Handle for emitting LSP messages to the webview.
    pub lsp_app: tauri::AppHandle,
    pub calendar: Arc<Calendar>,
    pub notifier: Arc<CalendarNotifier>,
    pub task_board: Arc<TaskBoardEngine>,
    /// Local crash reports + application log (installs the panic hook).
    pub diagnostics: Arc<Diagnostics>,
    // Feature state (SWARM-CONTRACT §3): add `pub <feature>: Arc<…>,`
    // directly above your own anchor.
    pub clipboard: Arc<engine::clipboard::ClipboardEngine>,
    // @anchor:state-field:clipboard
    /// Launcher + Universal Search index (`engine/search_index.rs`).
    pub search: Arc<engine::search_index::SearchIndex>,
    // @anchor:state-field:search
    pub history: Arc<engine::note_history::NoteHistory>,
    // @anchor:state-field:history
    pub focus_log: Arc<engine::focus_log::FocusLog>,
    // @anchor:state-field:home
    /// Checkbox tasks aggregated from all notes (mtime-cached).
    pub vaulttasks: Arc<engine::vault_tasks::VaultTasksEngine>,
    // @anchor:state-field:vaulttasks
    /// Compaction, suggestions, agent approvals + audit log (`intel`).
    pub intel: Arc<engine::intel::IntelEngine>,
    // @anchor:state-field:intel
    /// Installed plugins, their state, settings and storage.
    pub plugins: Arc<engine::plugins::PluginManager>,
    // @anchor:state-field:plugins
    /// Export & publishing: recent exports, safe "open" targets.
    pub export: Arc<engine::export::ExportEngine>,
    // @anchor:state-field:export
    /// Encrypted backup & folder sync (`sync`).
    pub sync: Arc<engine::sync::SyncEngine>,
    // @anchor:state-field:sync
    /// First-run wizard state, vault prefs and Ollama model pulls.
    pub onboarding: Arc<engine::onboarding::OnboardingEngine>,
    // @anchor:state-field:onboarding
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            // First, so panics in any later engine start-up are captured.
            let diagnostics = Arc::new(Diagnostics::new(&data_dir)?);
            let vault = VaultReader::new(&data_dir)?;
            let vectors =
                tauri::async_runtime::block_on(VectorEngine::new(&data_dir.join("vectors")))?;
            let ai = LocalAiEngine::new()?;
            let cloud_ai = CloudAiEngine::new()?;
            let aether_notes = AetherNotes::new(&data_dir.join("aether"))?;
            let memory = MemoryStore::new(&data_dir.join("memory"))?;
            let terminal = TerminalManager::new();
            let system_monitor = SystemMonitor::new();
            let browser = BrowserManager::new();
            let calendar = Arc::new(Calendar::new(&data_dir.join("calendar"))?);
            let notifier = Arc::new(CalendarNotifier::new(
                &app.handle().clone(),
                &data_dir.join("calendar"),
            )?);
            notifier.clone().start(calendar.clone())?;
            let task_board = Arc::new(TaskBoardEngine::new(&data_dir.join("tasks"))?);
            // Feature engine construction: add your `let <feature> = …;`
            // directly above your own anchor.
            let clipboard = engine::clipboard::ClipboardEngine::launch(&data_dir, app.handle())?;
            // @anchor:state-init:clipboard
            let search = commands::search_commands::init(app, &data_dir)?;
            // @anchor:state-init:search
            let history = commands::history_commands::start_note_history(app.handle(), &data_dir)?;
            // @anchor:state-init:history
            let focus_log = Arc::new(engine::focus_log::FocusLog::new(&data_dir.join("focus"))?);
            // @anchor:state-init:home
            let vaulttasks_dir = data_dir.join("vaulttasks");
            let vaulttasks = Arc::new(engine::vault_tasks::VaultTasksEngine::new(&vaulttasks_dir)?);
            // @anchor:state-init:vaulttasks
            let intel = Arc::new(engine::intel::IntelEngine::new(
                &data_dir.join("intel"),
                &data_dir.join("memory"),
            )?);
            // @anchor:state-init:intel
            let plugins = Arc::new(engine::plugins::PluginManager::new(
                &data_dir.join("plugins"),
            )?);
            // @anchor:state-init:plugins
            let export = Arc::new(engine::export::ExportEngine::new(&data_dir.join("export"))?);
            // @anchor:state-init:export
            let sync = commands::sync_commands::init_sync(app.handle(), &data_dir)?;
            // @anchor:state-init:sync
            let onboarding = Arc::new(engine::onboarding::OnboardingEngine::new(&data_dir)?);
            // @anchor:state-init:onboarding
            app.manage(AppState {
                vault: Arc::new(vault),
                vectors: Arc::new(vectors),
                ai: Arc::new(ai),
                cloud_ai: Arc::new(cloud_ai),
                ai_config: Arc::new(AiConfigStore::new(&data_dir.join("ai"))?),
                aether_notes: Arc::new(aether_notes),
                memory: Arc::new(memory),
                terminal: Arc::new(terminal),
                system_monitor: Arc::new(system_monitor),
                browser: Arc::new(browser),
                browser_webviews: Arc::new(BrowserWebviews::new()),
                clipper: Arc::new(WebClipper::new()),
                lsp: Arc::new(LspManager::new()),
                lsp_app: app.handle().clone(),
                calendar,
                notifier,
                task_board,
                diagnostics,
                // Feature fields: add `<feature>,` directly above your anchor.
                clipboard,
                // @anchor:state-manage:clipboard
                search,
                // @anchor:state-manage:search
                history,
                // @anchor:state-manage:history
                focus_log,
                // @anchor:state-manage:home
                vaulttasks,
                // @anchor:state-manage:vaulttasks
                intel,
                // @anchor:state-manage:intel
                plugins,
                // @anchor:state-manage:plugins
                export,
                // @anchor:state-manage:export
                sync,
                // @anchor:state-manage:sync
                onboarding,
                // @anchor:state-manage:onboarding
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_commands::cmd_get_vault_path,
            commands::vault_commands::cmd_set_vault_path,
            commands::vault_commands::cmd_get_vault_notes,
            commands::vault_commands::cmd_get_note_content,
            commands::vault_commands::cmd_get_vault_index,
            commands::vault_commands::cmd_get_vault_graph,
            commands::vault_commands::cmd_get_vault_stats,
            commands::ai_commands::cmd_index_vault,
            commands::ai_commands::cmd_semantic_search,
            commands::ai_commands::cmd_agent_query,
            commands::ai_commands::cmd_agent_query_with_notes,
            commands::ai_commands::cmd_set_openrouter_key,
            commands::ai_commands::cmd_list_cloud_models,
            commands::ai_commands::cmd_list_local_models,
            commands::ai_commands::cmd_get_health,
            commands::aether_note_commands::cmd_create_aether_note,
            commands::aether_note_commands::cmd_get_aether_notes,
            commands::aether_note_commands::cmd_delete_aether_note,
            commands::project_commands::cmd_scan_projects,
            commands::project_commands::cmd_open_project,
            commands::project_commands::cmd_open_in_terminal,
            commands::project_commands::cmd_open_in_finder,
            commands::project_commands::cmd_get_project_dirs,
            commands::project_commands::cmd_add_project_dir,
            commands::project_commands::cmd_remove_project_dir,
            commands::memory_commands::cmd_save_conversation,
            commands::memory_commands::cmd_get_recent_conversations,
            commands::memory_commands::cmd_delete_conversation,
            commands::memory_commands::cmd_save_memory_fact,
            commands::memory_commands::cmd_get_memory_facts,
            commands::memory_commands::cmd_delete_memory_fact,
            commands::terminal_commands::cmd_terminal_spawn,
            commands::terminal_commands::cmd_terminal_write,
            commands::terminal_commands::cmd_terminal_resize,
            commands::terminal_commands::cmd_terminal_kill,
            commands::terminal_commands::cmd_terminal_list,
            commands::system_commands::cmd_get_system_metrics,
            commands::browser_commands::cmd_browser_info,
            commands::browser_commands::cmd_browser_open,
            commands::browser_commands::cmd_browser_open_librewolf,
            commands::browser_commands::cmd_browser_webview_open,
            commands::browser_commands::cmd_browser_webview_close,
            commands::browser_commands::cmd_browser_webview_navigate,
            commands::browser_commands::cmd_browser_webview_back,
            commands::browser_commands::cmd_browser_webview_forward,
            commands::browser_commands::cmd_browser_webview_reload,
            commands::browser_commands::cmd_browser_webview_list,
            commands::browser_commands::cmd_browser_webview_set_bounds,
            commands::browser_commands::cmd_browser_webview_show,
            commands::browser_commands::cmd_browser_webview_hide,
            commands::browser_commands::cmd_browser_webview_hide_all,
            commands::note_commands::cmd_write_note,
            commands::note_commands::cmd_create_note,
            commands::note_commands::cmd_append_note,
            commands::note_commands::cmd_get_backlinks,
            commands::note_commands::cmd_daily_note,
            commands::note_commands::cmd_append_daily,
            commands::note_commands::cmd_clip_url,
            commands::note_commands::cmd_execute_agent_action,
            commands::agent_action_commands::cmd_agent_open_url,
            commands::agent_action_commands::cmd_agent_clip_url,
            commands::agent_action_commands::cmd_agent_add_memory_fact,
            commands::agent_action_commands::cmd_agent_save_aether_note,
            commands::ide_commands::cmd_ide_roots,
            commands::ide_commands::cmd_ide_list_dir,
            commands::ide_commands::cmd_ide_read_file,
            commands::ide_commands::cmd_ide_write_file,
            commands::ide_commands::cmd_ide_create_file,
            commands::ide_commands::cmd_ide_create_dir,
            commands::git_commands::cmd_git_status,
            commands::git_commands::cmd_git_stage,
            commands::git_commands::cmd_git_unstage,
            commands::git_commands::cmd_git_discard,
            commands::git_commands::cmd_git_commit,
            commands::git_commands::cmd_git_branches,
            commands::git_commands::cmd_git_switch_branch,
            commands::git_commands::cmd_git_create_branch,
            commands::git_commands::cmd_git_log,
            commands::git_commands::cmd_git_diff_file,
            commands::calendar_commands::cmd_list_calendar_events,
            commands::calendar_commands::cmd_get_calendar_event,
            commands::calendar_commands::cmd_create_calendar_event,
            commands::calendar_commands::cmd_update_calendar_event,
            commands::calendar_commands::cmd_delete_calendar_event,
            commands::calendar_commands::cmd_export_calendar_ics,
            commands::calendar_commands::cmd_import_calendar_ics,
            commands::calendar_commands::cmd_write_ics_to_path,
            commands::calendar_commands::cmd_read_ics_from_path,
            commands::calendar_commands::cmd_get_reminder_settings,
            commands::calendar_commands::cmd_set_reminder_settings,
            commands::calendar_commands::cmd_request_notification_permission,
            commands::lsp_commands::cmd_lsp_start,
            commands::lsp_commands::cmd_lsp_send,
            commands::lsp_commands::cmd_lsp_stop,
            commands::lsp_commands::cmd_lsp_stop_all,
            commands::task_commands::cmd_list_task_projects,
            commands::task_commands::cmd_get_task_project,
            commands::task_commands::cmd_create_task_project,
            commands::task_commands::cmd_update_task_project,
            commands::task_commands::cmd_delete_task_project,
            commands::task_commands::cmd_list_tasks,
            commands::task_commands::cmd_get_task,
            commands::task_commands::cmd_create_task,
            commands::task_commands::cmd_update_task,
            commands::task_commands::cmd_delete_task,
            commands::diagnostics_commands::cmd_list_crash_reports,
            commands::diagnostics_commands::cmd_read_crash_report,
            commands::diagnostics_commands::cmd_clear_crash_reports,
            commands::diagnostics_commands::cmd_log_frontend_error,
            commands::diagnostics_commands::cmd_open_app_data_dir,
            commands::diagnostics_commands::cmd_get_app_info,
            commands::updater_commands::cmd_check_for_updates,
            // Feature commands: add `commands::<feature>_commands::cmd_…,`
            // lines directly above your own anchor.
            commands::clipboard_commands::cmd_clipboard_list,
            commands::clipboard_commands::cmd_clipboard_get,
            commands::clipboard_commands::cmd_clipboard_copy,
            commands::clipboard_commands::cmd_clipboard_pin,
            commands::clipboard_commands::cmd_clipboard_delete,
            commands::clipboard_commands::cmd_clipboard_clear,
            commands::clipboard_commands::cmd_clipboard_get_settings,
            commands::clipboard_commands::cmd_clipboard_set_settings,
            commands::clipboard_commands::cmd_clipboard_set_paused,
            commands::clipboard_commands::cmd_clipboard_stats,
            commands::clipboard_commands::cmd_clipboard_save_as_note,
            commands::clipboard_commands::cmd_clipboard_image,
            commands::clipboard_commands::cmd_clipboard_copy_latest,
            // @anchor:handlers:clipboard
            commands::search_commands::cmd_search_query,
            commands::search_commands::cmd_search_reindex,
            commands::search_commands::cmd_search_apps,
            commands::search_commands::cmd_launch_app,
            commands::search_commands::cmd_search_recents_record,
            commands::search_commands::cmd_search_recents_list,
            commands::search_commands::cmd_search_recents_clear,
            commands::search_commands::cmd_search_get_settings,
            commands::search_commands::cmd_search_set_settings,
            commands::search_commands::cmd_search_status,
            // @anchor:handlers:search
            commands::history_commands::cmd_history_status,
            commands::history_commands::cmd_history_list,
            commands::history_commands::cmd_history_read,
            commands::history_commands::cmd_history_diff,
            commands::history_commands::cmd_history_restore,
            commands::history_commands::cmd_history_recent,
            commands::history_commands::cmd_history_set_enabled,
            commands::history_commands::cmd_history_commit_now,
            // @anchor:handlers:history
            commands::home_commands::cmd_focus_log_session,
            commands::home_commands::cmd_focus_stats,
            commands::home_commands::cmd_focus_list,
            // @anchor:handlers:home
            commands::vaulttasks_commands::cmd_vault_tasks_list,
            commands::vaulttasks_commands::cmd_vault_tasks_toggle,
            commands::vaulttasks_commands::cmd_vault_tasks_set_status,
            commands::vaulttasks_commands::cmd_vault_tasks_set_due,
            commands::vaulttasks_commands::cmd_vault_tasks_set_priority,
            commands::vaulttasks_commands::cmd_vault_tasks_append,
            commands::vaulttasks_commands::cmd_vault_tasks_stats,
            commands::vaulttasks_commands::cmd_vault_tasks_rescan,
            // @anchor:handlers:vaulttasks
            commands::intel_commands::cmd_intel_get_settings,
            commands::intel_commands::cmd_intel_set_settings,
            commands::intel_commands::cmd_intel_compact,
            commands::intel_commands::cmd_intel_save_conversation,
            commands::intel_commands::cmd_intel_suggest_related,
            commands::intel_commands::cmd_intel_suggest_tags,
            commands::intel_commands::cmd_intel_add_tag,
            commands::intel_commands::cmd_intel_run_command,
            commands::intel_commands::cmd_intel_delete_note,
            commands::intel_commands::cmd_intel_move_note,
            commands::intel_commands::cmd_intel_git_commit,
            commands::intel_commands::cmd_intel_create_task,
            commands::intel_commands::cmd_intel_toggle_vault_task,
            commands::intel_commands::cmd_intel_preview_action,
            commands::intel_commands::cmd_intel_audit_list,
            commands::intel_commands::cmd_intel_audit_record,
            commands::intel_commands::cmd_intel_audit_clear,
            // @anchor:handlers:intel
            commands::plugins_commands::cmd_plugins_list,
            commands::plugins_commands::cmd_plugins_install_examples,
            commands::plugins_commands::cmd_plugins_read_source,
            commands::plugins_commands::cmd_plugins_set_enabled,
            commands::plugins_commands::cmd_plugins_set_permissions,
            commands::plugins_commands::cmd_plugins_install_from_path,
            commands::plugins_commands::cmd_plugins_uninstall,
            commands::plugins_commands::cmd_plugins_get_settings,
            commands::plugins_commands::cmd_plugins_set_settings,
            commands::plugins_commands::cmd_plugins_storage_get,
            commands::plugins_commands::cmd_plugins_storage_set,
            commands::plugins_commands::cmd_plugins_open_folder,
            commands::plugins_commands::cmd_plugins_vault_list,
            commands::plugins_commands::cmd_plugins_vault_read,
            commands::plugins_commands::cmd_plugins_vault_write,
            commands::plugins_commands::cmd_plugins_note_create,
            commands::plugins_commands::cmd_plugins_fetch,
            // @anchor:handlers:plugins
            commands::export_commands::cmd_export_preview_html,
            commands::export_commands::cmd_export_preview_markdown,
            commands::export_commands::cmd_export_note_html,
            commands::export_commands::cmd_export_print_document,
            commands::export_commands::cmd_export_site,
            commands::export_commands::cmd_export_bundle,
            commands::export_commands::cmd_export_open_path,
            commands::export_commands::cmd_export_list_recent,
            commands::export_commands::cmd_export_clear_recent,
            commands::export_commands::cmd_export_resolve_scope,
            commands::export_commands::cmd_export_list_tags,
            // @anchor:handlers:export
            commands::sync_commands::cmd_sync_get_settings,
            commands::sync_commands::cmd_sync_set_settings,
            commands::sync_commands::cmd_sync_inspect_folder,
            commands::sync_commands::cmd_sync_unlock,
            commands::sync_commands::cmd_sync_lock,
            commands::sync_commands::cmd_sync_now,
            commands::sync_commands::cmd_sync_status,
            commands::sync_commands::cmd_sync_list_conflicts,
            commands::sync_commands::cmd_sync_get_conflict,
            commands::sync_commands::cmd_sync_resolve_conflict,
            commands::sync_commands::cmd_sync_change_passphrase,
            commands::sync_commands::cmd_sync_devices,
            commands::sync_commands::cmd_sync_backup_create,
            commands::sync_commands::cmd_sync_backup_list,
            commands::sync_commands::cmd_sync_backup_verify,
            commands::sync_commands::cmd_sync_backup_preview,
            commands::sync_commands::cmd_sync_backup_restore,
            // @anchor:handlers:sync
            commands::onboarding_commands::cmd_onboarding_get_state,
            commands::onboarding_commands::cmd_onboarding_set_state,
            commands::onboarding_commands::cmd_onboarding_create_vault,
            commands::onboarding_commands::cmd_onboarding_detect_vaults,
            commands::onboarding_commands::cmd_onboarding_suggest_vault_path,
            commands::onboarding_commands::cmd_onboarding_system_profile,
            commands::onboarding_commands::cmd_onboarding_pull_model,
            commands::onboarding_commands::cmd_onboarding_cancel_pull,
            commands::onboarding_commands::cmd_onboarding_get_vault_prefs,
            commands::onboarding_commands::cmd_onboarding_set_vault_prefs,
            commands::onboarding_commands::cmd_onboarding_reveal_vault,
            commands::onboarding_commands::cmd_onboarding_data_locations,
            commands::onboarding_commands::cmd_onboarding_read_app_log,
            commands::onboarding_commands::cmd_onboarding_read_changelog,
            commands::onboarding_commands::cmd_onboarding_reset_app_data,
            // @anchor:handlers:onboarding
        ])
        .build(tauri::generate_context!())
        .expect("failed to build AETHER-OS")
        .run(|app_handle, event| {
            // Language servers are child processes; without this they would
            // outlive the app and hold ports/files until killed manually.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app_handle.state::<AppState>().lsp.stop_all();
            }
        });
}
