use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::engine::error::AetherError;
use crate::engine::fs_guard;
use crate::engine::onboarding::{read_vault_prefs, VaultPrefs};

const INDEX_FILE: &str = ".nopes/index.json";
const CONFIG_FILE: &str = "config.json";

/// Largest vault asset (image, video, audio, PDF) handed to the webview.
pub const MAX_ASSET_BYTES: u64 = 25 * 1024 * 1024;

/// Extensions served by [`VaultReader::read_asset`] and their MIME types.
const ASSET_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("bmp", "image/bmp"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("mov", "video/quicktime"),
    ("mp3", "audio/mpeg"),
    ("m4a", "audio/mp4"),
    ("wav", "audio/wav"),
    ("pdf", "application/pdf"),
];

/// A vault file embedded in a note (image, video, audio or PDF), returned
/// base64-encoded because the webview has no direct file access.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VaultAsset {
    /// MIME type inferred from the file extension.
    pub mime: String,
    /// File content, standard base64.
    pub data_base64: String,
    /// File size in bytes.
    pub byte_len: u64,
}

/// MIME type of an allowed asset extension (case-insensitive), `None` for
/// every other file type.
pub fn asset_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    ASSET_TYPES
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, mime)| *mime)
}

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

/// How long an auto-detected (not configured) vault location is reused
/// before the home folders are scanned again.
const DETECT_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5);

pub struct VaultReader {
    config_dir: PathBuf,
    /// Last result of the home-folder scan used when no vault is configured,
    /// so per-note calls (reads in indexing loops) do not rescan each time.
    detected: std::sync::Mutex<Option<(std::time::Instant, Option<String>)>>,
}

