//! Export & publishing engine (roadmap 5.2).
//!
//! Gets knowledge out of the vault in polished, portable form — entirely
//! offline:
//!
//! - [`html`] — Markdown → HTML with the Obsidian-flavoured extensions the
//!   vault uses (wikilinks, embeds, `#tags`, tasks, frontmatter header,
//!   mermaid, syntax highlighting) and the standalone single-note document.
//! - [`pdf`] — the print document behind "Print / Save as PDF…".
//! - [`site`] — a static website: index, note pages, backlinks, tag pages,
//!   client-side search, sitemap.
//! - [`bundle`] — a zip of Markdown notes (+ attachments, optional
//!   wikilink → Markdown link conversion) with a `manifest.json`.
//!
//! This module holds the shared pieces: scope and option types, the
//! [`VaultModel`] (note + attachment index with Obsidian-style link
//! resolution), frontmatter parsing, slugs, output-path safety and the
//! recent-exports store in `<data_dir>/export/recents.json`.

pub mod bundle;
pub mod html;
pub mod pdf;
pub mod site;

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::engine::error::AetherError;
use crate::engine::fs_guard;

/// Event name used for progress updates of long-running exports.
pub const PROGRESS_EVENT: &str = "export-progress";
/// File holding the recent exports list inside the engine directory.
const RECENTS_FILE: &str = "recents.json";
/// Number of recent exports kept.
const MAX_RECENTS: usize = 25;
/// Directories that never contain vault content worth exporting.
const IGNORED_DIRS: &[&str] = &["node_modules"];
/// Upper bound for indexed attachments (protects against huge media trees).
const MAX_ATTACHMENTS: usize = 50_000;
/// Maximum directory depth scanned below the vault root.
const MAX_DEPTH: usize = 32;

// ─────────────────────────────────────────────────────────────────────────
// Public types (shared with the frontend, see `src/types/export.ts`)
// ─────────────────────────────────────────────────────────────────────────

/// What to export. Serialised adjacently tagged:
/// `{ "kind": "note", "value": "/abs/note.md" }`, `{ "kind": "vault" }`, …
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ExportScope {
    /// One note (absolute or vault-relative path).
    Note(String),
    /// Every note below a folder (absolute or vault-relative path).
    Folder(String),
    /// Every note in the vault.
    Vault,
    /// Every note carrying a tag (frontmatter `tags:` or inline `#tag`).
    Tag(String),
    /// An explicit list of notes.
    Selection(Vec<String>),
}

/// Colour scheme of exported HTML.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExportTheme {
    /// Light by default, dark when the reader's OS prefers dark.
    #[default]
    Auto,
    Light,
    Dark,
}

impl ExportTheme {
    /// Value of the `data-theme` attribute in exported documents.
    pub fn as_str(self) -> &'static str {
        match self {
            ExportTheme::Auto => "auto",
            ExportTheme::Light => "light",
            ExportTheme::Dark => "dark",
        }
    }
}

/// Export options. Every field has a default, so `{}` is a valid value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ExportOptions {
    /// Copy (site, bundle) or embed (standalone HTML) referenced attachments.
    pub include_attachments: bool,
    /// Bundle: rewrite `[[wikilinks]]` into standard relative Markdown links.
    pub convert_wikilinks: bool,
    /// Render a "Linked from" section with the notes that link here.
    pub include_backlinks: bool,
    /// Render title, date and tags from the frontmatter in a page header.
    pub include_frontmatter: bool,
    pub theme: ExportTheme,
    /// Site title (defaults to the vault folder name).
    pub site_title: String,
    /// One line shown under the site title on the index page.
    pub site_description: String,
    /// Public URL (or path prefix) the site will be served from; used for
    /// `sitemap.xml`. Empty → no sitemap.
    pub base_path: String,
    /// Custom domain written to a `CNAME` file (GitHub Pages). Empty → none.
    pub cname: String,
    /// Add `<script src="https://cdn.jsdelivr.net/npm/mermaid@11/…">` so
    /// mermaid diagrams render. Off by default: it is the only network
    /// resource an export can reference.
    pub include_mermaid_script: bool,
    /// Allow the destination to be inside the vault (off by default so an
    /// export never ends up indexed as notes).
    pub allow_inside_vault: bool,
    /// Replace an existing output file (HTML page, bundle). Off by default:
    /// a file export never overwrites an existing file unless the user
    /// explicitly confirmed it.
    pub overwrite: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            include_attachments: true,
            convert_wikilinks: true,
            include_backlinks: true,
            include_frontmatter: true,
            theme: ExportTheme::Auto,
            site_title: String::new(),
            site_description: String::new(),
            base_path: String::new(),
            cname: String::new(),
            include_mermaid_script: false,
            allow_inside_vault: false,
            overwrite: false,
        }
    }
}

/// Payload of the `export-progress` event.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ExportProgress {
    pub done: usize,
    pub total: usize,
    /// Item being processed (note title or file name).
    pub current: String,
    /// `"pages"`, `"attachments"`, `"notes"` or `"finishing"`.
    pub phase: String,
}

/// A wikilink that could not be resolved to an exported note.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MissingLink {
    /// Title of the note containing the link.
    pub note: String,
    /// Link target as written.
    pub target: String,
}

/// Result of `cmd_export_note_html`.
#[derive(Debug, Clone, Serialize)]
pub struct NoteExportReport {
    pub path: String,
    pub title: String,
    pub bytes: u64,
    /// Attachments embedded as data URIs.
    pub attachments: usize,
    pub missing_links: usize,
    pub warnings: Vec<String>,
    pub ms: u64,
}

/// Result of `cmd_export_site`.
#[derive(Debug, Clone, Serialize)]
pub struct SiteReport {
    pub out_dir: String,
    pub index_path: String,
    /// Note pages written.
    pub pages: usize,
    pub tag_pages: usize,
    /// Attachments copied.
    pub attachments: usize,
    /// Notes left out because their frontmatter says `publish: false`.
    pub skipped: usize,
    /// Unresolved links (capped at 200 entries, see `missing_link_count`).
    pub missing_links: Vec<MissingLink>,
    pub missing_link_count: usize,
    /// Stale files from a previous export of the same folder that were removed.
    pub removed_stale: usize,
    pub bytes: u64,
    pub warnings: Vec<String>,
    pub ms: u64,
}

/// Result of `cmd_export_bundle`.
#[derive(Debug, Clone, Serialize)]
pub struct BundleReport {
    pub path: String,
    pub notes: usize,
    pub attachments: usize,
    /// Wikilinks rewritten into Markdown links.
    pub converted_links: usize,
    /// Wikilinks whose target is not part of the bundle.
    pub unresolved_links: usize,
    pub bytes: u64,
    pub warnings: Vec<String>,
    pub ms: u64,
}

/// Kind of a recorded export.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExportKind {
    Html,
    Site,
    Bundle,
}

/// One entry of the recent exports list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentExport {
    pub id: String,
    pub kind: ExportKind,
    pub title: String,
    /// Human-readable scope ("Whole vault", "#project", "3 notes", …).
    pub scope_label: String,
    /// Output file or directory.
    pub path: String,
    /// RFC 3339 timestamp.
    pub created_at: String,
    /// Pages / notes written.
    pub items: usize,
    pub bytes: u64,
    /// Whether the output still exists (computed when listing).
    #[serde(default)]
    pub exists: bool,
}

/// A note inside a resolved scope.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScopeNote {
    pub path: String,
    /// Vault-relative path with `/` separators.
    pub rel: String,
    pub title: String,
}

/// Result of `cmd_export_resolve_scope`.
#[derive(Debug, Clone, Serialize)]
pub struct ScopePreview {
    pub total: usize,
    /// First 500 notes of the scope.
    pub notes: Vec<ScopeNote>,
    pub truncated: bool,
    pub label: String,
}

/// A tag and the number of notes carrying it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

// ─────────────────────────────────────────────────────────────────────────
// Vault model
// ─────────────────────────────────────────────────────────────────────────

/// A Markdown note of the vault.
#[derive(Debug, Clone)]
pub struct NoteEntry {
    /// Absolute path below the canonical vault root.
    pub abs: PathBuf,
    /// Vault-relative path with `/` separators, e.g. `01-Projects/Plan.md`.
    pub rel: String,
    /// File stem (`Plan`).
    pub name: String,
    /// Modification time in seconds since the epoch.
    pub mtime: u64,
}

