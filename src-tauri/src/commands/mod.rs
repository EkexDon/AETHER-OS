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

// Feature commands (SWARM-CONTRACT §3): add `pub mod <feature>_commands;`
// directly above your own anchor. Never reorder or remove anchors.
// @anchor:commands:clipboard
// @anchor:commands:search
// @anchor:commands:history
// @anchor:commands:home
// @anchor:commands:vaulttasks
// @anchor:commands:intel
// @anchor:commands:plugins
// @anchor:commands:export
// @anchor:commands:sync
// @anchor:commands:onboarding
