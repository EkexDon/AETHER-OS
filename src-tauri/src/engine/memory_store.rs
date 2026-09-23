use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::engine::error::AetherError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageRecord {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub timestamp: i64,
    pub messages: Vec<ChatMessageRecord>,
    pub context_notes: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFact {
    pub fact: String,
    pub category: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct FactsFile {
    facts: Vec<MemoryFact>,
}

/// Characters of the first message used as the default summary.
const SUMMARY_CHARS: usize = 80;

/// Title derived from the first message (`SUMMARY_CHARS`, then `…`).
fn summary_from_messages(messages: &[ChatMessageRecord]) -> String {
    messages
        .first()
        .map(|m| {
            let mut s = m.content.chars().take(SUMMARY_CHARS).collect::<String>();
            if m.content.chars().count() > SUMMARY_CHARS {
                s.push('…');
            }
            s
        })
        .unwrap_or_default()
}

/// Conversation ids become part of file names: ASCII letters, digits, `-`
/// and `_` only, at most 64 characters.
fn is_valid_conversation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub struct MemoryStore {
    root: PathBuf,
}

impl MemoryStore {
    pub fn new(root: &Path) -> Result<Self, AetherError> {
        let conv_dir = root.join("conversations");
        std::fs::create_dir_all(&conv_dir)?;
        Ok(Self {
            root: root.to_path_buf(),
        })
    }

    fn facts_path(&self) -> PathBuf {
        self.root.join("facts.json")
    }

    fn conv_dir(&self) -> PathBuf {
        self.root.join("conversations")
    }

    pub fn save_conversation(
        &self,
        messages: Vec<ChatMessageRecord>,
        context_notes: Vec<String>,
    ) -> Result<Conversation, AetherError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let id = uuid::Uuid::new_v4().to_string();
        let summary = summary_from_messages(&messages);
        let conversation = Conversation {
            id: id.clone(),
            timestamp: now,
            messages,
            context_notes,
            summary,
        };
        let path = self.conv_dir().join(format!("{now}-{id}.json"));
        let content = serde_json::to_string_pretty(&conversation)
            .map_err(|e| AetherError::Vault(format!("conversation serialize: {e}")))?;
        std::fs::write(path, content)?;
        Ok(conversation)
    }

    /// Create or replace a conversation. With `id`, every previous record of
    /// that id is replaced and the timestamp refreshed, so one chat session
    /// is one history entry. `summary` (e.g. a compaction summary) defaults
    /// to the first message, like [`MemoryStore::save_conversation`]. The
    /// record is written atomically (temp file + rename).
    pub fn upsert_conversation(
        &self,
        id: Option<&str>,
        messages: Vec<ChatMessageRecord>,
        context_notes: Vec<String>,
        summary: Option<String>,
    ) -> Result<Conversation, AetherError> {
        if messages.is_empty() {
            return Err(AetherError::InvalidInput(
                "a conversation needs at least one message".to_owned(),
            ));
        }
        let id = match id.map(str::trim).filter(|s| !s.is_empty()) {
            Some(existing) if is_valid_conversation_id(existing) => existing.to_owned(),
            Some(invalid) => {
                return Err(AetherError::InvalidInput(format!(
                    "invalid conversation id: {invalid}"
                )))
            }
            None => uuid::Uuid::new_v4().to_string(),
        };
        let dir = self.conv_dir();
        std::fs::create_dir_all(&dir)?;
        self.remove_conversation_files(&id)?;

        let now = chrono::Utc::now().timestamp();
        let summary = summary
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| summary_from_messages(&messages));
        let conversation = Conversation {
            id: id.clone(),
            timestamp: now,
            messages,
            context_notes,
            summary,
        };
        let json = serde_json::to_string_pretty(&conversation)
            .map_err(|e| AetherError::Vault(format!("conversation serialize: {e}")))?;
        let path = dir.join(format!("{now}-{id}.json"));
        let tmp = dir.join(format!(".{now}-{id}.json.tmp"));
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &path)?;
        Ok(conversation)
    }

    /// Delete every stored record of conversation `id`.
    fn remove_conversation_files(&self, id: &str) -> Result<(), AetherError> {
        for entry in std::fs::read_dir(self.conv_dir())? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(existing) = serde_json::from_str::<Conversation>(&content) {
                if existing.id == id {
                    std::fs::remove_file(&path)?;
                }
            }
        }
        Ok(())
    }

    pub fn load_recent(&self, limit: usize) -> Result<Vec<Conversation>, AetherError> {
        let dir = self.conv_dir();
        let mut conversations = Vec::new();
        if dir.exists() {
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(conv) = serde_json::from_str::<Conversation>(&content) {
                        conversations.push(conv);
                    }
                }
            }
        }
        conversations.sort_by_key(|c| std::cmp::Reverse(c.timestamp));
        conversations.truncate(limit);
        Ok(conversations)
    }

    pub fn delete_conversation(&self, id: &str) -> Result<(), AetherError> {
        let dir = self.conv_dir();
        if dir.exists() {
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(conv) = serde_json::from_str::<Conversation>(&content) {
                        if conv.id == id {
                            std::fs::remove_file(&path)?;
                            return Ok(());
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub fn save_fact(&self, fact: &str, category: &str) -> Result<Vec<MemoryFact>, AetherError> {
        let mut facts = self.load_facts()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        facts.push(MemoryFact {
            fact: fact.to_owned(),
            category: category.to_owned(),
            created_at: now,
        });
        self.persist_facts(&facts)?;
        Ok(facts)
    }

    pub fn delete_fact(&self, fact: &str) -> Result<Vec<MemoryFact>, AetherError> {
        let mut facts = self.load_facts()?;
        facts.retain(|f| f.fact != fact);
        self.persist_facts(&facts)?;
        Ok(facts)
    }

    pub fn load_facts(&self) -> Result<Vec<MemoryFact>, AetherError> {
        let path = self.facts_path();
        if !path.exists() {
            return Ok(vec![]);
        }
        let content = std::fs::read_to_string(&path)?;
        let parsed: FactsFile = serde_json::from_str(&content)
            .map_err(|e| AetherError::Vault(format!("facts parse: {e}")))?;
        Ok(parsed.facts)
    }

    fn persist_facts(&self, facts: &[MemoryFact]) -> Result<(), AetherError> {
        let file = FactsFile {
            facts: facts.to_vec(),
        };
        let content = serde_json::to_string_pretty(&file)
            .map_err(|e| AetherError::Vault(format!("facts serialize: {e}")))?;
        std::fs::write(self.facts_path(), content)?;
        Ok(())
    }

    pub fn build_context_summary(&self) -> String {
        let facts = self.load_facts().unwrap_or_default();
        let conversations = self.load_recent(5).unwrap_or_default();

        let mut out = String::new();
        if !facts.is_empty() {
            out.push_str("## What I know about the user\n");
            for fact in facts.iter().rev().take(10) {
                out.push_str(&format!("- {}\n", fact.fact));
            }
        }
        if !conversations.is_empty() {
            out.push_str("\n## Recent conversation topics\n");
            for conv in &conversations {
                out.push_str(&format!("- {}\n", conv.summary));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::{ChatMessageRecord, MemoryStore};

    fn store() -> (MemoryStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("temp dir must be created");
        let store = MemoryStore::new(dir.path()).expect("store must initialise");
        (store, dir)
    }

    fn msg(role: &str, content: &str) -> ChatMessageRecord {
        ChatMessageRecord {
            role: role.to_owned(),
            content: content.to_owned(),
        }
    }

    #[test]
    fn starts_with_no_facts_or_conversations() {
        let (store, _dir) = store();
        assert!(store.load_facts().expect("facts must load").is_empty());
        assert!(store
            .load_recent(10)
            .expect("conversations must load")
            .is_empty());
    }

    #[test]
    fn saves_and_loads_a_conversation() {
        let (store, _dir) = store();
        let saved = store
            .save_conversation(
                vec![
                    msg("user", "What is in Ekins Work?"),
                    msg("assistant", "It lists your tasks."),
                ],
                vec!["Ekins Work.md".to_owned()],
            )
            .expect("conversation must save");

        let loaded = store.load_recent(10).expect("conversations must load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, saved.id);
        assert_eq!(loaded[0].messages.len(), 2);
        assert_eq!(loaded[0].context_notes, vec!["Ekins Work.md".to_owned()]);
    }

    #[test]
    fn derives_the_summary_from_the_first_message() {
        let (store, _dir) = store();
        let saved = store
            .save_conversation(vec![msg("user", "Short question")], vec![])
            .expect("conversation must save");
        assert_eq!(saved.summary, "Short question");
    }

    #[test]
    fn truncates_long_summaries_with_an_ellipsis() {
        let (store, _dir) = store();
        let long = "a".repeat(200);
        let saved = store
            .save_conversation(vec![msg("user", &long)], vec![])
            .expect("conversation must save");
        assert_eq!(saved.summary.chars().count(), 81);
        assert!(saved.summary.ends_with('…'));
    }

    #[test]
    fn respects_the_recent_conversation_limit() {
        let (store, _dir) = store();
        for i in 0..5 {
            store
                .save_conversation(vec![msg("user", &format!("question {i}"))], vec![])
                .expect("conversation must save");
        }
        assert_eq!(store.load_recent(3).expect("must load").len(), 3);
    }

    #[test]
    fn deletes_a_conversation_by_id() {
        let (store, _dir) = store();
        let saved = store
            .save_conversation(vec![msg("user", "forget me")], vec![])
            .expect("conversation must save");
        store
            .delete_conversation(&saved.id)
            .expect("conversation must delete");
        assert!(store.load_recent(10).expect("must load").is_empty());
    }

    fn turns(n: usize) -> Vec<ChatMessageRecord> {
        (0..n)
            .flat_map(|i| {
                [
                    msg("user", &format!("Question {i}? I prefer short answers.")),
                    msg("assistant", &format!("Answer {i}.")),
                ]
            })
            .collect()
    }

    fn conversation_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(dir.join("conversations"))
            .expect("list")
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
            .collect()
    }

    #[test]
    fn upsert_replaces_the_previous_record_of_a_session() {
        let (store, dir) = store();
        let first = store
            .upsert_conversation(None, turns(1), vec!["a.md".into()], None)
            .expect("save");
        assert_eq!(first.summary, "Question 0? I prefer short answers.");
        let second = store
            .upsert_conversation(
                Some(&first.id),
                turns(3),
                vec![],
                Some("Topic: Q\nFacts:\n- x".into()),
            )
            .expect("update");
        assert_eq!(second.id, first.id);

        let files = conversation_files(dir.path());
        assert_eq!(files.len(), 1);
        let stored: super::Conversation =
            serde_json::from_str(&std::fs::read_to_string(&files[0]).expect("read"))
                .expect("parse");
        assert_eq!(stored.messages.len(), 6);
        assert!(stored.summary.starts_with("Topic: Q"));
    }

    #[test]
    fn upsert_replaces_records_written_by_save_conversation() {
        let (store, dir) = store();
        let saved = store
            .save_conversation(vec![msg("user", "first")], vec![])
            .expect("save");
        store
            .upsert_conversation(Some(&saved.id), turns(2), vec![], None)
            .expect("upsert");
        assert_eq!(conversation_files(dir.path()).len(), 1);
        let loaded = store.load_recent(10).expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].messages.len(), 4);
    }

    #[test]
    fn memory_store_loads_upserted_conversations() {
        let (store, _dir) = store();
        let saved = store
            .upsert_conversation(
                None,
                turns(2),
                vec![],
                Some("Topic: Loaded\nFacts:\n- y".into()),
            )
            .expect("save");
        let loaded = store.load_recent(10).expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, saved.id);
        assert!(loaded[0].summary.starts_with("Topic: Loaded"));
        store.delete_conversation(&saved.id).expect("delete");
        assert!(store.load_recent(10).expect("load").is_empty());
    }

    #[test]
    fn upsert_validates_input() {
        let (store, dir) = store();
        assert!(store
            .upsert_conversation(None, vec![], vec![], None)
            .is_err());
        assert!(store
            .upsert_conversation(Some("../evil"), turns(1), vec![], None)
            .is_err());
        assert!(conversation_files(dir.path()).is_empty());
    }

    #[test]
    fn saves_and_deletes_facts() {
        let (store, _dir) = store();
        store
            .save_fact("prefers Cursor", "tooling")
            .expect("fact must save");
        let facts = store
            .save_fact("works on AETHER-OS", "projects")
            .expect("fact must save");
        assert_eq!(facts.len(), 2);

        let remaining = store
            .delete_fact("prefers Cursor")
            .expect("fact must delete");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].fact, "works on AETHER-OS");
    }

    #[test]
    fn facts_persist_across_store_instances() {
        let dir = tempfile::tempdir().expect("temp dir must be created");
        {
            let store = MemoryStore::new(dir.path()).expect("store must initialise");
            store
                .save_fact("uses an M2 Air", "hardware")
                .expect("fact must save");
        }
        let reopened = MemoryStore::new(dir.path()).expect("store must reinitialise");
        let facts = reopened.load_facts().expect("facts must load");
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].fact, "uses an M2 Air");
    }

    #[test]
    fn context_summary_is_empty_without_memory() {
        let (store, _dir) = store();
        assert!(store.build_context_summary().is_empty());
    }

    #[test]
    fn context_summary_includes_facts_and_conversation_topics() {
        let (store, _dir) = store();
        store
            .save_fact("prefers Cursor", "tooling")
            .expect("fact must save");
        store
            .save_conversation(vec![msg("user", "Summarise Ekins Work")], vec![])
            .expect("conversation must save");

        let summary = store.build_context_summary();
        assert!(summary.contains("What I know about the user"));
        assert!(summary.contains("prefers Cursor"));
        assert!(summary.contains("Recent conversation topics"));
        assert!(summary.contains("Summarise Ekins Work"));
    }
}