impl NoteEntry {
    /// Vault-relative folder (`""` for the root).
    pub fn folder(&self) -> &str {
        self.rel.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("")
    }
}

/// A non-Markdown file of the vault (image, PDF, …).
#[derive(Debug, Clone)]
pub struct AttachmentEntry {
    pub abs: PathBuf,
    /// Vault-relative path with `/` separators.
    pub rel: String,
    pub size: u64,
}

impl AttachmentEntry {
    /// File name (`sourdough.jpg`).
    pub fn file_name(&self) -> &str {
        self.rel.rsplit('/').next().unwrap_or(&self.rel)
    }
}

/// Index of every note and attachment of a vault with Obsidian-style link
/// resolution. Only regular files are indexed (symlinks are skipped, so an
/// export can never pull in files from outside the vault).
#[derive(Debug)]
pub struct VaultModel {
    /// Canonical vault root.
    pub root: PathBuf,
    /// Notes sorted by `rel` (case-insensitive).
    pub notes: Vec<NoteEntry>,
    pub attachments: Vec<AttachmentEntry>,
    by_rel: HashMap<String, usize>,
    by_name: HashMap<String, Vec<usize>>,
    by_abs: HashMap<PathBuf, usize>,
    att_by_rel: HashMap<String, usize>,
    att_by_name: HashMap<String, Vec<usize>>,
}

impl VaultModel {
    /// Scan the vault at `root`. Hidden files and folders (`.obsidian`,
    /// `.nopes`, `.git`, …) and `node_modules` are skipped.
    pub fn load(root: &Path) -> Result<Self, AetherError> {
        let root = std::fs::canonicalize(root).map_err(|e| {
            AetherError::Vault(format!(
                "vault path is not accessible: {} ({e})",
                root.display()
            ))
        })?;
        if !root.is_dir() {
            return Err(AetherError::Vault(format!(
                "vault path is not a folder: {}",
                root.display()
            )));
        }
        let mut notes = Vec::new();
        let mut attachments = Vec::new();
        let walker = WalkDir::new(&root)
            .max_depth(MAX_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                let name = e.file_name().to_string_lossy();
                let ignored_dir = e.file_type().is_dir() && IGNORED_DIRS.contains(&name.as_ref());
                !(name.starts_with('.') || ignored_dir)
            });
        for entry in walker.filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let abs = entry.path().to_path_buf();
            let Ok(rel_path) = abs.strip_prefix(&root) else {
                continue;
            };
            let rel = rel_path
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            let meta = entry.metadata().ok();
            if rel.to_lowercase().ends_with(".md") {
                let name = rel
                    .rsplit('/')
                    .next()
                    .map(|f| f[..f.len() - 3].to_owned())
                    .unwrap_or_default();
                let mtime = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                notes.push(NoteEntry {
                    abs,
                    rel,
                    name,
                    mtime,
                });
            } else if attachments.len() < MAX_ATTACHMENTS {
                attachments.push(AttachmentEntry {
                    abs,
                    rel,
                    size: meta.map(|m| m.len()).unwrap_or(0),
                });
            }
        }
        Ok(Self::from_entries(root, notes, attachments))
    }

    fn from_entries(
        root: PathBuf,
        mut notes: Vec<NoteEntry>,
        mut attachments: Vec<AttachmentEntry>,
    ) -> Self {
        notes.sort_by_cached_key(|n| n.rel.to_lowercase());
        attachments.sort_by_cached_key(|a| a.rel.to_lowercase());
        let mut by_rel = HashMap::new();
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_abs = HashMap::new();
        for (idx, note) in notes.iter().enumerate() {
            let rel_key = note.rel[..note.rel.len() - 3].to_lowercase();
            by_rel.entry(rel_key).or_insert(idx);
            by_name
                .entry(note.name.to_lowercase())
                .or_default()
                .push(idx);
            by_abs.insert(note.abs.clone(), idx);
        }
        let mut att_by_rel = HashMap::new();
        let mut att_by_name: HashMap<String, Vec<usize>> = HashMap::new();
        for (idx, att) in attachments.iter().enumerate() {
            att_by_rel.entry(att.rel.to_lowercase()).or_insert(idx);
            att_by_name
                .entry(att.file_name().to_lowercase())
                .or_default()
                .push(idx);
        }
        Self {
            root,
            notes,
            attachments,
            by_rel,
            by_name,
            by_abs,
            att_by_rel,
            att_by_name,
        }
    }

    /// Display name of the vault (its folder name).
    pub fn vault_name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Vault".to_owned())
    }

    /// Read a note's content.
    pub fn read(&self, idx: usize) -> Result<String, AetherError> {
        let note = &self.notes[idx];
        std::fs::read_to_string(&note.abs)
            .map_err(|e| AetherError::Vault(format!("failed to read {}: {e}", note.rel)))
    }

    /// Resolve an untrusted UI path (absolute or vault-relative) to a note.
    pub fn note_for_path(&self, path: &str) -> Result<usize, AetherError> {
        let resolved = self.resolve_inside(path)?;
        self.by_abs.get(&resolved).copied().ok_or_else(|| {
            AetherError::InvalidInput(format!("not a Markdown note of the vault: {path}"))
        })
    }

    /// Canonicalise `path` (absolute or relative to the root) and require it
    /// to lie inside the vault.
    fn resolve_inside(&self, path: &str) -> Result<PathBuf, AetherError> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(AetherError::InvalidInput("path is empty".into()));
        }
        let candidate = Path::new(trimmed);
        let joined = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            self.root.join(candidate)
        };
        let canonical = std::fs::canonicalize(&joined)
            .map_err(|_| AetherError::InvalidInput(format!("no such file or folder: {path}")))?;
        if !canonical.starts_with(&self.root) {
            return Err(AetherError::InvalidInput(format!(
                "path is outside the vault: {path}"
            )));
        }
        Ok(canonical)
    }

    /// Resolve a wikilink target (`Note`, `Folder/Note`, `Note.md`) as
    /// Obsidian does: exact vault path, then relative to the linking note,
    /// then by file name — preferring the linking note's folder, then the
    /// shortest path.
    pub fn resolve_note(&self, target: &str, from: Option<usize>) -> Option<usize> {
        let cleaned = percent_decode(target.trim()).replace('\\', "/");
        let cleaned = cleaned.trim_start_matches("./").trim_start_matches('/');
        if cleaned.is_empty() {
            return None;
        }
        let without_ext = if cleaned.to_lowercase().ends_with(".md") {
            &cleaned[..cleaned.len() - 3]
        } else {
            cleaned
        };
        let key = without_ext.to_lowercase();
        let from_folder = from.map(|i| self.notes[i].folder());
        if !key.contains('/') {
            let candidates = self.by_name.get(&key)?;
            if let Some(folder) = from_folder {
                if let Some(same) = candidates
                    .iter()
                    .find(|&&i| self.notes[i].folder() == folder)
                {
                    return Some(*same);
                }
            }
            if let Some(idx) = self.by_rel.get(&key) {
                return Some(*idx);
            }
            return candidates
                .iter()
                .copied()
                .min_by_key(|&i| self.path_rank(i));
        }
        if let Some(folder) = from_folder.filter(|f| !f.is_empty()) {
            if let Some(joined) = normalize_rel(&format!("{folder}/{without_ext}")) {
                if let Some(idx) = self.by_rel.get(&joined.to_lowercase()) {
                    return Some(*idx);
                }
            }
        }
        if let Some(rel) = normalize_rel(&key) {
            if let Some(idx) = self.by_rel.get(&rel) {
                return Some(*idx);
            }
        }
        // `Folder/Note` may also name a note deeper in the tree.
        let name = key.rsplit('/').next().unwrap_or(&key);
        let suffix = format!("/{key}");
        self.by_name
            .get(name)?
            .iter()
            .copied()
            .filter(|&i| {
                let rel = self.notes[i].rel.to_lowercase();
                rel[..rel.len() - 3].ends_with(&suffix)
            })
            .min_by_key(|&i| self.path_rank(i))
    }

    /// Sort key preferring shallow, short paths.
    fn path_rank(&self, idx: usize) -> (usize, usize) {
        let rel = &self.notes[idx].rel;
        (rel.matches('/').count(), rel.len())
    }

    /// Resolve an attachment reference: relative to the linking note, then
    /// as a vault path, then by file name (shortest path wins).
    pub fn resolve_attachment(&self, target: &str, from: Option<usize>) -> Option<usize> {
        let decoded = percent_decode(target.trim());
        let cleaned = decoded.replace('\\', "/");
        let cleaned = cleaned.trim_start_matches("./");
        if cleaned.is_empty() || cleaned.contains("://") || cleaned.starts_with("data:") {
            return None;
        }
        if let Some(from_idx) = from {
            let folder = self.notes[from_idx].folder();
            if !folder.is_empty() {
                if let Some(joined) = normalize_rel(&format!("{folder}/{cleaned}")) {
                    if let Some(idx) = self.att_by_rel.get(&joined.to_lowercase()) {
                        return Some(*idx);
                    }
                }
            }
        }
        if let Some(rel) = normalize_rel(cleaned.trim_start_matches('/')) {
            if let Some(idx) = self.att_by_rel.get(&rel.to_lowercase()) {
                return Some(*idx);
            }
        }
        let name = cleaned.rsplit('/').next().unwrap_or(cleaned).to_lowercase();
        self.att_by_name
            .get(&name)?
            .iter()
            .copied()
            .min_by_key(|&i| {
                (
                    self.attachments[i].rel.matches('/').count(),
                    self.attachments[i].rel.len(),
                )
            })
    }

    /// Resolve a scope to note indices (in vault order).
    pub fn resolve_scope(&self, scope: &ExportScope) -> Result<Vec<usize>, AetherError> {
        let notes = match scope {
            ExportScope::Note(path) => vec![self.note_for_path(path)?],
            ExportScope::Folder(path) => {
                let dir = self.resolve_inside(path)?;
                if !dir.is_dir() {
                    return Err(AetherError::InvalidInput(format!("not a folder: {path}")));
                }
                (0..self.notes.len())
                    .filter(|&i| self.notes[i].abs.starts_with(&dir))
                    .collect()
            }
            ExportScope::Vault => (0..self.notes.len()).collect(),
            ExportScope::Tag(tag) => {
                let wanted = normalize_tag(tag);
                if wanted.is_empty() {
                    return Err(AetherError::InvalidInput("tag is empty".into()));
                }
                let mut hits = Vec::new();
                for idx in 0..self.notes.len() {
                    let Ok(content) = self.read(idx) else {
                        continue;
                    };
                    let tags = note_tags(&content);
                    if tags.iter().any(|t| {
                        let t = normalize_tag(t);
                        t == wanted || t.starts_with(&format!("{wanted}/"))
                    }) {
                        hits.push(idx);
                    }
                }
                hits
            }
            ExportScope::Selection(paths) => {
                if paths.is_empty() {
                    return Err(AetherError::InvalidInput("the selection is empty".into()));
                }
                let mut seen = HashSet::new();
                let mut out = Vec::new();
                for path in paths {
                    let idx = self.note_for_path(path)?;
                    if seen.insert(idx) {
                        out.push(idx);
                    }
                }
                out.sort_unstable();
                out
            }
        };
        if notes.is_empty() {
            return Err(AetherError::InvalidInput(
                "the export scope contains no notes".into(),
            ));
        }
        Ok(notes)
    }

    /// Human-readable description of a scope.
    pub fn describe_scope(&self, scope: &ExportScope, count: usize) -> String {
        match scope {
            ExportScope::Note(path) => self
                .note_for_path(path)
                .map(|i| self.notes[i].name.clone())
                .unwrap_or_else(|_| "Note".to_owned()),
            ExportScope::Folder(path) => {
                let rel = self
                    .resolve_inside(path)
                    .ok()
                    .and_then(|p| {
                        p.strip_prefix(&self.root)
                            .ok()
                            .map(|r| r.to_string_lossy().replace('\\', "/"))
                    })
                    .unwrap_or_default();
                if rel.is_empty() {
                    format!("Whole vault ({count} notes)")
                } else {
                    format!("{rel}/ ({count} notes)")
                }
            }
            ExportScope::Vault => format!("Whole vault ({count} notes)"),
            ExportScope::Tag(tag) => format!("#{} ({count} notes)", normalize_tag(tag)),
            ExportScope::Selection(_) => {
                format!("{count} selected note{}", if count == 1 { "" } else { "s" })
            }
        }
    }

    /// Notes (other than `idx`) whose wikilinks or Markdown links resolve
    /// to `idx`, sorted by name.
    pub fn backlinks_to(&self, idx: usize) -> Vec<usize> {
        let mut out = Vec::new();
        for other in 0..self.notes.len() {
            if other == idx {
                continue;
            }
            let Ok(content) = self.read(other) else {
                continue;
            };
            if extract_wikilinks(&content).iter().any(|l| {
                !l.embed
                    && !l.target.is_empty()
                    && self.resolve_note(&l.target, Some(other)) == Some(idx)
            }) {
                out.push(other);
            }
        }
        out.sort_by_cached_key(|&i| self.notes[i].name.to_lowercase());
        out
    }

    /// All tags of the vault with note counts, most used first.
    pub fn tag_counts(&self) -> Vec<TagCount> {
        let mut counts: HashMap<String, (String, usize)> = HashMap::new();
        for idx in 0..self.notes.len() {
            let Ok(content) = self.read(idx) else {
                continue;
            };
            let mut seen = HashSet::new();
            for tag in note_tags(&content) {
                let key = normalize_tag(&tag);
                if key.is_empty() || !seen.insert(key.clone()) {
                    continue;
                }
                counts
                    .entry(key)
                    .and_modify(|(_, n)| *n += 1)
                    .or_insert((tag.trim_start_matches('#').to_owned(), 1));
            }
        }
        let mut tags: Vec<TagCount> = counts
            .into_values()
            .map(|(tag, count)| TagCount { tag, count })
            .collect();
        tags.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| a.tag.to_lowercase().cmp(&b.tag.to_lowercase()))
        });
        tags
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Frontmatter
// ─────────────────────────────────────────────────────────────────────────

