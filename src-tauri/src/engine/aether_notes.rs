use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

const NOTES_DIR: &str = "notes";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AetherNote {
    pub id: String,
    pub title: String,
    pub content: String,
    pub source_query: String,
    pub related_notes: Vec<String>,
    pub created_at: String,
}

pub struct AetherNotes {
    storage_dir: PathBuf,
}

impl AetherNotes {
    pub fn new(storage_dir: &Path) -> Result<Self, AetherError> {
        let notes_dir = storage_dir.join(NOTES_DIR);
        std::fs::create_dir_all(&notes_dir)?;
        Ok(Self {
            storage_dir: notes_dir,
        })
    }

    pub fn create(
        &self,
        title: &str,
        content: &str,
        source_query: &str,
        related_notes: Vec<String>,
    ) -> Result<AetherNote, AetherError> {
        if title.trim().is_empty() {
            return Err(AetherError::InvalidInput("title is required".to_owned()));
        }

        let id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();

        let note = AetherNote {
            id: id.clone(),
            title: title.to_owned(),
            content: content.to_owned(),
            source_query: source_query.to_owned(),
            related_notes,
            created_at,
        };

        let path = self.storage_dir.join(format!("{id}.json"));
        let json = serde_json::to_string_pretty(&note)
            .map_err(|e| AetherError::Vault(format!("note serialize: {e}")))?;
        std::fs::write(path, json)?;

        Ok(note)
    }

    pub fn list(&self) -> Result<Vec<AetherNote>, AetherError> {
        let mut notes = Vec::new();
        for entry in std::fs::read_dir(&self.storage_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let content = std::fs::read_to_string(&path)?;
            let note: AetherNote = serde_json::from_str(&content).map_err(|e| {
                AetherError::Vault(format!("note parse error in {}: {e}", path.display()))
            })?;
            notes.push(note);
        }
        notes.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(notes)
    }

    pub fn get(&self, id: &str) -> Result<AetherNote, AetherError> {
        let path = self.storage_dir.join(format!("{id}.json"));
        if !path.exists() {
            return Err(AetherError::Vault(format!("note not found: {id}")));
        }
        let content = std::fs::read_to_string(&path)?;
        serde_json::from_str(&content)
            .map_err(|e| AetherError::Vault(format!("note parse: {e}")))
    }

    pub fn delete(&self, id: &str) -> Result<(), AetherError> {
        let path = self.storage_dir.join(format!("{id}.json"));
        if !path.exists() {
            return Err(AetherError::Vault(format!("note not found: {id}")));
        }
        std::fs::remove_file(path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn creates_and_lists_notes() {
        let dir = tempdir().expect("temp dir");
        let store = AetherNotes::new(dir.path()).expect("store");

        let note = store
            .create("Summary", "Content here", "What is X?", vec!["/a.md".to_owned()])
            .expect("create");

        assert_eq!(note.title, "Summary");
        assert_eq!(note.source_query, "What is X?");

        let list = store.list().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, note.id);
    }

    #[test]
    fn deletes_a_note() {
        let dir = tempdir().expect("temp dir");
        let store = AetherNotes::new(dir.path()).expect("store");

        let note = store
            .create("Test", "Body", "query", vec![])
            .expect("create");

        store.delete(&note.id).expect("delete");
        assert!(store.list().expect("list").is_empty());
    }

    #[test]
    fn rejects_empty_title() {
        let dir = tempdir().expect("temp dir");
        let store = AetherNotes::new(dir.path()).expect("store");
        let err = store
            .create("  ", "content", "q", vec![])
            .expect_err("must reject");
        assert!(err.to_string().contains("title"));
    }
}
