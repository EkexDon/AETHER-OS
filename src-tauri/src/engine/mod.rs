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
// @anchor:engine:clipboard
// @anchor:engine:search
// @anchor:engine:history
// @anchor:engine:home
// @anchor:engine:vaulttasks
// @anchor:engine:intel
// @anchor:engine:plugins
// @anchor:engine:export
// @anchor:engine:sync
// @anchor:engine:onboarding