impl VaultReader {
    pub fn new(config_dir: &Path) -> Result<Self, AetherError> {
        std::fs::create_dir_all(config_dir)?;
        Ok(Self {
            config_dir: config_dir.to_path_buf(),
            detected: std::sync::Mutex::new(None),
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

        let mut cache = self
            .detected
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((at, found)) = cache.as_ref() {
            if at.elapsed() < DETECT_CACHE_TTL {
                return found.clone();
            }
        }
        let found = dirs_home_checked().and_then(|home| {
            ["Documents", "Desktop", "Downloads"]
                .iter()
                .find_map(|dir| scan_for_vault(&format!("{home}/{dir}"), 2))
        });
        *cache = Some((std::time::Instant::now(), found.clone()));
        found
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

        notes.sort_by_cached_key(|n| n.name.to_lowercase());
        Ok(notes)
    }

    /// Canonical root of the configured vault.
    pub fn vault_root(&self) -> Result<PathBuf, AetherError> {
        let vault_path = self
            .detect_vault_path()
            .ok_or_else(|| AetherError::Vault("no vault path configured".into()))?;
        std::fs::canonicalize(&vault_path)
            .map_err(|e| AetherError::Vault(format!("vault canonicalize: {e}")))
    }

    /// Read a note. The path must resolve (symlinks included) to a file
    /// inside the vault root; anything else is rejected.
    pub fn read_note(&self, note_path: &str) -> Result<String, AetherError> {
        let root = self.vault_root()?;
        let canonical = std::fs::canonicalize(note_path)
            .map_err(|e| AetherError::Vault(format!("failed to read {note_path}: {e}")))?;
        if !canonical.starts_with(&root) {
            return Err(AetherError::Vault(format!(
                "refusing to read outside vault: {note_path}"
            )));
        }
        std::fs::read_to_string(&canonical)
            .map_err(|e| AetherError::Vault(format!("failed to read {note_path}: {e}")))
    }

    /// Write note content. The path must resolve inside the vault root —
    /// anything else is rejected to keep writes scoped to the vault.
    pub fn write_note(&self, note_path: &str, content: &str) -> Result<(), AetherError> {
        let root = self.vault_root()?;
        let path = Path::new(note_path);
        // `symlink_metadata` also sees dangling links: those must be
        // resolved (and fail) instead of being written through.
        let canonical = if std::fs::symlink_metadata(path).is_ok() {
            std::fs::canonicalize(path)
                .map_err(|e| AetherError::Vault(format!("note canonicalize: {e}")))?
        } else {
            // New file: canonicalize the parent and join the file name.
            let parent = path
                .parent()
                .ok_or_else(|| AetherError::Vault("note path has no parent".into()))?;
            let parent = std::fs::canonicalize(parent)
                .map_err(|e| AetherError::Vault(format!("parent canonicalize: {e}")))?;
            parent.join(
                path.file_name()
                    .ok_or_else(|| AetherError::Vault("note path has no file name".into()))?,
            )
        };
        if !canonical.starts_with(&root) {
            return Err(AetherError::Vault(format!(
                "refusing to write outside vault: {note_path}"
            )));
        }
        if canonical
            .strip_prefix(&root)
            .is_ok_and(fs_guard::has_git_component)
        {
            return Err(AetherError::Vault(format!(
                "refusing to write into the vault's .git folder: {note_path}"
            )));
        }
        std::fs::write(&canonical, content)?;
        Ok(())
    }

    /// Read an asset embedded in a note. `path` is vault-relative or
    /// absolute; either way it must canonicalize (symlinks resolved) to a
    /// regular file inside the vault, outside `.git`, with an allowed
    /// extension (see [`asset_mime`]) and at most [`MAX_ASSET_BYTES`].
    pub fn read_asset(&self, path: &str) -> Result<VaultAsset, AetherError> {
        use base64::Engine as _;
        use std::io::Read as _;

        let trimmed = path.trim();
        if trimmed.is_empty() || trimmed.contains('\0') {
            return Err(AetherError::InvalidInput("asset path is empty".into()));
        }
        let root = self.vault_root()?;
        let requested = Path::new(trimmed);
        let candidate = if requested.is_absolute() {
            requested.to_path_buf()
        } else {
            root.join(requested)
        };
        let canonical = std::fs::canonicalize(&candidate)
            .map_err(|_| AetherError::InvalidInput(format!("asset not found: {trimmed}")))?;
        let rel = canonical.strip_prefix(&root).map_err(|_| {
            AetherError::InvalidInput(format!("asset is outside the vault: {trimmed}"))
        })?;
        if fs_guard::has_git_component(rel) {
            return Err(AetherError::InvalidInput(format!(
                "assets inside .git are not served: {trimmed}"
            )));
        }
        let mime = asset_mime(&canonical).ok_or_else(|| {
            AetherError::InvalidInput(format!("not an image, video, audio or PDF file: {trimmed}"))
        })?;
        let file = std::fs::File::open(&canonical)?;
        let meta = file.metadata()?;
        if !meta.is_file() {
            return Err(AetherError::InvalidInput(format!(
                "asset is not a file: {trimmed}"
            )));
        }
        if meta.len() > MAX_ASSET_BYTES {
            return Err(AetherError::InvalidInput(format!(
                "asset is larger than {} MB: {trimmed}",
                MAX_ASSET_BYTES / 1024 / 1024
            )));
        }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        file.take(MAX_ASSET_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(AetherError::InvalidInput(format!(
                "asset grew beyond {} MB: {trimmed}",
                MAX_ASSET_BYTES / 1024 / 1024
            )));
        }
        Ok(VaultAsset {
            mime: mime.to_owned(),
            byte_len: bytes.len() as u64,
            data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        })
    }

    /// Create a new note inside the vault. `rel_path` is relative to the
    /// vault root (e.g. "clips/My Article.md"). Parent dirs are created.
    pub fn create_note(&self, rel_path: &str, content: &str) -> Result<String, AetherError> {
        let vault_path = self
            .detect_vault_path()
            .ok_or_else(|| AetherError::Vault("no vault path configured".into()))?;
        let rel = sanitize_rel_path(rel_path)?;
        let root = std::fs::canonicalize(&vault_path)
            .map_err(|e| AetherError::Vault(format!("vault canonicalize: {e}")))?;
        let abs = Path::new(&vault_path).join(&rel);
        if let Some(parent) = abs.parent() {
            // Refuses symlinked folders that lead out of the vault before
            // anything is created.
            fs_guard::create_dir_all_within(&root, parent)?;
        }
        // Avoid clobbering an existing note — append a counter if needed.
        let abs = unique_path(&abs);
        std::fs::write(&abs, content)?;
        Ok(abs.to_string_lossy().to_string())
    }

    /// Append a line (plus trailing newline) to an existing note.
    pub fn append_note(&self, note_path: &str, content: &str) -> Result<(), AetherError> {
        let existing = self.read_note(note_path)?;
        let mut new_content = existing;
        if !new_content.ends_with('\n') && !new_content.is_empty() {
            new_content.push('\n');
        }
        new_content.push_str(content);
        if !content.ends_with('\n') {
            new_content.push('\n');
        }
        self.write_note(note_path, &new_content)
    }

    /// Find every note that links to `note_name` via [[wikilinks]].
    /// Scans live note contents so results are always up to date.
    pub fn get_backlinks(
        &self,
        vault_path: &str,
        note_name: &str,
    ) -> Result<Vec<Backlink>, AetherError> {
        let notes = self.scan_vault(vault_path)?;
        let target = note_name.trim().to_lowercase();
        if target.is_empty() {
            return Ok(Vec::new());
        }
        let mut backlinks = Vec::new();
        for note in notes {
            let content = match std::fs::read_to_string(&note.path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            for (idx, line) in content.lines().enumerate() {
                if line_matches_wikilink(line, &target) {
                    backlinks.push(Backlink {
                        note_path: note.path.clone(),
                        note_name: note.name.clone(),
                        line: idx + 1,
                        context: line.trim().chars().take(200).collect(),
                    });
                }
            }
        }
        Ok(backlinks)
    }

    /// Daily-note preferences from `<config_dir>/vault_prefs.json` (written
    /// by onboarding / Settings → Vault); `daily/YYYY-MM-DD` when unset.
    pub fn daily_note_prefs(&self) -> Result<VaultPrefs, AetherError> {
        read_vault_prefs(&self.config_dir)
    }

    /// Absolute path of the daily note for `date` (`YYYY-MM-DD`) inside the
    /// vault, following the configured folder and file name pattern
    /// (default `daily/YYYY-MM-DD.md`). Creates the file (with a heading)
    /// and any missing folders.
    pub fn get_or_create_daily_note(&self, date: &str) -> Result<String, AetherError> {
        let day = chrono::NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").map_err(|_| {
            AetherError::InvalidInput(format!(
                "invalid daily note date {date:?}; expected YYYY-MM-DD"
            ))
        })?;
        self.daily_note_for(day)
    }

    fn daily_note_for(&self, day: chrono::NaiveDate) -> Result<String, AetherError> {
        let vault_path = self
            .detect_vault_path()
            .ok_or_else(|| AetherError::Vault("no vault path configured".into()))?;
        let prefs = self.daily_note_prefs()?;
        let rel = prefs
            .daily_rel_path(day)
            .to_string_lossy()
            .replace('\\', "/");
        let rel = sanitize_rel_path(&rel)?;
        let abs = Path::new(&vault_path).join(&rel);
        if !abs.exists() {
            let heading = day.format("%Y-%m-%d");
            self.create_note(&rel, &format!("# {heading}\n\n"))?;
        }
        Ok(abs.to_string_lossy().to_string())
    }

    /// Append a timestamped bullet to today's daily note.
    pub fn append_daily_note(&self, text: &str) -> Result<String, AetherError> {
        let now = chrono::Local::now();
        let time = now.format("%H:%M").to_string();
        let path = self.daily_note_for(now.date_naive())?;
        let line = format!("- **{time}** — {}", text.trim());
        self.append_note(&path, &line)?;
        Ok(path)
    }

    pub fn load_vault_index(&self, vault_path: &str) -> Result<Option<VaultIndex>, AetherError> {
        let index_path = Path::new(vault_path).join(INDEX_FILE);
        if !index_path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&index_path)
            .map_err(|e| AetherError::Vault(format!("failed to read index: {e}")))?;
        let index: VaultIndex = serde_json::from_str(&content)
            .map_err(|e| AetherError::Vault(format!("failed to parse index: {e}")))?;
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

        nodes.sort_by_cached_key(|n| n.label.to_lowercase());
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Backlink {
    pub note_path: String,
    pub note_name: String,
    pub line: usize,
    pub context: String,
}

/// Validate a vault folder chosen in Settings: an absolute path to an
/// existing directory that is not a filesystem root or an OS system
/// folder. Returns the trimmed path in the user's spelling.
pub fn validate_vault_dir(path: &str) -> Result<String, AetherError> {
    let trimmed = path.trim();
    let candidate = Path::new(trimmed);
    if trimmed.is_empty() || trimmed.contains('\0') || !candidate.is_absolute() {
        return Err(AetherError::InvalidInput(format!(
            "the vault folder must be an absolute path (got \"{trimmed}\")"
        )));
    }
    let canonical = std::fs::canonicalize(candidate).map_err(|_| {
        AetherError::InvalidInput(format!("the vault folder does not exist: {trimmed}"))
    })?;
    if !canonical.is_dir() {
        return Err(AetherError::InvalidInput(format!(
            "the vault path is not a folder: {trimmed}"
        )));
    }
    if fs_guard::is_system_location(&canonical) {
        return Err(AetherError::InvalidInput(format!(
            "a filesystem root or system folder cannot be the vault: {trimmed}"
        )));
    }
    Ok(trimmed.to_owned())
}

/// Validate a vault-relative path: no traversal, no absolute components,
/// always ends in .md.
fn sanitize_rel_path(rel: &str) -> Result<String, AetherError> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err(AetherError::Vault("empty note path".into()));
    }
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty()
        || parts.iter().any(|p| *p == ".." || p.starts_with('.'))
        || rel.starts_with('/')
        || rel.contains(':')
    {
        return Err(AetherError::Vault(format!("invalid note path: {rel}")));
    }
    let joined = parts.join("/");
    if joined.to_lowercase().ends_with(".md") {
        Ok(joined)
    } else {
        Ok(format!("{joined}.md"))
    }
}

