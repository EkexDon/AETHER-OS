//! `intel` — the AI intelligence layer.
//!
//! Three capabilities share this engine:
//!
//! - **Conversation compaction** ([`compaction`]): token estimates, a strict
//!   summarisation prompt, validation of the model output and an extractive
//!   fallback, plus the conversation archive that stores the summary in the
//!   memory store's `summary` field.
//! - **Related-note suggestions** ([`suggestions`]): a tf-idf-lite keyword
//!   scorer used when the vector index is empty or Ollama is offline, tag
//!   ranking by keyword co-occurrence and frontmatter-aware tag insertion.
//! - **Approval-gated agent actions** ([`approvals`], [`shell_exec`]): vault
//!   note operations that never hard-delete, shell execution inside allowed
//!   roots with a timeout, and the append-only audit log.
//!
//! State lives under `<app_data>/intel/`: `settings.json` and `audit.jsonl`.

pub mod approvals;
pub mod compaction;
pub mod shell_exec;
pub mod suggestions;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

const SETTINGS_FILE: &str = "settings.json";
const AUDIT_FILE: &str = "audit.jsonl";

/// Smallest accepted compaction threshold (tokens).
pub const MIN_THRESHOLD_TOKENS: u32 = 1_000;
/// Largest accepted compaction threshold (tokens).
pub const MAX_THRESHOLD_TOKENS: u32 = 64_000;
/// Smallest / largest number of recent messages kept verbatim.
pub const KEEP_RECENT_RANGE: (u32, u32) = (2, 20);
/// Smallest / largest shell command timeout in seconds.
pub const TIMEOUT_RANGE_SECS: (u32, u32) = (5, 300);

/// User-tunable settings of the intelligence layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct IntelSettings {
    /// Compact the chat automatically once it exceeds the threshold.
    pub auto_compact: bool,
    /// Estimated tokens after which the conversation is compacted.
    pub compact_threshold_tokens: u32,
    /// Most recent messages kept verbatim when compacting.
    pub keep_recent_messages: u32,
    /// Compute related-note suggestions while writing.
    pub related_suggestions: bool,
    /// Let the current model re-rank tag suggestions.
    pub llm_tag_suggestions: bool,
    /// Timeout for agent `run_command` actions.
    pub command_timeout_secs: u32,
}

impl Default for IntelSettings {
    fn default() -> Self {
        Self {
            auto_compact: true,
            compact_threshold_tokens: compaction::DEFAULT_THRESHOLD_TOKENS as u32,
            keep_recent_messages: compaction::DEFAULT_KEEP_RECENT as u32,
            related_suggestions: true,
            llm_tag_suggestions: false,
            command_timeout_secs: shell_exec::DEFAULT_TIMEOUT_SECS as u32,
        }
    }
}

impl IntelSettings {
    /// Clamp every numeric field into its supported range.
    pub fn normalized(mut self) -> Self {
        self.compact_threshold_tokens = self
            .compact_threshold_tokens
            .clamp(MIN_THRESHOLD_TOKENS, MAX_THRESHOLD_TOKENS);
        self.keep_recent_messages = self
            .keep_recent_messages
            .clamp(KEEP_RECENT_RANGE.0, KEEP_RECENT_RANGE.1);
        self.command_timeout_secs = self
            .command_timeout_secs
            .clamp(TIMEOUT_RANGE_SECS.0, TIMEOUT_RANGE_SECS.1);
        self
    }
}

/// Engine state shared by the `cmd_intel_*` commands.
pub struct IntelEngine {
    root: PathBuf,
    conversations_dir: PathBuf,
    settings: Mutex<IntelSettings>,
    audit: approvals::AuditLog,
    doc_cache: Mutex<suggestions::DocCache>,
}

impl IntelEngine {
    /// Open (or create) the engine under `root`. `memory_root` is the memory
    /// store's directory; compacted conversations are written to its
    /// `conversations/` folder in the same format `MemoryStore` reads.
    pub fn new(root: &Path, memory_root: &Path) -> Result<Self, AetherError> {
        std::fs::create_dir_all(root)?;
        let conversations_dir = memory_root.join("conversations");
        std::fs::create_dir_all(&conversations_dir)?;
        let settings = load_settings(&root.join(SETTINGS_FILE));
        Ok(Self {
            root: root.to_path_buf(),
            conversations_dir,
            settings: Mutex::new(settings),
            audit: approvals::AuditLog::new(root.join(AUDIT_FILE)),
            doc_cache: Mutex::new(suggestions::DocCache::default()),
        })
    }