/// The frontmatter fields exports care about.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub title: Option<String>,
    pub date: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    /// `publish: false` excludes a note from site exports.
    pub publish: Option<bool>,
    /// Every `key: value` pair in order (lists joined with `, `).
    pub fields: Vec<(String, String)>,
}

/// Split a leading `---` frontmatter block off `content`. Returns the raw
/// frontmatter (without fences) and the body.
pub fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let rest = if let Some(r) = content.strip_prefix("---\n") {
        r
    } else if let Some(r) = content.strip_prefix("---\r\n") {
        r
    } else {
        return (None, content);
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" || trimmed == "..." {
            let fm = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return (Some(fm.trim_end_matches(['\r', '\n'])), body);
        }
        offset += line.len();
    }
    (None, content)
}

/// Parse YAML-ish frontmatter: `key: value`, inline lists `[a, b]` and
/// block lists (`key:` followed by `- item` lines). Returns the parsed
/// fields and the body without the frontmatter block.
pub fn parse_frontmatter(content: &str) -> (Frontmatter, &str) {
    let (raw, body) = split_frontmatter(content);
    let mut fm = Frontmatter::default();
    let Some(raw) = raw else {
        return (fm, body);
    };
    let mut entries: Vec<(String, Vec<String>)> = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let trimmed = line.trim();
        if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| (trimmed == "-").then_some(""))
        {
            if let Some((_, values)) = entries.last_mut() {
                let v = unquote(item.trim());
                if !v.is_empty() {
                    values.push(v);
                }
            }
            continue;
        }
        if indented {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim().to_owned();
        if key.is_empty() || (key.contains(' ') && key.len() > 40) {
            continue;
        }
        let value = value.trim();
        let values = if value.starts_with('[') && value.ends_with(']') {
            value[1..value.len() - 1]
                .split(',')
                .map(|v| unquote(v.trim()))
                .filter(|v| !v.is_empty())
                .collect()
        } else if value.is_empty() {
            Vec::new()
        } else {
            vec![unquote(value)]
        };
        entries.push((key, values));
    }
    for (key, values) in entries {
        let joined = values.join(", ");
        match key.to_lowercase().as_str() {
            "title" => fm.title = non_empty(&joined),
            "date" | "created" | "published" if fm.date.is_none() => fm.date = non_empty(&joined),
            "description" | "summary" | "excerpt" => fm.description = non_empty(&joined),
            "tags" | "tag" => {
                for v in &values {
                    for part in v.split(|c: char| c == ',' || c.is_whitespace()) {
                        let t = part.trim().trim_start_matches('#');
                        if !t.is_empty() && !fm.tags.iter().any(|x| x == t) {
                            fm.tags.push(t.to_owned());
                        }
                    }
                }
            }
            "aliases" | "alias" => fm.aliases.extend(values.iter().cloned()),
            "publish" => {
                fm.publish = match joined.to_lowercase().as_str() {
                    "false" | "no" | "off" | "0" => Some(false),
                    "true" | "yes" | "on" | "1" => Some(true),
                    _ => None,
                }
            }
            _ => {}
        }
        fm.fields.push((key, joined));
    }
    (fm, body)
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    let stripped = if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
    {
        &v[1..v.len() - 1]
    } else {
        v
    };
    stripped.trim().to_owned()
}

