use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::engine::error::AetherError;

const INDEX_FILE: &str = ".nopes/index.json";
const CONFIG_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultNote {
    pub path: String,
    pub name: String,
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultTask {
    pub note_path: String,
    pub line: usize,
    pub text: String,
    pub checked: bool,
    pub due: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultCard {
    pub key: String,
    pub note_path: String,
    pub front: String,
    pub back: String,
    pub card_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultIndexEntry {
    pub path: String,
    pub mtime: u64,
    pub tags: Vec<String>,
    pub wikilinks: Vec<String>,
    pub tasks: Vec<VaultTask>,
    pub frontmatter: HashMap<String, String>,
    pub word_count: usize,
    pub cards: Vec<VaultCard>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultIndex {
    pub version: u32,
    pub notes: Vec<VaultIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultConfig {
    pub vault_path: Option<String>,
}

pub struct VaultReader {
    config_dir: PathBuf,
}

impl VaultReader {
    pub fn new(config_dir: &Path) -> Result<Self, AetherError> {
        std::fs::create_dir_all(config_dir)?;
        Ok(Self {
            config_dir: config_dir.to_path_buf(),
        })
    }

    fn config_path(&self) -> PathBuf {
        self.config_dir.join(CONFIG_FILE)
    }

    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    pub fn get_config(&self) -> VaultConfig {
        let path = self.config_path();
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(config) = serde_json::from_str::<VaultConfig>(&content) {
                    return config;
                }
            }
        }
        VaultConfig { vault_path: None }
    }

    pub fn set_vault_path(&self, path: &str) -> Result<(), AetherError> {
        let config = VaultConfig {
            vault_path: Some(path.to_owned()),
        };
        let content = serde_json::to_string_pretty(&config)
            .map_err(|e| AetherError::Vault(format!("config serialize: {e}")))?;
        std::fs::write(self.config_path(), content)?;
        Ok(())
    }

    pub fn detect_vault_path(&self) -> Option<String> {
        if let Some(path) = &self.get_config().vault_path {
            if Path::new(path).exists() {
                return Some(path.clone());
            }
        }

        if let Some(home) = dirs_home_checked() {
            for dir in &["Documents", "Desktop", "Downloads"] {
                let base = format!("{home}/{dir}");
                if let Some(found) = scan_for_vault(&base, 2) {
                    return Some(found);
                }
            }
        }

        None
    }

    pub fn scan_vault(&self, vault_path: &str) -> Result<Vec<VaultNote>, AetherError> {
        let root = Path::new(vault_path);
        if !root.exists() {
            return Err(AetherError::Vault(format!(
                "vault path does not exist: {vault_path}"
            )));
        }

        let mut notes = Vec::new();
        for entry in WalkDir::new(root)
            .max_depth(20)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if !name.to_lowercase().ends_with(".md") {
                continue;
            }

            let rel = path.strip_prefix(root).unwrap_or(path);
            if rel
                .components()
                .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
            {
                continue;
            }

            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            notes.push(VaultNote {
                path: path.to_string_lossy().to_string(),
                name: name.trim_end_matches(".md").to_owned(),
                mtime,
            });
        }

        notes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(notes)
    }

    pub fn read_note(&self, note_path: &str) -> Result<String, AetherError> {
        std::fs::read_to_string(note_path).map_err(|e| {
            AetherError::Vault(format!("failed to read {note_path}: {e}"))
        })
    }

    pub fn load_vault_index(&self, vault_path: &str) -> Result<Option<VaultIndex>, AetherError> {
        let index_path = Path::new(vault_path).join(INDEX_FILE);
        if !index_path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&index_path).map_err(|e| {
            AetherError::Vault(format!("failed to read index: {e}"))
        })?;
        let index: VaultIndex = serde_json::from_str(&content).map_err(|e| {
            AetherError::Vault(format!("failed to parse index: {e}"))
        })?;
        Ok(Some(index))
    }

    pub fn build_graph(&self, vault_path: &str) -> Result<GraphData, AetherError> {
        let notes = self.scan_vault(vault_path)?;
        let index = self.load_vault_index(vault_path)?;

        let mut nodes: Vec<GraphNode> = notes
            .iter()
            .map(|n| {
                let tags = index
                    .as_ref()
                    .and_then(|idx| {
                        idx.notes
                            .iter()
                            .find(|e| e.path == n.path)
                            .map(|e| e.tags.clone())
                    })
                    .unwrap_or_default();
                GraphNode {
                    id: n.path.clone(),
                    label: n.name.clone(),
                    tags,
                }
            })
            .collect();

        let mut edges = Vec::new();
        if let Some(idx) = &index {
            for entry in &idx.notes {
                for link in &entry.wikilinks {
                    let target = resolve_wikilink(link, &notes);
                    if let Some(target_path) = target {
                        edges.push(GraphEdge {
                            source: entry.path.clone(),
                            target: target_path,
                        });
                    }
                }
            }
        }

        nodes.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
        edges.dedup_by(|a, b| a.source == b.source && a.target == b.target);

        Ok(GraphData { nodes, edges })
    }

    pub fn get_vault_stats(&self, vault_path: &str) -> Result<VaultStats, AetherError> {
        let notes = self.scan_vault(vault_path)?;
        let index = self.load_vault_index(vault_path)?;

        let total_tasks = index
            .as_ref()
            .map(|idx| idx.notes.iter().map(|e| e.tasks.len()).sum())
            .unwrap_or(0);
        let open_tasks = index
            .as_ref()
            .map(|idx| {
                idx.notes
                    .iter()
                    .flat_map(|e| e.tasks.iter())
                    .filter(|t| !t.checked)
                    .count()
            })
            .unwrap_or(0);
        let total_cards = index
            .as_ref()
            .map(|idx| idx.notes.iter().map(|e| e.cards.len()).sum())
            .unwrap_or(0);
        let total_tags = index
            .as_ref()
            .map(|idx| {
                idx.notes
                    .iter()
                    .flat_map(|e| e.tags.iter())
                    .collect::<std::collections::HashSet<_>>()
                    .len()
            })
            .unwrap_or(0);
        let total_links = index
            .as_ref()
            .map(|idx| idx.notes.iter().map(|e| e.wikilinks.len()).sum())
            .unwrap_or(0);

        Ok(VaultStats {
            note_count: notes.len(),
            total_tasks,
            open_tasks,
            total_cards,
            total_tags,
            total_links,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStats {
    pub note_count: usize,
    pub total_tasks: usize,
    pub open_tasks: usize,
    pub total_cards: usize,
    pub total_tags: usize,
    pub total_links: usize,
}

fn resolve_wikilink(link: &str, notes: &[VaultNote]) -> Option<String> {
    let lower = link.to_lowercase();
    notes
        .iter()
        .find(|n| n.name.to_lowercase() == lower)
        .map(|n| n.path.clone())
}

fn dirs_home_checked() -> Option<String> {
    std::env::var("HOME").ok()
}

fn scan_for_vault(base: &str, max_depth: usize) -> Option<String> {
    let base_path = Path::new(base);
    if !base_path.exists() {
        return None;
    }

    for entry in WalkDir::new(base_path)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_dir() {
            let index = entry.path().join(".nopes/index.json");
            if index.exists() {
                return Some(entry.path().to_string_lossy().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn scans_markdown_files() {
        let dir = tempdir().expect("temp dir");
        fs::write(dir.path().join("note1.md"), "# Hello").expect("write");
        fs::write(dir.path().join("note2.md"), "# World").expect("write");
        fs::create_dir(dir.path().join(".nopes")).expect("mkdir");
        fs::write(dir.path().join(".nopes/hidden.md"), "hidden").expect("write");

        let config_dir = tempdir().expect("config dir");
        let reader = VaultReader::new(config_dir.path()).expect("reader");
        let notes = reader
            .scan_vault(dir.path().to_str().unwrap())
            .expect("scan");

        assert_eq!(notes.len(), 2);
        assert!(notes.iter().all(|n| !n.path.contains(".nopes")));
    }

    #[test]
    fn reads_note_content() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("test.md");
        fs::write(&path, "# Test content").expect("write");

        let config_dir = tempdir().expect("config dir");
        let reader = VaultReader::new(config_dir.path()).expect("reader");
        let content = reader
            .read_note(path.to_str().unwrap())
            .expect("read");
        assert_eq!(content, "# Test content");
    }

    #[test]
    fn parses_vault_index() {
        let dir = tempdir().expect("temp dir");
        let nopes_dir = dir.path().join(".nopes");
        fs::create_dir(&nopes_dir).expect("mkdir");
        fs::write(
            nopes_dir.join("index.json"),
            r#"{"version":2,"notes":[{"path":"/test.md","mtime":1000,"tags":["foo"],"wikilinks":["bar"],"tasks":[],"frontmatter":{},"word_count":10,"cards":[]}]}"#,
        )
        .expect("write");

        let config_dir = tempdir().expect("config dir");
        let reader = VaultReader::new(config_dir.path()).expect("reader");
        let index = reader
            .load_vault_index(dir.path().to_str().unwrap())
            .expect("load");
        assert!(index.is_some());
        let idx = index.unwrap();
        assert_eq!(idx.notes.len(), 1);
        assert_eq!(idx.notes[0].tags, vec!["foo"]);
    }

    #[test]
    fn builds_graph_from_wikilinks() {
        let dir = tempdir().expect("temp dir");
        fs::write(dir.path().join("alpha.md"), "# Alpha\n[[beta]]").expect("write");
        fs::write(dir.path().join("beta.md"), "# Beta").expect("write");
        let nopes_dir = dir.path().join(".nopes");
        fs::create_dir(&nopes_dir).expect("mkdir");

        let alpha_path = dir.path().join("alpha.md").to_string_lossy().to_string();
        let beta_path = dir.path().join("beta.md").to_string_lossy().to_string();

        let index_json = format!(
            r#"{{"version":2,"notes":[{{"path":"{alpha}","mtime":1,"tags":[],"wikilinks":["beta"],"tasks":[],"frontmatter":{{}},"word_count":5,"cards":[]}},{{"path":"{beta}","mtime":1,"tags":[],"wikilinks":[],"tasks":[],"frontmatter":{{}},"word_count":2,"cards":[]}}]}}"#,
            alpha = alpha_path,
            beta = beta_path
        );
        fs::write(nopes_dir.join("index.json"), index_json).expect("write");

        let config_dir = tempdir().expect("config dir");
        let reader = VaultReader::new(config_dir.path()).expect("reader");

        let vault_path = dir.path().to_string_lossy().to_string();
        let graph = reader.build_graph(&vault_path).expect("graph");
        assert_eq!(graph.nodes.len(), 2);
        assert!(graph.edges.iter().any(|e| e.source == alpha_path && e.target == beta_path));
    }

    #[test]
    fn config_round_trips() {
        let dir = tempdir().expect("temp dir");
        let reader = VaultReader::new(dir.path()).expect("reader");
        assert!(reader.get_config().vault_path.is_none());

        reader
            .set_vault_path("/tmp/my-vault")
            .expect("set");
        assert_eq!(reader.get_config().vault_path, Some("/tmp/my-vault".to_owned()));
    }
}
