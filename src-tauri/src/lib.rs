mod commands;
mod engine;

use std::sync::Arc;

use engine::{
    aether_notes::AetherNotes, local_ai::LocalAiEngine, memory_store::MemoryStore,
    terminal::TerminalManager, vault_reader::VaultReader, vector_db::VectorEngine,
};
use tauri::Manager;

pub struct AppState {
    pub vault: Arc<VaultReader>,
    pub vectors: Arc<VectorEngine>,
    pub ai: Arc<LocalAiEngine>,
    pub aether_notes: Arc<AetherNotes>,
    pub memory: Arc<MemoryStore>,
    pub terminal: Arc<TerminalManager>,
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
            let aether_notes = AetherNotes::new(&data_dir.join("aether"))?;
            let memory = MemoryStore::new(&data_dir.join("memory"))?;
            let terminal = TerminalManager::new();
            app.manage(AppState {
                vault: Arc::new(vault),
                vectors: Arc::new(vectors),
                ai: Arc::new(ai),
                aether_notes: Arc::new(aether_notes),
                memory: Arc::new(memory),
                terminal: Arc::new(terminal),
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AETHER-OS");
}