fn non_empty(value: &str) -> Option<String> {
    let v = value.trim();
    (!v.is_empty()).then(|| v.to_owned())
}

// ─────────────────────────────────────────────────────────────────────────
// Prose scanning: wikilinks and tags outside code
// ─────────────────────────────────────────────────────────────────────────

/// Byte ranges of `content` that are Markdown prose: everything except the
/// frontmatter, fenced code blocks and inline code spans. Ranges never
/// cross a line break.
pub fn prose_ranges(content: &str) -> Vec<Range<usize>> {
    let (fm, body) = split_frontmatter(content);
    let mut start = if fm.is_some() {
        content.len() - body.len()
    } else {
        0
    };
    let mut ranges = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    while start < content.len() {
        let end = content[start..]
            .find('\n')
            .map(|i| start + i)
            .unwrap_or(content.len());
        let line = &content[start..end];
        let indent = line.len() - line.trim_start_matches(' ').len();
        let marker = &line[indent..];
        let fence_char = marker.chars().next().filter(|c| *c == '`' || *c == '~');
        let run = fence_char
            .map(|c| marker.chars().take_while(|x| *x == c).count())
            .unwrap_or(0);
        match fence {
            Some((c, len)) => {
                if indent <= 3
                    && fence_char == Some(c)
                    && run >= len
                    && marker[run..].trim().is_empty()
                {
                    fence = None;
                }
            }
            None => {
                if indent <= 3 && run >= 3 {
                    let c = fence_char.unwrap_or('`');
                    // A backtick fence's info string may not contain backticks.
                    if c == '~' || !marker[run..].contains('`') {
                        fence = Some((c, run));
                        start = end + 1;
                        continue;
                    }
                }
                push_inline_prose(content, start, end, &mut ranges);
            }
        }
        start = end + 1;
    }
    ranges
}

/// Split one prose line into ranges outside inline code spans.
fn push_inline_prose(content: &str, start: usize, end: usize, ranges: &mut Vec<Range<usize>>) {
    let bytes = content.as_bytes();
    let mut seg_start = start;
    let mut i = start;
    while i < end {
        if bytes[i] == b'`' {
            let mut run = 0;
            while i + run < end && bytes[i + run] == b'`' {
                run += 1;
            }
            // Find the matching closing run of exactly `run` backticks.
            let mut j = i + run;
            let mut close = None;
            while j < end {
                if bytes[j] == b'`' {
                    let mut r = 0;
                    while j + r < end && bytes[j + r] == b'`' {
                        r += 1;
                    }
                    if r == run {
                        close = Some(j + r);
                        break;
                    }
                    j += r;
                } else {
                    j += 1;
                }
            }
            match close {
                Some(after) => {
                    if seg_start < i {
                        ranges.push(seg_start..i);
                    }
                    seg_start = after;
                    i = after;
                }
                None => i += run,
            }
        } else {
            i += 1;
        }
    }
    if seg_start < end {
        ranges.push(seg_start..end);
    }
}

/// One `[[wikilink]]` / `![[embed]]` occurrence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLink {
    /// Byte range of the whole construct (including `!` for embeds).
    pub range: Range<usize>,
    pub embed: bool,
    /// Link target without heading/alias (`""` for same-note heading links).
    pub target: String,
    /// `#Heading` part (block references `^id` are dropped).
    pub heading: Option<String>,
    /// `|Alias` part (for image embeds this may be a size like `300`).
    pub alias: Option<String>,
}

impl WikiLink {
    /// Text shown for the link: alias, else `Note > Heading`, else target.
    pub fn display(&self) -> String {
        if let Some(alias) = self.alias.as_deref().filter(|a| !a.trim().is_empty()) {
            return alias.trim().to_owned();
        }
        match (&self.heading, self.target.is_empty()) {
            (Some(h), true) => h.clone(),
            (Some(h), false) => format!("{} > {h}", self.target),
            (None, _) => self.target.clone(),
        }
    }
}

/// Parse the inside of `[[…]]` (without brackets).
pub fn parse_wikilink_inner(inner: &str) -> (String, Option<String>, Option<String>) {
    let unescaped = inner.replace("\\|", "|");
    let (link, alias) = match unescaped.split_once('|') {
        Some((l, a)) => (l.to_owned(), Some(a.to_owned())),
        None => (unescaped.clone(), None),
    };
    let (target, heading) = match link.split_once('#') {
        Some((t, h)) => {
            let h = h.trim();
            let heading = if h.starts_with('^') || h.is_empty() {
                None
            } else {
                Some(h.split("#^").next().unwrap_or(h).trim().to_owned())
            };
            (t.trim().to_owned(), heading)
        }
        None => (link.trim().to_owned(), None),
    };
    (target, heading, alias)
}

/// Find wikilinks in a slice of prose (`offset` = its position in the note).
pub fn wikilinks_in(text: &str, offset: usize) -> Vec<WikiLink> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(pos) = text[search..].find("[[") {
        let open = search + pos;
        if open > 0 && text.as_bytes()[open - 1] == b'\\' {
            search = open + 2;
            continue;
        }
        let Some(close_rel) = text[open + 2..].find("]]") else {
            break;
        };
        let inner = &text[open + 2..open + 2 + close_rel];
        let end = open + 2 + close_rel + 2;
        if inner.is_empty() || inner.contains('[') || inner.contains(']') {
            search = open + 2;
            continue;
        }
        let embed = open > 0 && text.as_bytes()[open - 1] == b'!';
        let start = if embed { open - 1 } else { open };
        let (target, heading, alias) = parse_wikilink_inner(inner);
        if target.is_empty() && heading.is_none() {
            search = end;
            continue;
        }
        out.push(WikiLink {
            range: offset + start..offset + end,
            embed,
            target,
            heading,
            alias,
        });
        search = end;
    }
    out
}

/// Every wikilink of a note outside code and frontmatter.
pub fn extract_wikilinks(content: &str) -> Vec<WikiLink> {
    prose_ranges(content)
        .into_iter()
        .flat_map(|r| wikilinks_in(&content[r.clone()], r.start))
        .collect()
}

/// Inline `#tags` of a slice of prose, in order. A tag must contain a
/// letter (`#42` is an issue reference) and follow whitespace, `(` or the
/// start of the text; headings (`# Title`) never match.
pub fn inline_tags(text: &str) -> Vec<(Range<usize>, String)> {
    let mut out = Vec::new();
    let mut prev: Option<char> = None;
    let mut iter = text.char_indices().peekable();
    while let Some((i, c)) = iter.next() {
        let boundary = matches!(prev, None | Some(' ' | '\t' | '(' | '[' | ',' | ';' | '\n'));
        if c == '#' && boundary {
            let rest = &text[i + 1..];
            let len: usize = rest
                .char_indices()
                .take_while(|(_, ch)| ch.is_alphanumeric() || matches!(ch, '_' | '-' | '/'))
                .map(|(_, ch)| ch.len_utf8())
                .sum();
            let raw = rest[..len].trim_end_matches(['/', '-']);
            if !raw.is_empty()
                && raw.chars().any(|ch| ch.is_alphabetic())
                && raw
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_alphanumeric() || ch == '_')
            {
                out.push((i..i + 1 + raw.len(), raw.to_owned()));
                // Skip past the tag.
                while iter.peek().is_some_and(|(j, _)| *j < i + 1 + raw.len()) {
                    prev = iter.next().map(|(_, ch)| ch);
                }
                continue;
            }
        }
        prev = Some(c);
    }
    out
}

