pub mod aether_notes;
pub mod agent_actions;
pub mod browser;
pub mod calendar;
pub mod calendar_ics;
pub mod calendar_notifier;
pub mod error;
pub mod git_repo;
pub mod local_ai;
pub mod lsp;
pub mod memory_store;
pub mod system_monitor;
pub mod terminal;
pub mod vault_reader;
pub mod vector_db;
pub mod web_clipper;
pub mod workspace;

pub mod ai_config;
pub mod cloud_ai;
pub mod task_board;

// Wave 1 infra: shared helpers.
pub mod diagnostics;
pub mod sqlite;
pub mod updater;

// Feature engines (SWARM-CONTRACT §3): add `pub mod <feature>;` directly
// above your own anchor. Never reorder or remove anchors.
pub mod clipboard;
// @anchor:engine:clipboard
pub mod search_index;
// @anchor:engine:search
pub mod note_history;
// @anchor:engine:history
pub mod focus_log;
// @anchor:engine:home
pub mod vault_tasks;
// @anchor:engine:vaulttasks
pub mod intel;
// @anchor:engine:intel
pub mod plugins;
// @anchor:engine:plugins
pub mod export;
// @anchor:engine:export
pub mod sync;
// @anchor:engine:sync
pub mod onboarding;
// @anchor:engine:onboarding