/// `path` exists, or is a (possibly dangling) symbolic link.
fn is_taken(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// If `path` already exists (or is a symlink), append " 2", " 3", … before
/// the extension.
fn unique_path(path: &Path) -> PathBuf {
    if !is_taken(path) {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    for i in 2..1000 {
        let candidate = parent.join(format!("{stem} {i}.{ext}"));
        if !is_taken(&candidate) {
            return candidate;
        }
    }
    path.to_path_buf()
}

/// Check whether a line contains a [[wikilink]] pointing at `target`
/// (case-insensitive, alias-aware: [[Target|alias]] also matches).
fn line_matches_wikilink(line: &str, target: &str) -> bool {
    let mut rest = line;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { break };
        let inner = &after[..end];
        let name = inner
            .split('|')
            .next()
            .unwrap_or(inner)
            .trim()
            .to_lowercase();
        if name == target {
            return true;
        }
        rest = &after[end + 2..];
    }
    false
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
        reader
            .set_vault_path(dir.path().to_str().unwrap())
            .expect("set vault");
        let content = reader.read_note(path.to_str().unwrap()).expect("read");
        assert_eq!(content, "# Test content");
    }

    /// Table: a note inside the vault, a `..` path out of it, an absolute
    /// outside path and a symlink escaping the vault.
    #[test]
    fn read_note_stays_inside_the_vault() {
        let (vault, _config, reader) = reader_with_vault();
        let outside = tempdir().expect("outside");
        fs::write(vault.path().join("inside.md"), "ok").expect("write");
        fs::write(outside.path().join("secret.md"), "secret").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), vault.path().join("link")).expect("symlink");

        let dotdot = format!(
            "{}/../{}/secret.md",
            vault.path().display(),
            outside.path().file_name().unwrap().to_string_lossy()
        );
        let mut cases = vec![
            (vault.path().join("inside.md").display().to_string(), true),
            (dotdot, false),
            (
                outside.path().join("secret.md").display().to_string(),
                false,
            ),
        ];
        #[cfg(unix)]
        cases.push((
            vault.path().join("link/secret.md").display().to_string(),
            false,
        ));
        for (path, ok) in cases {
            assert_eq!(reader.read_note(&path).is_ok(), ok, "{path}");
        }
    }

    #[test]
    fn write_note_refuses_git_internals_and_dangling_links() {
        let (vault, _config, reader) = reader_with_vault();
        fs::create_dir(vault.path().join(".git")).expect("mkdir");
        let config = vault.path().join(".git/config");
        assert!(reader
            .write_note(config.to_str().unwrap(), "[core]")
            .is_err());
        assert!(!config.exists());

        #[cfg(unix)]
        {
            let outside = tempdir().expect("outside");
            let target = outside.path().join("created.md");
            let link = vault.path().join("dangling.md");
            std::os::unix::fs::symlink(&target, &link).expect("symlink");
            assert!(reader.write_note(link.to_str().unwrap(), "x").is_err());
            assert!(
                !target.exists(),
                "a dangling link must not be written through"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn create_note_refuses_symlinked_folders_out_of_the_vault() {
        let (vault, _config, reader) = reader_with_vault();
        let outside = tempdir().expect("outside");
        std::os::unix::fs::symlink(outside.path(), vault.path().join("clips")).expect("symlink");
        assert!(reader.create_note("clips/new/Article", "x").is_err());
        assert!(!outside.path().join("new").exists());

        // A dangling link with the note's name is never written through.
        let target = outside.path().join("target.md");
        std::os::unix::fs::symlink(&target, vault.path().join("Note.md")).expect("symlink");
        let created = reader.create_note("Note", "x").expect("create");
        assert!(created.ends_with("Note 2.md"));
        assert!(!target.exists());
    }

    #[test]
    fn vault_dirs_are_validated() {
        let dir = tempdir().expect("dir");
        let file = dir.path().join("file.md");
        fs::write(&file, "x").expect("write");
        assert!(validate_vault_dir(dir.path().to_str().unwrap()).is_ok());
        assert!(validate_vault_dir("relative/vault").is_err());
        assert!(validate_vault_dir("").is_err());
        assert!(validate_vault_dir("/").is_err());
        assert!(validate_vault_dir("/usr").is_err());
        assert!(validate_vault_dir(file.to_str().unwrap()).is_err());
        assert!(validate_vault_dir("/definitely/not/here/xyz").is_err());
    }

    #[test]
    fn read_asset_table() {
        use base64::Engine as _;
        let (vault, _config, reader) = reader_with_vault();
        let outside = tempdir().expect("outside");
        fs::create_dir(vault.path().join("attachments")).expect("mkdir");
        fs::write(vault.path().join("attachments/pic.png"), b"\x89PNG").expect("write");
        fs::write(vault.path().join("attachments/doc.PDF"), b"%PDF").expect("write");
        fs::write(vault.path().join("script.sh"), b"echo").expect("write");
        fs::write(outside.path().join("out.png"), b"png").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), vault.path().join("link")).expect("symlink");

        let asset = reader.read_asset("attachments/pic.png").expect("relative");
        assert_eq!(asset.mime, "image/png");
        assert_eq!(asset.byte_len, 4);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&asset.data_base64)
                .expect("base64"),
            b"\x89PNG"
        );
        let abs = vault.path().join("attachments/doc.PDF");
        assert_eq!(
            reader
                .read_asset(abs.to_str().unwrap())
                .expect("absolute")
                .mime,
            "application/pdf"
        );

        let escape = format!(
            "../{}/out.png",
            outside.path().file_name().unwrap().to_string_lossy()
        );
        let mut rejected = vec![
            escape,
            outside.path().join("out.png").display().to_string(),
            "script.sh".to_owned(),
            "attachments/missing.png".to_owned(),
            "attachments".to_owned(),
            String::new(),
        ];
        #[cfg(unix)]
        rejected.push("link/out.png".to_owned());
        for path in rejected {
            assert!(reader.read_asset(&path).is_err(), "{path} must be rejected");
        }
    }

    #[test]
    fn read_asset_enforces_the_size_cap() {
        let (vault, _config, reader) = reader_with_vault();
        let big = vault.path().join("big.mp4");
        let file = fs::File::create(&big).expect("create");
        file.set_len(MAX_ASSET_BYTES + 1).expect("sparse file");
        let err = reader.read_asset("big.mp4").expect_err("oversize");
        assert!(err.to_string().contains("larger than"));
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
        assert!(graph
            .edges
            .iter()
            .any(|e| e.source == alpha_path && e.target == beta_path));
    }

    #[test]
    fn config_round_trips() {
        let dir = tempdir().expect("temp dir");
        let reader = VaultReader::new(dir.path()).expect("reader");
        assert!(reader.get_config().vault_path.is_none());

        reader.set_vault_path("/tmp/my-vault").expect("set");
        assert_eq!(
            reader.get_config().vault_path,
            Some("/tmp/my-vault".to_owned())
        );
    }

    fn reader_with_vault() -> (tempfile::TempDir, tempfile::TempDir, VaultReader) {
        let vault = tempdir().expect("vault dir");
        let config = tempdir().expect("config dir");
        let reader = VaultReader::new(config.path()).expect("reader");
        reader
            .set_vault_path(vault.path().to_str().unwrap())
            .expect("set vault");
        (vault, config, reader)
    }

    #[test]
    fn sanitize_rel_path_rejects_traversal() {
        assert!(sanitize_rel_path("../evil.md").is_err());
        assert!(sanitize_rel_path("/abs.md").is_err());
        assert!(sanitize_rel_path("a/../../b.md").is_err());
        assert!(sanitize_rel_path(".hidden.md").is_err());
        assert!(sanitize_rel_path("C:/win.md").is_err());
        assert_eq!(
            sanitize_rel_path("clips/My Note").unwrap(),
            "clips/My Note.md"
        );
        assert_eq!(sanitize_rel_path("plain.md").unwrap(), "plain.md");
    }

    #[test]
    fn unique_path_appends_counter() {
        let dir = tempdir().expect("temp dir");
        let p = dir.path().join("note.md");
        assert_eq!(unique_path(&p), p);
        fs::write(&p, "x").expect("write");
        let p2 = unique_path(&p);
        assert_eq!(p2, dir.path().join("note 2.md"));
        fs::write(&p2, "x").expect("write");
        assert_eq!(unique_path(&p), dir.path().join("note 3.md"));
    }

    #[test]
    fn wikilink_matching_is_case_and_alias_aware() {
        assert!(line_matches_wikilink("see [[My Note]]", "my note"));
        assert!(line_matches_wikilink(
            "see [[My Note|alias text]]",
            "my note"
        ));
        assert!(line_matches_wikilink("[[a]] and [[My Note]]", "my note"));
        assert!(!line_matches_wikilink("see [[Other]]", "my note"));
        assert!(!line_matches_wikilink("no link here", "my note"));
    }

    #[test]
    fn write_note_round_trip_and_vault_boundary() {
        let (vault, _config, reader) = reader_with_vault();
        let note = vault.path().join("edit.md");
        fs::write(&note, "old").expect("write");
        let path_str = note.to_str().unwrap().to_string();

        reader.write_note(&path_str, "new content").expect("write");
        assert_eq!(reader.read_note(&path_str).expect("read"), "new content");

        // Outside the vault must be rejected
        let outside = tempdir().expect("outside");
        let evil = outside.path().join("evil.md");
        fs::write(&evil, "x").expect("write");
        assert!(reader.write_note(evil.to_str().unwrap(), "nope").is_err());
    }

    #[test]
    fn create_note_creates_dirs_and_avoids_clobber() {
        let (_vault, _config, reader) = reader_with_vault();
        let p1 = reader
            .create_note("clips/Article", "# Content")
            .expect("create");
        assert!(p1.ends_with("clips/Article.md"));
        assert_eq!(fs::read_to_string(&p1).expect("read"), "# Content");

        let p2 = reader
            .create_note("clips/Article", "# Other")
            .expect("create again");
        assert!(p2.ends_with("clips/Article 2.md"));
    }

    #[test]
    fn append_note_adds_line_with_newline() {
        let (vault, _config, reader) = reader_with_vault();
        let note = vault.path().join("log.md");
        fs::write(&note, "# Log\n").expect("write");
        let path_str = note.to_str().unwrap().to_string();
        reader.append_note(&path_str, "- entry").expect("append");
        assert_eq!(
            reader.read_note(&path_str).expect("read"),
            "# Log\n- entry\n"
        );
    }

    #[test]
    fn backlinks_finds_wikilinks_with_context() {
        let (vault, _config, reader) = reader_with_vault();
        fs::write(vault.path().join("target.md"), "# Target").expect("write");
        fs::write(
            vault.path().join("source.md"),
            "# Source\n\nSee [[Target]] for details.\nAlso [[target|the alias]].\n",
        )
        .expect("write");
        fs::write(vault.path().join("unrelated.md"), "# Nothing here").expect("write");

        let links = reader
            .get_backlinks(vault.path().to_str().unwrap(), "Target")
            .expect("backlinks");
        assert_eq!(links.len(), 2);
        assert!(links.iter().all(|l| l.note_name == "source"));
        assert!(links.iter().any(|l| l.context.contains("[[Target]]")));
        assert!(links.iter().any(|l| l.line == 4));
    }

    #[test]
    fn daily_note_created_and_appended() {
        let (_vault, _config, reader) = reader_with_vault();
        let path = reader
            .get_or_create_daily_note("2026-08-05")
            .expect("daily");
        assert!(path.ends_with("daily/2026-08-05.md"));
        let content = fs::read_to_string(&path).expect("read");
        assert!(content.starts_with("# 2026-08-05"));

        // Second call must not recreate/overwrite
        fs::write(&path, "# 2026-08-05\n\ncustom\n").expect("overwrite");
        let path2 = reader
            .get_or_create_daily_note("2026-08-05")
            .expect("daily2");
        assert_eq!(path, path2);
        assert!(fs::read_to_string(&path2).expect("read").contains("custom"));

        let appended = reader.append_daily_note("hello world").expect("append");
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert!(appended.ends_with(&format!("daily/{today}.md")));
        let daily = fs::read_to_string(&appended).expect("read daily");
        assert!(daily.contains("hello world"));
        assert!(daily.contains("- **"));
    }

    fn set_daily_prefs(config: &Path, folder: &str, pattern: &str) {
        crate::engine::onboarding::OnboardingEngine::new(config)
            .expect("onboarding")
            .set_vault_prefs(VaultPrefs {
                daily_folder: folder.to_owned(),
                daily_filename_pattern: pattern.to_owned(),
            })
            .expect("prefs");
    }

    #[test]
    fn daily_note_defaults_to_daily_folder_without_prefs() {
        let (vault, config, reader) = reader_with_vault();
        assert!(!config.path().join("vault_prefs.json").exists());
        let path = reader
            .get_or_create_daily_note("2026-09-23")
            .expect("daily");
        assert_eq!(
            Path::new(&path),
            vault.path().join("daily").join("2026-09-23.md")
        );
        assert!(reader.get_or_create_daily_note("23.09.2026").is_err());
    }

    #[test]
    fn daily_note_uses_the_configured_folder_and_pattern() {
        let (vault, config, reader) = reader_with_vault();
        set_daily_prefs(config.path(), "Journal/Daily", "DD.MM.YYYY");
        let path = reader
            .get_or_create_daily_note("2026-09-02")
            .expect("daily");
        let expected = vault
            .path()
            .join("Journal")
            .join("Daily")
            .join("02.09.2026.md");
        assert_eq!(Path::new(&path), expected);
        assert!(fs::read_to_string(&expected)
            .expect("read")
            .starts_with("# 2026-09-02"));

        let appended = reader.append_daily_note("captured").expect("append");
        let today = chrono::Local::now().format("%d.%m.%Y").to_string();
        assert_eq!(
            Path::new(&appended),
            vault
                .path()
                .join("Journal")
                .join("Daily")
                .join(format!("{today}.md"))
        );
        assert!(fs::read_to_string(&appended)
            .expect("read")
            .contains("captured"));
    }

    #[test]
    fn nested_daily_pattern_creates_the_folders() {
        let (vault, config, reader) = reader_with_vault();
        set_daily_prefs(config.path(), "", "YYYY/MM/YYYY-MM-DD");
        let path = reader
            .get_or_create_daily_note("2026-01-05")
            .expect("daily");
        let expected = vault.path().join("2026").join("01").join("2026-01-05.md");
        assert_eq!(Path::new(&path), expected);
        assert!(vault.path().join("2026").join("01").is_dir());
        assert!(expected.is_file());
    }
}