/// Frontmatter tags plus inline `#tags` of a note, de-duplicated in order.
pub fn note_tags(content: &str) -> Vec<String> {
    let (fm, _) = parse_frontmatter(content);
    let mut tags = fm.tags;
    for range in prose_ranges(content) {
        let line = &content[range];
        if line.trim_start().starts_with('#')
            && line
                .trim_start()
                .chars()
                .nth(1)
                .is_some_and(|c| c == ' ' || c == '#')
        {
            continue;
        }
        for (_, tag) in inline_tags(line) {
            if !tags.iter().any(|t| normalize_tag(t) == normalize_tag(&tag)) {
                tags.push(tag);
            }
        }
    }
    tags
}

/// Canonical form used to compare tags (Obsidian compares case-insensitively).
pub fn normalize_tag(tag: &str) -> String {
    tag.trim().trim_start_matches('#').to_lowercase()
}

// ─────────────────────────────────────────────────────────────────────────
// Slugs, anchors, URL helpers
// ─────────────────────────────────────────────────────────────────────────

/// Transliterate common Latin letters with diacritics to ASCII.
fn transliterate(c: char) -> Option<&'static str> {
    Some(match c {
        'ä' | 'æ' => "ae",
        'ö' | 'œ' => "oe",
        'ü' => "ue",
        'ß' => "ss",
        'à' | 'á' | 'â' | 'ã' | 'å' | 'ā' | 'ą' => "a",
        'ç' | 'č' | 'ć' => "c",
        'ď' | 'đ' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' => "e",
        'ì' | 'í' | 'î' | 'ï' | 'ī' => "i",
        'ł' => "l",
        'ñ' | 'ń' | 'ň' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ø' | 'ō' => "o",
        'ř' => "r",
        'š' | 'ś' => "s",
        'ť' => "t",
        'ù' | 'ú' | 'û' | 'ū' | 'ů' => "u",
        'ý' | 'ÿ' => "y",
        'ž' | 'ź' | 'ż' => "z",
        _ => return None,
    })
}

/// URL-safe page slug: lowercase, German/Latin diacritics transliterated
/// (`Über` → `ueber`), other Unicode letters and digits kept, every other
/// run of characters collapsed into one `-`. Never empty (`note`), at most
/// 80 characters.
pub fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for c in input.chars().flat_map(char::to_lowercase) {
        let piece: Option<String> = if let Some(t) = transliterate(c) {
            Some(t.to_owned())
        } else if c.is_alphanumeric() {
            Some(c.to_string())
        } else {
            None
        };
        match piece {
            Some(p) => {
                if pending_dash && !out.is_empty() {
                    out.push('-');
                }
                pending_dash = false;
                out.push_str(&p);
            }
            None => pending_dash = true,
        }
    }
    if out.chars().count() > 80 {
        out = out.chars().take(80).collect();
        out = out.trim_end_matches('-').to_owned();
    }
    if out.is_empty() {
        "note".to_owned()
    } else {
        out
    }
}

/// `base`, or `base-2`, `base-3`, … — whichever is not in `used` yet
/// (compared case-insensitively). The returned slug is added to `used`.
pub fn unique_slug(base: &str, used: &mut HashSet<String>) -> String {
    let mut candidate = base.to_owned();
    let mut n = 2;
    while used.contains(&candidate.to_lowercase()) {
        candidate = format!("{base}-{n}");
        n += 1;
    }
    used.insert(candidate.to_lowercase());
    candidate
}

/// GitHub-compatible heading anchor: lowercase, keep letters, digits,
/// `-` and `_`, spaces become `-`, everything else is dropped.
pub fn heading_anchor(text: &str) -> String {
    text.trim()
        .chars()
        .flat_map(char::to_lowercase)
        .filter_map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                Some(c)
            } else if c == ' ' {
                Some('-')
            } else {
                None
            }
        })
        .collect()
}

/// Percent-encode a relative URL path (keeps `/`, unreserved characters).
pub fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Decode `%XX` escapes (invalid sequences are kept verbatim).
pub fn percent_decode(input: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_owned())
}

/// Collapse `.`/`..` in a `/`-separated relative path. `None` when it
/// would escape the root.
pub fn normalize_rel(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    Some(parts.join("/"))
}

/// Relative path from the folder `from_dir` to `to` (both vault-relative,
/// `/`-separated).
pub fn relative_path(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = from_dir.split('/').filter(|p| !p.is_empty()).collect();
    let target: Vec<&str> = to.split('/').filter(|p| !p.is_empty()).collect();
    let common = from
        .iter()
        .zip(target.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut parts: Vec<&str> = std::iter::repeat("..").take(from.len() - common).collect();
    parts.extend(&target[common..]);
    parts.join("/")
}

/// Escape text for HTML element content and attribute values.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────
// Output paths
// ─────────────────────────────────────────────────────────────────────────

/// Validate an output path chosen in the UI: it must be absolute, its
/// parent folder must exist, and — unless `allow_inside_vault` — it must not
/// lie inside the vault (an export there would be indexed as notes).
/// Returns the path with a canonical parent.
pub fn check_output_path(
    out: &str,
    vault_root: &Path,
    allow_inside_vault: bool,
) -> Result<PathBuf, AetherError> {
    let trimmed = out.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty() || !path.is_absolute() {
        return Err(AetherError::InvalidInput(format!(
            "choose an absolute destination path (got \"{trimmed}\")"
        )));
    }
    let file_name = path
        .file_name()
        .filter(|n| *n != std::ffi::OsStr::new("..") && *n != std::ffi::OsStr::new("."))
        .ok_or_else(|| AetherError::InvalidInput(format!("invalid destination: {trimmed}")))?;
    let parent = path
        .parent()
        .ok_or_else(|| AetherError::InvalidInput(format!("invalid destination: {trimmed}")))?;
    let parent = std::fs::canonicalize(parent).map_err(|_| {
        AetherError::InvalidInput(format!(
            "destination folder does not exist: {}",
            parent.display()
        ))
    })?;
    let resolved = parent.join(file_name);
    let resolved = if resolved.exists() {
        std::fs::canonicalize(&resolved)?
    } else {
        resolved
    };
    if fs_guard::has_git_component(&resolved) || fs_guard::is_system_location(&parent) {
        return Err(AetherError::InvalidInput(format!(
            "the destination cannot be inside a .git or system folder: {}",
            resolved.display()
        )));
    }
    let vault = std::fs::canonicalize(vault_root).unwrap_or_else(|_| vault_root.to_path_buf());
    if resolved == vault {
        return Err(AetherError::InvalidInput(
            "the destination cannot be the vault folder itself".into(),
        ));
    }
    if resolved.starts_with(&vault) && !allow_inside_vault {
        return Err(AetherError::InvalidInput(format!(
            "the destination {} is inside the vault; exported files would show up as notes. Choose a folder outside the vault or enable \"Allow export into the vault\"",
            resolved.display()
        )));
    }
    if resolved.parent().is_none() {
        return Err(AetherError::InvalidInput(
            "the destination cannot be a filesystem root".into(),
        ));
    }
    Ok(resolved)
}

/// Validate the output *file* of an HTML page or bundle export. `.ext` is
/// appended first (so the checks see the final name), then
/// [`check_output_path`] applies; the destination must not contain `.`/`..`,
/// be a folder or a symbolic link, and an existing file is only replaced
/// when `overwrite` is set.
pub fn check_output_file(
    out: &str,
    ext: &str,
    vault_root: &Path,
    allow_inside_vault: bool,
    overwrite: bool,
) -> Result<PathBuf, AetherError> {
    let trimmed = out.trim();
    let raw = Path::new(trimmed);
    if raw
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(AetherError::InvalidInput(format!(
            "the destination must not contain '.' or '..': {trimmed}"
        )));
    }
    let wanted = with_extension(raw.to_path_buf(), ext);
    // Look at the final component itself (check_output_path would follow a
    // symlink): writing through a link could replace a file elsewhere.
    if let (Some(parent), Some(name)) = (wanted.parent(), wanted.file_name()) {
        if let Ok(parent) = std::fs::canonicalize(parent) {
            if std::fs::symlink_metadata(parent.join(name))
                .is_ok_and(|m| m.file_type().is_symlink())
            {
                return Err(AetherError::InvalidInput(format!(
                    "the destination is a symbolic link: {}",
                    wanted.display()
                )));
            }
        }
    }
    let resolved = check_output_path(&wanted.to_string_lossy(), vault_root, allow_inside_vault)?;
    match std::fs::symlink_metadata(&resolved) {
        Ok(meta) if meta.is_dir() => Err(AetherError::InvalidInput(format!(
            "the destination is a folder: {}",
            resolved.display()
        ))),
        Ok(_) if !overwrite => Err(AetherError::InvalidInput(format!(
            "{} already exists. Choose another name or confirm replacing it (overwrite)",
            resolved.display()
        ))),
        _ => Ok(resolved),
    }
}

