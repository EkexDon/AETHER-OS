pub mod aether_note_commands;
pub mod agent_action_commands;
pub mod ai_commands;
pub mod browser_commands;
pub mod calendar_commands;
pub mod git_commands;
pub mod ide_commands;
pub mod lsp_commands;
pub mod memory_commands;
pub mod note_commands;
pub mod project_commands;
pub mod system_commands;
pub mod task_commands;
pub mod terminal_commands;
pub mod vault_commands;

// Wave 1 infra.
pub mod diagnostics_commands;
pub mod updater_commands;

// Wave 3 integration: app lifecycle (quit confirmation, shutdown).
pub mod app_commands;

// Feature commands (SWARM-CONTRACT §3): add `pub mod <feature>_commands;`
// directly above your own anchor. Never reorder or remove anchors.
pub mod clipboard_commands;
// @anchor:commands:clipboard
pub mod search_commands;
// @anchor:commands:search
pub mod history_commands;
// @anchor:commands:history
pub mod home_commands;
// @anchor:commands:home
pub mod vaulttasks_commands;
// @anchor:commands:vaulttasks
pub mod intel_commands;
// @anchor:commands:intel
pub mod plugins_commands;
// @anchor:commands:plugins
pub mod export_commands;
// @anchor:commands:export
pub mod sync_commands;
// @anchor:commands:sync
pub mod onboarding_commands;
// @anchor:commands:onboarding
