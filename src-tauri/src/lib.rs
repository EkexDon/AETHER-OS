mod commands;
mod engine;

use std::sync::Arc;

use commands::browser_commands::BrowserWebviews;
use engine::{
    aether_notes::AetherNotes, ai_config::AiConfigStore, browser::BrowserManager,
    cloud_ai::CloudAiEngine, local_ai::LocalAiEngine, lsp::LspManager, memory_store::MemoryStore,
    system_monitor::SystemMonitor, terminal::TerminalManager, vault_reader::VaultReader,
    vector_db::VectorEngine, web_clipper::WebClipper,
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
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
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
            commands::lsp_commands::cmd_lsp_start,
            commands::lsp_commands::cmd_lsp_send,
            commands::lsp_commands::cmd_lsp_stop,
            commands::lsp_commands::cmd_lsp_stop_all,
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