/// Ensure `path` ends with `.ext` (case-insensitive), appending it if not.
pub fn with_extension(path: PathBuf, ext: &str) -> PathBuf {
    let has = path
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case(ext))
        .unwrap_or(false);
    if has {
        path
    } else {
        let mut s = path.into_os_string();
        s.push(format!(".{ext}"));
        PathBuf::from(s)
    }
}

/// Throttles progress callbacks to roughly 25 per second (the last one is
/// always delivered).
pub struct ProgressThrottle<'a> {
    callback: &'a (dyn Fn(ExportProgress) + Sync),
    last: std::time::Instant,
    first: bool,
}

impl<'a> ProgressThrottle<'a> {
    pub fn new(callback: &'a (dyn Fn(ExportProgress) + Sync)) -> Self {
        Self {
            callback,
            last: std::time::Instant::now(),
            first: true,
        }
    }

    /// Report progress; skipped when the previous report was < 40 ms ago,
    /// unless `done == total`.
    pub fn report(&mut self, done: usize, total: usize, current: &str, phase: &str) {
        let now = std::time::Instant::now();
        if self.first || done >= total || now.duration_since(self.last).as_millis() >= 40 {
            self.first = false;
            self.last = now;
            (self.callback)(ExportProgress {
                done,
                total,
                current: current.to_owned(),
                phase: phase.to_owned(),
            });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Engine: recents + safe "open" targets
// ─────────────────────────────────────────────────────────────────────────

/// Keeps the recent exports list and decides which paths the UI may open.
pub struct ExportEngine {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl ExportEngine {
    /// Create the engine, storing its data in `dir` (`<data_dir>/export`).
    pub fn new(dir: &Path) -> Result<Self, AetherError> {
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            lock: Mutex::new(()),
        })
    }

    fn recents_path(&self) -> PathBuf {
        self.dir.join(RECENTS_FILE)
    }

    fn read_recents(&self) -> Vec<RecentExport> {
        std::fs::read_to_string(self.recents_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<RecentExport>>(&s).ok())
            .unwrap_or_default()
    }

    fn write_recents(&self, recents: &[RecentExport]) -> Result<(), AetherError> {
        let json = serde_json::to_string_pretty(recents)
            .map_err(|e| AetherError::InvalidInput(format!("recents serialize: {e}")))?;
        let tmp = self.dir.join(format!("{RECENTS_FILE}.tmp"));
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, self.recents_path())?;
        Ok(())
    }

    /// Recent exports, newest first, with `exists` refreshed.
    pub fn list_recent(&self) -> Vec<RecentExport> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        self.read_recents()
            .into_iter()
            .map(|mut r| {
                r.exists = Path::new(&r.path).exists();
                r
            })
            .collect()
    }

    /// Record a finished export (replacing an older entry for the same
    /// output) and return the stored entry.
    pub fn record(
        &self,
        kind: ExportKind,
        title: &str,
        scope_label: &str,
        path: &Path,
        items: usize,
        bytes: u64,
    ) -> Result<RecentExport, AetherError> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let entry = RecentExport {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            title: title.to_owned(),
            scope_label: scope_label.to_owned(),
            path: path.to_string_lossy().to_string(),
            created_at: chrono::Local::now().to_rfc3339(),
            items,
            bytes,
            exists: true,
        };
        let mut recents = self.read_recents();
        recents.retain(|r| !(r.path == entry.path && r.kind == entry.kind));
        recents.insert(0, entry.clone());
        recents.truncate(MAX_RECENTS);
        self.write_recents(&recents)?;
        Ok(entry)
    }

    /// Forget all recent exports (the exported files stay on disk).
    pub fn clear_recent(&self) -> Result<(), AetherError> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        self.write_recents(&[])
    }

    /// Validate a path the UI wants to open or reveal. Only outputs of
    /// recorded exports (and files inside exported sites) are allowed, and
    /// `open` (not `reveal`) is restricted to folders and HTML files, so the
    /// command can never launch an arbitrary program.
    pub fn resolve_open_target(&self, path: &str, reveal: bool) -> Result<PathBuf, AetherError> {
        let target = std::fs::canonicalize(path.trim())
            .map_err(|_| AetherError::InvalidInput(format!("no such file or folder: {path}")))?;
        let allowed = self.list_recent().iter().any(|r| {
            let Ok(out) = std::fs::canonicalize(&r.path) else {
                return false;
            };
            target == out || (r.kind == ExportKind::Site && target.starts_with(&out))
        });
        if !allowed {
            return Err(AetherError::InvalidInput(format!(
                "only exported files can be opened: {path}"
            )));
        }
        if !reveal && target.is_file() {
            let ext = target
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if ext != "html" && ext != "htm" {
                return Err(AetherError::InvalidInput(format!(
                    "only HTML files and folders can be opened directly: {path}"
                )));
            }
        }
        Ok(target)
    }
}