    /// Current settings (already normalised).
    pub fn settings(&self) -> IntelSettings {
        lock(&self.settings).clone()
    }

    /// Normalise, persist and apply new settings. Returns what was stored.
    pub fn set_settings(&self, settings: IntelSettings) -> Result<IntelSettings, AetherError> {
        let normalized = settings.normalized();
        let json = serde_json::to_string_pretty(&normalized)
            .map_err(|e| AetherError::InvalidInput(format!("settings serialize: {e}")))?;
        let path = self.root.join(SETTINGS_FILE);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &path)?;
        *lock(&self.settings) = normalized.clone();
        Ok(normalized)
    }

    /// The append-only agent audit log.
    pub fn audit(&self) -> &approvals::AuditLog {
        &self.audit
    }

    /// Where conversations (with compaction summaries) are archived.
    pub fn conversations_dir(&self) -> &Path {
        &self.conversations_dir
    }

    /// Per-note keyword statistics, cached by path + mtime.
    pub fn doc_cache(&self) -> MutexGuard<'_, suggestions::DocCache> {
        lock(&self.doc_cache)
    }
}

/// Lock a mutex, recovering the data if a previous holder panicked: none of
/// the guarded values can be left logically inconsistent by a panic.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Read settings from disk; a missing or unreadable file yields defaults so
/// a corrupt file can never keep the app from starting.
fn load_settings(path: &Path) -> IntelSettings {
    match std::fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str::<IntelSettings>(&content) {
            Ok(settings) => settings.normalized(),
            Err(error) => {
                eprintln!("[AETHER] intel settings unreadable, using defaults: {error}");
                IntelSettings::default()
            }
        },
        Err(_) => IntelSettings::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> (tempfile::TempDir, IntelEngine) {
        let dir = tempfile::tempdir().expect("temp dir");
        let engine = IntelEngine::new(&dir.path().join("intel"), &dir.path().join("memory"))
            .expect("engine");
        (dir, engine)
    }

    #[test]
    fn starts_with_defaults_and_creates_directories() {
        let (dir, engine) = engine();
        assert_eq!(engine.settings(), IntelSettings::default());
        assert_eq!(engine.settings().compact_threshold_tokens, 6_000);
        assert!(dir.path().join("intel").is_dir());
        assert!(dir.path().join("memory/conversations").is_dir());
        assert_eq!(
            engine.conversations_dir(),
            dir.path().join("memory/conversations")
        );
    }

    #[test]
    fn settings_are_normalized_and_persisted() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("intel");
        let memory = dir.path().join("memory");
        {
            let engine = IntelEngine::new(&root, &memory).expect("engine");
            let stored = engine
                .set_settings(IntelSettings {
                    auto_compact: false,
                    compact_threshold_tokens: 10,
                    keep_recent_messages: 99,
                    related_suggestions: false,
                    llm_tag_suggestions: true,
                    command_timeout_secs: 0,
                })
                .expect("save");
            assert_eq!(stored.compact_threshold_tokens, MIN_THRESHOLD_TOKENS);
            assert_eq!(stored.keep_recent_messages, KEEP_RECENT_RANGE.1);
            assert_eq!(stored.command_timeout_secs, TIMEOUT_RANGE_SECS.0);
        }
        let reopened = IntelEngine::new(&root, &memory).expect("engine");
        let settings = reopened.settings();
        assert!(!settings.auto_compact);
        assert!(settings.llm_tag_suggestions);
        assert_eq!(settings.compact_threshold_tokens, MIN_THRESHOLD_TOKENS);
    }

    #[test]
    fn corrupt_settings_fall_back_to_defaults() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("intel");
        std::fs::create_dir_all(&root).expect("mkdir");
        std::fs::write(root.join(SETTINGS_FILE), "{ not json").expect("write");
        let engine = IntelEngine::new(&root, &dir.path().join("memory")).expect("engine");
        assert_eq!(engine.settings(), IntelSettings::default());
    }

    #[test]
    fn partial_settings_files_fill_in_defaults() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("intel");
        std::fs::create_dir_all(&root).expect("mkdir");
        std::fs::write(root.join(SETTINGS_FILE), r#"{"auto_compact":false}"#).expect("write");
        let engine = IntelEngine::new(&root, &dir.path().join("memory")).expect("engine");
        let settings = engine.settings();
        assert!(!settings.auto_compact);
        assert_eq!(settings.keep_recent_messages, 4);
    }
}
