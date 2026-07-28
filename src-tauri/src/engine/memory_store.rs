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
        let summary = messages
            .first()
            .map(|m| {
                let mut s = m.content.chars().take(80).collect::<String>();
                if m.content.chars().count() > 80 {
                    s.push('…');
                }
                s
            })
            .unwrap_or_default();
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
        conversations.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
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
                vec![msg("user", "What is in Ekins Work?"), msg("assistant", "It lists your tasks.")],
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