/// Open a file/folder with the default application, or reveal it in the
/// platform file manager.
pub fn open_path(path: &Path, reveal: bool) -> Result<(), AetherError> {
    let mut cmd;
    #[cfg(target_os = "macos")]
    {
        cmd = std::process::Command::new("open");
        if reveal {
            cmd.arg("-R");
        }
        cmd.arg(path);
    }
    #[cfg(target_os = "windows")]
    {
        cmd = std::process::Command::new("explorer");
        if reveal {
            cmd.arg(format!("/select,{}", path.display()));
        } else {
            cmd.arg(path);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        cmd = std::process::Command::new("xdg-open");
        let target = if reveal && path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        cmd.arg(target);
    }
    cmd.spawn().map(|_| ()).map_err(|e| {
        AetherError::Io(std::io::Error::other(format!(
            "failed to open {}: {e}",
            path.display()
        )))
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::fs;
    use std::path::Path;

    /// Write `content` to `root/rel`, creating folders.
    pub fn write(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(path, content).expect("write");
    }

    /// Write raw bytes to `root/rel`, creating folders.
    pub fn write_bytes(root: &Path, rel: &str, content: &[u8]) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(path, content).expect("write");
    }

    /// A small vault exercising every link flavour.
    pub fn sample_vault(root: &Path) {
        write(
            root,
            "Welcome.md",
            "---\ntitle: Welcome Home\ntags: [start, meta]\ndate: 2026-09-01\n---\n# Welcome\n\nSee [[Projects/Alpha|the alpha]] and [[Beta#Setup]].\nMissing: [[Ghost]]. #inbox\n\n![[diagram.png]]\n\n- [ ] open task\n- [x] done task\n\n```rust\nfn main() { let x = \"[[NotALink]]\"; }\n```\n\n```mermaid\ngraph TD; A-->B;\n```\n",
        );
        write(
            root,
            "Projects/Alpha.md",
            "# Alpha\n\nBack to [[Welcome]]. Uses `[[code link]]` inline. #project/alpha\n",
        );
        write(
            root,
            "Beta.md",
            "# Beta\n\n## Setup\n\nLinks [[Alpha]] and [[welcome]].\n",
        );
        write(
            root,
            "Über Größe.md",
            "---\npublish: false\n---\nPrivate note linking [[Welcome]].\n",
        );
        write_bytes(
            root,
            "assets/diagram.png",
            &[0x89, b'P', b'N', b'G', 0, 1, 2, 3],
        );
        write(root, ".obsidian/workspace.md", "hidden");
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn loads_notes_and_attachments_skipping_hidden() {
        let dir = tempdir().expect("dir");
        sample_vault(dir.path());
        let model = VaultModel::load(dir.path()).expect("model");
        let rels: Vec<&str> = model.notes.iter().map(|n| n.rel.as_str()).collect();
        assert_eq!(
            rels,
            vec![
                "Beta.md",
                "Projects/Alpha.md",
                "Welcome.md",
                "Über Größe.md"
            ]
        );
        assert_eq!(model.attachments.len(), 1);
        assert_eq!(model.attachments[0].rel, "assets/diagram.png");
        assert!(model.notes.iter().all(|n| !n.rel.contains(".obsidian")));
    }

    #[test]
    fn resolves_wikilinks_like_obsidian() {
        let dir = tempdir().expect("dir");
        sample_vault(dir.path());
        write(dir.path(), "Projects/Beta.md", "# Nested beta");
        let model = VaultModel::load(dir.path()).expect("model");
        let find = |rel: &str| model.notes.iter().position(|n| n.rel == rel).expect(rel);
        let welcome = find("Welcome.md");
        let alpha = find("Projects/Alpha.md");
        assert_eq!(
            model.resolve_note("Projects/Alpha", Some(welcome)),
            Some(alpha)
        );
        assert_eq!(model.resolve_note("alpha", Some(welcome)), Some(alpha));
        assert_eq!(model.resolve_note("Alpha.md", None), Some(alpha));
        assert_eq!(model.resolve_note("Ghost", None), None);
        // Same-folder candidates win over shorter paths.
        assert_eq!(
            model.resolve_note("Beta", Some(alpha)),
            Some(find("Projects/Beta.md"))
        );
        assert_eq!(
            model.resolve_note("Beta", Some(welcome)),
            Some(find("Beta.md"))
        );
        assert_eq!(
            model.resolve_attachment("diagram.png", Some(welcome)),
            Some(0)
        );
        assert_eq!(
            model.resolve_attachment("assets/diagram.png", None),
            Some(0)
        );
        assert_eq!(model.resolve_attachment("https://x.io/a.png", None), None);
    }

    #[test]
    fn resolves_scopes_and_rejects_escapes() {
        let dir = tempdir().expect("dir");
        sample_vault(dir.path());
        let model = VaultModel::load(dir.path()).expect("model");
        assert_eq!(
            model
                .resolve_scope(&ExportScope::Vault)
                .expect("vault")
                .len(),
            4
        );
        let folder = model
            .resolve_scope(&ExportScope::Folder("Projects".into()))
            .expect("folder");
        assert_eq!(folder.len(), 1);
        let tag = model
            .resolve_scope(&ExportScope::Tag("#project".into()))
            .expect("tag");
        assert_eq!(model.notes[tag[0]].rel, "Projects/Alpha.md");
        let meta = model
            .resolve_scope(&ExportScope::Tag("META".into()))
            .expect("fm tag");
        assert_eq!(model.notes[meta[0]].rel, "Welcome.md");
        let abs = dir.path().join("Beta.md").to_string_lossy().to_string();
        let sel = model
            .resolve_scope(&ExportScope::Selection(vec![
                abs.clone(),
                abs,
                "Welcome.md".into(),
            ]))
            .expect("selection");
        assert_eq!(sel.len(), 2);

        let outside = tempdir().expect("outside");
        write(outside.path(), "evil.md", "x");
        let evil = outside.path().join("evil.md").to_string_lossy().to_string();
        assert!(model.resolve_scope(&ExportScope::Note(evil)).is_err());
        assert!(model
            .resolve_scope(&ExportScope::Note("../../etc/passwd".into()))
            .is_err());
        assert!(model
            .resolve_scope(&ExportScope::Selection(vec![]))
            .is_err());
        assert!(model
            .resolve_scope(&ExportScope::Tag("nothing-here".into()))
            .is_err());
    }

    #[test]
    fn scope_serialises_adjacently_tagged() {
        let json = serde_json::to_string(&ExportScope::Note("/a.md".into())).expect("json");
        assert_eq!(json, r#"{"kind":"note","value":"/a.md"}"#);
        let vault: ExportScope = serde_json::from_str(r#"{"kind":"vault"}"#).expect("vault");
        assert_eq!(vault, ExportScope::Vault);
        let sel: ExportScope =
            serde_json::from_str(r#"{"kind":"selection","value":["a","b"]}"#).expect("sel");
        assert_eq!(sel, ExportScope::Selection(vec!["a".into(), "b".into()]));
        let opts: ExportOptions = serde_json::from_str("{}").expect("defaults");
        assert_eq!(opts, ExportOptions::default());
        let themed: ExportOptions = serde_json::from_str(r#"{"theme":"dark"}"#).expect("theme");
        assert_eq!(themed.theme, ExportTheme::Dark);
    }

    #[test]
    fn parses_frontmatter_variants() {
        let content = "---\ntitle: \"My Note\"\ntags:\n  - rust\n  - '#async'\ndate: 2026-01-02\naliases: [One, Two]\npublish: no\ncustom: value: with colon\n---\nBody here\n";
        let (fm, body) = parse_frontmatter(content);
        assert_eq!(fm.title.as_deref(), Some("My Note"));
        assert_eq!(fm.tags, vec!["rust", "async"]);
        assert_eq!(fm.date.as_deref(), Some("2026-01-02"));
        assert_eq!(fm.aliases, vec!["One", "Two"]);
        assert_eq!(fm.publish, Some(false));
        assert!(fm
            .fields
            .iter()
            .any(|(k, v)| k == "custom" && v == "value: with colon"));
        assert_eq!(body, "Body here\n");

        let (inline, _) = parse_frontmatter("---\ntags: a, b #c\n---\n");
        assert_eq!(inline.tags, vec!["a", "b", "c"]);
        let (none, body) = parse_frontmatter("# No frontmatter\n---\n");
        assert_eq!(none, Frontmatter::default());
        assert_eq!(body, "# No frontmatter\n---\n");
        let (_, unterminated) = parse_frontmatter("---\ntitle: x\nno end");
        assert_eq!(unterminated, "---\ntitle: x\nno end");
    }

    #[test]
    fn prose_ranges_skip_code_and_frontmatter() {
        let content = "---\ntags: [x]\n---\nA [[One]] `[[Two]]` B\n```\n[[Three]]\n```\n~~~~\n```\n[[Four]]\n~~~~\n[[Five]]";
        let links: Vec<String> = extract_wikilinks(content)
            .into_iter()
            .map(|l| l.target)
            .collect();
        assert_eq!(links, vec!["One", "Five"]);
    }

    #[test]
    fn parses_wikilink_parts() {
        let links = wikilinks_in(
            "[[A]] ![[img.png|300]] [[B#Head|Alias]] [[#Local]] [[C#^block]] \\[[esc]] [[D\\|x]]",
            0,
        );
        assert_eq!(links.len(), 6);
        assert_eq!(links[0].display(), "A");
        assert!(links[1].embed);
        assert_eq!(links[1].alias.as_deref(), Some("300"));
        assert_eq!(links[2].heading.as_deref(), Some("Head"));
        assert_eq!(links[2].display(), "Alias");
        assert_eq!(links[3].target, "");
        assert_eq!(links[3].display(), "Local");
        assert_eq!(links[4].heading, None);
        assert_eq!(links[5].target, "D");
        assert_eq!(links[5].alias.as_deref(), Some("x"));
        assert_eq!(
            WikiLink {
                heading: Some("H".into()),
                ..links[0].clone()
            }
            .display(),
            "A > H"
        );
    }

    #[test]
    fn finds_inline_tags() {
        let tags: Vec<String> =
            inline_tags("#start text #multi/level (#paren) a#no #42 #v2 #über-cool,")
                .into_iter()
                .map(|(_, t)| t)
                .collect();
        assert_eq!(
            tags,
            vec!["start", "multi/level", "paren", "v2", "über-cool"]
        );
        let content = "---\ntags: [fm]\n---\n# Heading #not\nText #inline and `#code`\n";
        assert_eq!(note_tags(content), vec!["fm", "inline"]);
    }

    #[test]
    fn slugs_are_unicode_aware_and_unique() {
        assert_eq!(slugify("Über Größe & Co."), "ueber-groesse-co");
        assert_eq!(slugify("  Hello,   World!  "), "hello-world");
        assert_eq!(slugify("日本語 メモ"), "日本語-メモ");
        assert_eq!(slugify("Crème brûlée"), "creme-brulee");
        assert_eq!(slugify("???"), "note");
        assert_eq!(slugify(&"a".repeat(200)).len(), 80);
        let mut used = HashSet::new();
        assert_eq!(unique_slug("readme", &mut used), "readme");
        assert_eq!(unique_slug("README", &mut used), "README-2");
        assert_eq!(unique_slug("readme", &mut used), "readme-3");
    }

    #[test]
    fn anchors_and_paths() {
        assert_eq!(heading_anchor("Hello, World!"), "hello-world");
        assert_eq!(heading_anchor("Über uns"), "über-uns");
        assert_eq!(heading_anchor("A & B"), "a--b");
        assert_eq!(relative_path("a/b", "a/c/d.md"), "../c/d.md");
        assert_eq!(relative_path("", "x/y.md"), "x/y.md");
        assert_eq!(relative_path("x", "y.md"), "../y.md");
        assert_eq!(normalize_rel("a/./b/../c"), Some("a/c".into()));
        assert_eq!(normalize_rel("../x"), None);
        assert_eq!(encode_path("a b/ü.png"), "a%20b/%C3%BC.png");
        assert_eq!(percent_decode("a%20b%C3%BC"), "a bü");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(
            escape_html("<a href=\"x\">&'"),
            "&lt;a href=&quot;x&quot;&gt;&amp;&#39;"
        );
    }

    /// Table: good path, existing file without / with `overwrite`, `..`
    /// path, folder, symlink escape.
    #[test]
    fn output_files_never_overwrite_without_the_flag() {
        let vault = tempdir().expect("vault");
        let out = tempdir().expect("out");
        let dir = std::fs::canonicalize(out.path()).expect("canonical");
        std::fs::write(dir.join("taken.html"), "old").expect("write");
        std::fs::create_dir(dir.join("folder.html")).expect("mkdir");
        let check = |p: &Path, overwrite: bool| {
            check_output_file(&p.to_string_lossy(), "html", vault.path(), false, overwrite)
        };
        assert_eq!(
            check(&dir.join("new"), false).expect("new"),
            dir.join("new.html")
        );
        let err = check(&dir.join("taken.html"), false).expect_err("exists");
        assert!(err.to_string().contains("already exists"));
        assert!(
            check(&dir.join("taken"), false).is_err(),
            "extension is added first"
        );
        assert_eq!(
            check(&dir.join("taken.html"), true).expect("overwrite"),
            dir.join("taken.html")
        );
        assert!(check(&dir.join("sub/../new.html"), false).is_err());
        assert!(check(&dir.join("folder.html"), true).is_err());
        #[cfg(unix)]
        {
            let target = vault.path().join("note.md.html");
            std::fs::write(&target, "keep").expect("write");
            std::os::unix::fs::symlink(&target, dir.join("link.html")).expect("symlink");
            assert!(check(&dir.join("link.html"), true).is_err());
            assert_eq!(std::fs::read_to_string(&target).expect("read"), "keep");
        }
    }

    #[test]
    fn output_paths_outside_vault_only_by_default() {
        let vault = tempdir().expect("vault");
        let out = tempdir().expect("out");
        let inside = vault
            .path()
            .join("export.html")
            .to_string_lossy()
            .to_string();
        let err = check_output_path(&inside, vault.path(), false).expect_err("inside vault");
        assert!(err.to_string().contains("inside the vault"));
        assert!(check_output_path(&inside, vault.path(), true).is_ok());
        let vault_itself = vault.path().to_string_lossy().to_string();
        assert!(check_output_path(&vault_itself, vault.path(), true).is_err());
        assert!(check_output_path("relative/out.html", vault.path(), false).is_err());
        let missing_parent = out
            .path()
            .join("nope/out.html")
            .to_string_lossy()
            .to_string();
        assert!(check_output_path(&missing_parent, vault.path(), false).is_err());
        let ok = out.path().join("out.html").to_string_lossy().to_string();
        let resolved = check_output_path(&ok, vault.path(), false).expect("ok");
        assert!(resolved.ends_with("out.html"));
        std::fs::create_dir(out.path().join(".git")).expect("mkdir");
        let in_git = out.path().join(".git/out").to_string_lossy().to_string();
        assert!(check_output_path(&in_git, vault.path(), false).is_err());
        assert_eq!(
            with_extension(PathBuf::from("/a/b"), "zip"),
            PathBuf::from("/a/b.zip")
        );
        assert_eq!(
            with_extension(PathBuf::from("/a/b.ZIP"), "zip"),
            PathBuf::from("/a/b.ZIP")
        );
    }

    #[test]
    fn recents_round_trip_and_open_rules() {
        let data = tempdir().expect("data");
        let out = tempdir().expect("out");
        let engine = ExportEngine::new(&data.path().join("export")).expect("engine");
        assert!(engine.list_recent().is_empty());

        let site = out.path().join("site");
        fs_write(&site.join("index.html"), "<html>");
        fs_write(&site.join("run.sh"), "echo");
        let page = out.path().join("page.html");
        fs_write(&page, "<html>");
        let zip = out.path().join("b.zip");
        fs_write(&zip, "PK");

        engine
            .record(ExportKind::Site, "Site", "Whole vault", &site, 3, 10)
            .expect("record");
        engine
            .record(ExportKind::Html, "Page", "Note", &page, 1, 5)
            .expect("record");
        engine
            .record(ExportKind::Bundle, "Zip", "Note", &zip, 1, 5)
            .expect("record");
        engine
            .record(ExportKind::Html, "Page again", "Note", &page, 1, 6)
            .expect("dedupe");
        let recents = engine.list_recent();
        assert_eq!(recents.len(), 3);
        assert_eq!(recents[0].title, "Page again");
        assert!(recents.iter().all(|r| r.exists));

        let s = |p: &Path| p.to_string_lossy().to_string();
        assert!(engine
            .resolve_open_target(&s(&site.join("index.html")), false)
            .is_ok());
        assert!(engine.resolve_open_target(&s(&site), false).is_ok());
        assert!(engine.resolve_open_target(&s(&page), false).is_ok());
        assert!(engine.resolve_open_target(&s(&zip), true).is_ok());
        assert!(
            engine.resolve_open_target(&s(&zip), false).is_err(),
            "zip must not be opened"
        );
        assert!(engine
            .resolve_open_target(&s(&site.join("run.sh")), false)
            .is_err());
        assert!(engine
            .resolve_open_target(&s(&site.join("run.sh")), true)
            .is_ok());
        assert!(
            engine.resolve_open_target(&s(out.path()), true).is_err(),
            "not an export"
        );
        assert!(engine.resolve_open_target("/etc/hosts", true).is_err());

        std::fs::remove_file(&page).expect("rm");
        assert!(!engine.list_recent()[0].exists);
        engine.clear_recent().expect("clear");
        assert!(engine.list_recent().is_empty());
    }

    fn fs_write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, content).expect("write");
    }

    #[test]
    fn backlinks_and_tag_counts() {
        let dir = tempdir().expect("dir");
        sample_vault(dir.path());
        let model = VaultModel::load(dir.path()).expect("model");
        let welcome = model
            .notes
            .iter()
            .position(|n| n.rel == "Welcome.md")
            .expect("w");
        let names: Vec<&str> = model
            .backlinks_to(welcome)
            .into_iter()
            .map(|i| model.notes[i].name.as_str())
            .collect();
        assert_eq!(names, vec!["Alpha", "Beta", "Über Größe"]);
        let tags = model.tag_counts();
        assert!(tags
            .iter()
            .any(|t| t.tag == "project/alpha" && t.count == 1));
        assert!(tags.iter().any(|t| t.tag == "start"));
        assert!(!tags.iter().any(|t| t.tag == "NotALink"));
    }

    #[test]
    fn throttle_always_delivers_first_and_last() {
        let seen = Mutex::new(Vec::new());
        let cb = |p: ExportProgress| seen.lock().expect("lock").push(p.done);
        let mut throttle = ProgressThrottle::new(&cb);
        for i in 0..=100 {
            throttle.report(i, 100, "x", "pages");
        }
        let seen = seen.into_inner().expect("inner");
        assert_eq!(seen.first(), Some(&0));
        assert_eq!(seen.last(), Some(&100));
        assert!(seen.len() < 10);
    }
}
