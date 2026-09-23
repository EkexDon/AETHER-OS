//! Universal search index (launcher + Search view).
//!
//! One SQLite FTS5 index at `<data_dir>/search/index.db` holds vault notes,
//! projects, project files, memory facts, AI conversations, calendar events,
//! tasks and installed applications. Queries fuse three rankings with
//! reciprocal-rank fusion — BM25 keyword hits, fuzzy title matches and
//! (optionally) semantic vector hits — and boost results the user opens
//! often and recently (frecency, `<data_dir>/search/recents.json`).
//!
//! Module layout: `store` (SQLite/FTS5), `sources` (indexers), `text`
//! (query building, snippets, Markdown), `fuzzy`, `fusion` (RRF),
//! `frecency` (recents), `apps` (macOS app discovery), `settings`.

pub mod apps;
pub mod frecency;
pub mod fusion;
pub mod fuzzy;
pub mod settings;
pub mod sources;
pub mod store;
pub mod text;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::engine::calendar::Calendar;
use crate::engine::error::AetherError;
use crate::engine::memory_store::MemoryStore;
use crate::engine::task_board::TaskBoardEngine;
use crate::engine::vault_reader::VaultReader;

use apps::AppEntry;
use frecency::{frecency_boost, RecentEntry, RecentsStore};
use fusion::{reciprocal_rank_fusion, RankedList, RRF_K};
use settings::{SearchSettings, SettingsStore};
use store::{DocRow, IndexDoc, IndexStore};

/// Minimum time between two lazy vault re-scans triggered by queries.
pub const VAULT_RESCAN_INTERVAL: Duration = Duration::from_secs(10);
/// How long the discovered application list is cached.
pub const APPS_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
/// Hard cap of results per query.
pub const MAX_LIMIT: usize = 500;
/// Semantic neighbours below this cosine similarity are not fused in.
pub const SEMANTIC_MIN_SCORE: f32 = 0.25;

/// Everything the index can hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchKind {
    Note,
    Project,
    File,
    App,
    Event,
    Task,
    Memory,
    Conversation,
}

impl SearchKind {
    /// Every kind, in indexing order.
    pub fn all() -> Vec<SearchKind> {
        vec![
            SearchKind::Note,
            SearchKind::Project,
            SearchKind::File,
            SearchKind::Memory,
            SearchKind::Conversation,
            SearchKind::Event,
            SearchKind::Task,
            SearchKind::App,
        ]
    }

    /// Stable lowercase name (also the `kind` column and the id prefix).
    pub fn as_str(self) -> &'static str {
        match self {
            SearchKind::Note => "note",
            SearchKind::Project => "project",
            SearchKind::File => "file",
            SearchKind::App => "app",
            SearchKind::Event => "event",
            SearchKind::Task => "task",
            SearchKind::Memory => "memory",
            SearchKind::Conversation => "conversation",
        }
    }

    /// Parse a kind name as sent by the UI.
    pub fn parse(name: &str) -> Option<SearchKind> {
        SearchKind::all()
            .into_iter()
            .find(|k| k.as_str() == name.trim())
    }
}

/// Parse a list of kind names, rejecting unknown ones.
pub fn parse_kinds(names: &[String]) -> Result<Vec<SearchKind>, AetherError> {
    let mut kinds = Vec::new();
    for name in names {
        let kind = SearchKind::parse(name)
            .ok_or_else(|| AetherError::InvalidInput(format!("unknown search kind: {name}")))?;
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    Ok(kinds)
}

/// One search result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub kind: SearchKind,
    pub title: String,
    pub subtitle: String,
    /// Filesystem path for notes, files, projects and apps; empty otherwise.
    pub path: String,
    /// Escaped text with `<mark>…</mark>` around matches — safe to render.
    pub snippet_html: String,
    /// Relative relevance in `(0, 1]` (1 = best hit of this query).
    pub score: f64,
    /// Unix seconds (0 when unknown).
    pub updated_at: i64,
    /// Kind-specific data (`project_id`, `date`, `bundle_id`, …).
    pub extra: serde_json::Value,
    /// Which retrievers found the hit: `keyword`, `fuzzy`, `semantic`.
    pub matched: Vec<String>,
}

/// A semantic (vector) match fed into the fusion: note path + similarity.
#[derive(Debug, Clone, PartialEq)]
pub struct SemanticMatch {
    pub note_path: String,
    pub score: f32,
    /// The indexed note text (used for a snippet when FTS has none).
    pub text: String,
}

/// A query against the index.
#[derive(Debug, Clone, Default)]
pub struct SearchRequest {
    /// Raw query; a leading `#` searches tags only.
    pub query: String,
    /// Restrict to these kinds (intersected with the enabled kinds).
    pub kinds: Option<Vec<SearchKind>>,
    pub limit: usize,
    /// Cap per kind (keeps one kind from crowding out the others).
    pub per_kind: Option<usize>,
    /// Semantic hits to fuse in (empty when semantic search is off).
    pub semantic: Vec<SemanticMatch>,
}

/// Per-kind outcome of an indexing run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KindReport {
    pub kind: SearchKind,
    /// Documents of this kind after the run.
    pub count: usize,
    /// Inserted or updated documents.
    pub changed: usize,
    /// Deleted documents.
    pub removed: usize,
    pub ms: u64,
    /// A file cap was hit (files only).
    pub truncated: bool,
    /// Why this kind could not be indexed (the others still were).
    pub error: Option<String>,
}

/// Outcome of `cmd_search_reindex`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IndexReport {
    pub kinds: Vec<KindReport>,
    /// Documents across the reported kinds.
    pub total: usize,
    pub ms: u64,
}

/// A recent result, resolved against the index where possible.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentHit {
    pub id: String,
    pub kind: String,
    pub title: Option<String>,
    pub count: u32,
    pub last_used: i64,
    pub frecency: f64,
    /// The indexed item, for kinds the index holds (`None` for commands,
    /// bookmarks and clipboard items, which the UI resolves itself).
    pub hit: Option<SearchHit>,
}

/// Documents per kind.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KindCount {
    pub kind: String,
    pub count: usize,
}

/// Index health for the settings page and status displays.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchStatus {
    pub counts: Vec<KindCount>,
    pub total: usize,
    /// Unix seconds of the last completed full indexing run.
    pub last_indexed_at: Option<i64>,
    pub indexing: bool,
    /// The global shortcut that is currently registered, if any.
    pub shortcut: Option<String>,
    /// Why the configured global shortcut could not be registered.
    pub shortcut_error: Option<String>,
}

/// Where an indexing run reads its data from.
pub struct IndexSources<'a> {
    /// Vault reader and root; `None` when no vault is configured.
    pub vault: Option<(&'a VaultReader, String)>,
    /// Configured project directories (parents of projects).
    pub project_dirs: Vec<PathBuf>,
    pub memory: &'a MemoryStore,
    pub calendar: &'a Calendar,
    pub tasks: &'a TaskBoardEngine,
    /// Folders scanned for `.app` bundles.
    pub app_roots: Vec<PathBuf>,
}

#[derive(Default)]
struct TitleCache {
    loaded: bool,
    rows: Vec<(String, SearchKind, String)>,
}

/// Discovered applications with the time and roots they were read from.
struct CachedApps {
    at: Instant,
    roots: Vec<PathBuf>,
    apps: Vec<AppEntry>,
}

#[derive(Default)]
struct ShortcutState {
    registered: Option<String>,
    error: Option<String>,
}

/// Clears the `indexing` flag when an indexing run ends (also on panic).
struct IndexingGuard<'a>(&'a AtomicBool);

impl Drop for IndexingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// The search engine held in `AppState`.
pub struct SearchIndex {
    store: IndexStore,
    recents: RecentsStore,
    settings: SettingsStore,
    titles: RwLock<TitleCache>,
    apps_cache: Mutex<Option<CachedApps>>,
    last_vault_scan: Mutex<Option<Instant>>,
    vault_lock: Mutex<()>,
    reindex_lock: Mutex<()>,
    indexing: AtomicBool,
    shortcut: Mutex<ShortcutState>,
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Signature of a file version: modification time (ms) and size.
fn file_signature(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Some(format!("{mtime}:{}", meta.len()))
}

/// Escaped plain snippet of `text` centred on the first query-term match,
/// with every word-prefix occurrence of a term wrapped in `<mark>`.
pub fn highlight_plain(text: &str, terms: &[String], max_chars: usize) -> String {
    let collapsed = text::collapse_whitespace(&text::strip_sentinels(text));
    let chars: Vec<char> = collapsed.chars().collect();
    let lower: Vec<char> = chars
        .iter()
        .map(|c| c.to_lowercase().next().unwrap_or(*c))
        .collect();
    let term_chars: Vec<Vec<char>> = terms
        .iter()
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().collect())
        .collect();
    let starts_word = |i: usize| i == 0 || !chars[i - 1].is_alphanumeric();
    let matches_at = |i: usize| -> Option<usize> {
        if !starts_word(i) {
            return None;
        }
        term_chars
            .iter()
            .filter(|t| i + t.len() <= lower.len() && lower[i..i + t.len()] == t[..])
            .map(|t| t.len())
            .max()
    };
    let first = (0..lower.len()).find(|&i| matches_at(i).is_some());
    let start = match first {
        Some(i) if i > max_chars / 3 => {
            // Start the window at a word boundary a little before the match.
            let mut s = i - max_chars / 4;
            while s < i && !starts_word(s) {
                s += 1;
            }
            s
        }
        _ => 0,
    };
    let end = (start + max_chars).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    let mut i = start;
    let mut plain = String::new();
    while i < end {
        if let Some(len) = matches_at(i) {
            let stop = (i + len).min(end);
            out.push_str(&text::escape_html(&plain));
            plain.clear();
            let word: String = chars[i..stop].iter().collect();
            out.push_str("<mark>");
            out.push_str(&text::escape_html(&word));
            out.push_str("</mark>");
            i = stop;
        } else {
            plain.push(chars[i]);
            i += 1;
        }
    }
    out.push_str(&text::escape_html(&plain));
    if end < chars.len() {
        out.push('…');
    }
    out
}

impl SearchIndex {
    /// Open the index in `dir` (`<data_dir>/search`).
    pub fn new(dir: &Path) -> Result<Self, AetherError> {
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            store: IndexStore::open(&dir.join("index.db"))?,
            recents: RecentsStore::open(&dir.join("recents.json")),
            settings: SettingsStore::open(&dir.join("settings.json")),
            titles: RwLock::new(TitleCache::default()),
            apps_cache: Mutex::new(None),
            last_vault_scan: Mutex::new(None),
            vault_lock: Mutex::new(()),
            reindex_lock: Mutex::new(()),
            indexing: AtomicBool::new(false),
            shortcut: Mutex::new(ShortcutState::default()),
        })
    }

    // ── Settings ──

    /// Current settings.
    pub fn settings(&self) -> SearchSettings {
        self.settings.get()
    }

    /// Validate and persist new settings; returns the normalised value.
    pub fn set_settings(&self, settings: SearchSettings) -> Result<SearchSettings, AetherError> {
        self.settings.set(settings)
    }

    /// Remember which global shortcut is registered (or why it is not).
    pub fn set_shortcut_state(&self, registered: Option<String>, error: Option<String>) {
        let mut state = lock(&self.shortcut);
        state.registered = registered;
        state.error = error;
    }

    /// The currently registered global shortcut.
    pub fn registered_shortcut(&self) -> Option<String> {
        lock(&self.shortcut).registered.clone()
    }

    // ── Indexing ──

    fn invalidate_titles(&self) {
        let mut cache = self.titles.write().unwrap_or_else(|e| e.into_inner());
        cache.loaded = false;
        cache.rows.clear();
    }

    /// Replace all documents of `kind`.
    pub fn sync_kind(
        &self,
        kind: SearchKind,
        docs: &[IndexDoc],
    ) -> Result<store::SyncStats, AetherError> {
        let stats = self.store.sync_kind(kind, docs)?;
        if stats.changed > 0 || stats.removed > 0 {
            self.invalidate_titles();
        }
        Ok(stats)
    }

    /// Incrementally index the vault: only notes whose modification time or
    /// size changed are re-read (through [`VaultReader`]); deleted notes are
    /// removed. `force` re-reads every note.
    pub fn sync_vault(
        &self,
        reader: &VaultReader,
        vault_root: &str,
        force: bool,
    ) -> Result<KindReport, AetherError> {
        let _guard = lock(&self.vault_lock);
        self.sync_vault_locked(reader, vault_root, force)
    }

    fn sync_vault_locked(
        &self,
        reader: &VaultReader,
        vault_root: &str,
        force: bool,
    ) -> Result<KindReport, AetherError> {
        let started = Instant::now();
        let notes = reader.scan_vault(vault_root)?;
        let known = self.store.signatures(SearchKind::Note)?;
        let mut live: HashSet<String> = HashSet::with_capacity(notes.len());
        let mut changed_docs = Vec::new();
        for note in &notes {
            let id = format!("note:{}", note.path);
            let sig = file_signature(Path::new(&note.path)).unwrap_or_default();
            let unchanged = !force && known.get(&id).is_some_and(|s| !s.is_empty() && *s == sig);
            live.insert(id);
            if unchanged {
                continue;
            }
            let Ok(content) = reader.read_note(&note.path) else {
                continue;
            };
            changed_docs.push(sources::note_doc(
                &note.path,
                &note.name,
                note.mtime as i64,
                sig,
                &content,
                vault_root,
            ));
        }
        let stale: Vec<String> = known.into_keys().filter(|id| !live.contains(id)).collect();
        let changed = self.store.upsert(&changed_docs)?;
        let removed = self.store.delete_ids(&stale)?;
        if changed > 0 || removed > 0 {
            self.invalidate_titles();
        }
        *lock(&self.last_vault_scan) = Some(Instant::now());
        Ok(KindReport {
            kind: SearchKind::Note,
            count: live.len(),
            changed,
            removed,
            ms: started.elapsed().as_millis() as u64,
            truncated: false,
            error: None,
        })
    }

    /// Re-scan the vault when the last scan is older than
    /// [`VAULT_RESCAN_INTERVAL`] (cheap: an mtime walk; only changed notes
    /// are read). Skips silently while another vault sync is running.
    /// Returns the report when a scan happened.
    pub fn maybe_sync_vault(
        &self,
        reader: &VaultReader,
        vault_root: &str,
    ) -> Result<Option<KindReport>, AetherError> {
        if !self.settings().includes(SearchKind::Note) {
            return Ok(None);
        }
        let due =
            lock(&self.last_vault_scan).map_or(true, |at| at.elapsed() >= VAULT_RESCAN_INTERVAL);
        if !due {
            return Ok(None);
        }
        let Ok(_guard) = self.vault_lock.try_lock() else {
            return Ok(None);
        };
        self.sync_vault_locked(reader, vault_root, false).map(Some)
    }

    /// Installed applications, cached for [`APPS_CACHE_TTL`] per root set.
    pub fn apps(&self, roots: &[PathBuf], force: bool) -> Vec<AppEntry> {
        let mut cache = lock(&self.apps_cache);
        if let Some(cached) = cache.as_ref() {
            if !force && cached.at.elapsed() < APPS_CACHE_TTL && cached.roots == roots {
                return cached.apps.clone();
            }
        }
        let apps = apps::discover_apps(roots);
        *cache = Some(CachedApps {
            at: Instant::now(),
            roots: roots.to_vec(),
            apps: apps.clone(),
        });
        apps
    }

    /// Is a full indexing run in progress?
    pub fn is_indexing(&self) -> bool {
        self.indexing.load(Ordering::SeqCst)
    }

    /// Index `kinds` (all when empty) from `sources`. Disabled kinds are
    /// purged instead. Runs are serialised; a failing kind is reported and
    /// the others continue. `progress` is called after every kind.
    pub fn reindex(
        &self,
        sources: &IndexSources<'_>,
        kinds: &[SearchKind],
        force: bool,
        progress: &mut dyn FnMut(&KindReport),
    ) -> IndexReport {
        let _run = lock(&self.reindex_lock);
        self.indexing.store(true, Ordering::SeqCst);
        let _flag = IndexingGuard(&self.indexing);
        let started = Instant::now();
        let settings = self.settings();
        let requested: Vec<SearchKind> = if kinds.is_empty() {
            SearchKind::all()
        } else {
            kinds.to_vec()
        };

        let needs_projects = requested
            .iter()
            .any(|k| matches!(k, SearchKind::Project | SearchKind::File));
        let projects = if needs_projects {
            sources::discover_projects(&sources.project_dirs)
        } else {
            Vec::new()
        };

        let mut reports = Vec::new();
        for kind in requested {
            let kind_started = Instant::now();
            let result: Result<KindReport, AetherError> = if !settings.includes(kind) {
                self.sync_kind(kind, &[]).map(|s| KindReport {
                    kind,
                    count: 0,
                    changed: 0,
                    removed: s.removed,
                    ms: 0,
                    truncated: false,
                    error: None,
                })
            } else {
                self.index_kind(kind, sources, &settings, &projects, force)
            };
            let report = match result {
                Ok(mut r) => {
                    r.ms = kind_started.elapsed().as_millis() as u64;
                    r
                }
                Err(e) => KindReport {
                    kind,
                    count: 0,
                    changed: 0,
                    removed: 0,
                    ms: kind_started.elapsed().as_millis() as u64,
                    truncated: false,
                    error: Some(e.to_string()),
                },
            };
            progress(&report);
            reports.push(report);
        }
        let _ = self
            .store
            .set_meta("last_indexed_at", &now_secs().to_string());
        IndexReport {
            total: reports.iter().map(|r| r.count).sum(),
            ms: started.elapsed().as_millis() as u64,
            kinds: reports,
        }
    }

    fn index_kind(
        &self,
        kind: SearchKind,
        sources: &IndexSources<'_>,
        settings: &SearchSettings,
        projects: &[sources::ProjectInfo],
        force: bool,
    ) -> Result<KindReport, AetherError> {
        let simple = |stats: store::SyncStats| KindReport {
            kind,
            count: stats.total,
            changed: stats.changed,
            removed: stats.removed,
            ms: 0,
            truncated: false,
            error: None,
        };
        match kind {
            SearchKind::Note => match &sources.vault {
                Some((reader, root)) => self.sync_vault(reader, root, force),
                None => self.sync_kind(kind, &[]).map(simple),
            },
            SearchKind::Project => {
                let docs: Vec<IndexDoc> = projects.iter().map(sources::project_doc).collect();
                self.sync_kind(kind, &docs).map(simple)
            }
            SearchKind::File => {
                let roots: Vec<PathBuf> = if settings.file_roots.is_empty() {
                    projects.iter().map(|p| p.path.clone()).collect()
                } else {
                    settings.file_roots.iter().map(PathBuf::from).collect()
                };
                let walk = sources::walk_files(&roots, sources::MAX_FILES);
                self.sync_kind(kind, &walk.docs).map(|s| KindReport {
                    truncated: walk.truncated,
                    ..simple(s)
                })
            }
            SearchKind::Memory => {
                let facts = sources.memory.load_facts()?;
                let docs: Vec<IndexDoc> = facts.iter().map(sources::memory_doc).collect();
                self.sync_kind(kind, &docs).map(simple)
            }
            SearchKind::Conversation => {
                let conversations = sources.memory.load_recent(5_000)?;
                let docs: Vec<IndexDoc> = conversations
                    .iter()
                    .map(sources::conversation_doc)
                    .collect();
                self.sync_kind(kind, &docs).map(simple)
            }
            SearchKind::Event => {
                let events = sources.calendar.list()?;
                let docs: Vec<IndexDoc> = events.iter().map(sources::event_doc).collect();
                self.sync_kind(kind, &docs).map(simple)
            }
            SearchKind::Task => {
                let projects = sources.tasks.list_projects()?;
                let tasks = sources.tasks.list_tasks(None)?;
                let docs: Vec<IndexDoc> = tasks
                    .iter()
                    .map(|t| sources::task_doc(t, &projects))
                    .collect();
                self.sync_kind(kind, &docs).map(simple)
            }
            SearchKind::App => {
                let apps = self.apps(&sources.app_roots, force);
                let docs: Vec<IndexDoc> = apps.iter().map(sources::app_doc).collect();
                self.sync_kind(kind, &docs).map(simple)
            }
        }
    }

    // ── Querying ──

    fn title_rows(&self) -> Result<Vec<(String, SearchKind, String)>, AetherError> {
        {
            let cache = self.titles.read().unwrap_or_else(|e| e.into_inner());
            if cache.loaded {
                return Ok(cache.rows.clone());
            }
        }
        let rows: Vec<(String, SearchKind, String)> = self
            .store
            .titles()?
            .into_iter()
            .filter_map(|(id, kind, title)| SearchKind::parse(&kind).map(|k| (id, k, title)))
            .collect();
        let mut cache = self.titles.write().unwrap_or_else(|e| e.into_inner());
        cache.rows = rows.clone();
        cache.loaded = true;
        Ok(rows)
    }

    fn effective_kinds(&self, requested: Option<&[SearchKind]>) -> Vec<SearchKind> {
        let enabled = self.settings().kinds;
        match requested {
            Some(kinds) if !kinds.is_empty() => kinds
                .iter()
                .copied()
                .filter(|k| enabled.contains(k))
                .collect(),
            _ => enabled,
        }
    }

    /// Run a query: BM25 keyword hits, fuzzy title matches and semantic
    /// hits fused with RRF, boosted by frecency, capped per kind and in
    /// total. An empty query returns no hits (the UI shows recents).
    pub fn query(&self, request: &SearchRequest) -> Result<Vec<SearchHit>, AetherError> {
        let raw = request.query.trim();
        let kinds = self.effective_kinds(request.kinds.as_deref());
        if raw.is_empty() || kinds.is_empty() {
            return Ok(Vec::new());
        }
        let limit = request.limit.clamp(1, MAX_LIMIT);
        let fetch = (limit * 3).clamp(30, 900);
        let tag_query = raw.strip_prefix('#');
        let terms = text::query_terms(tag_query.unwrap_or(raw));
        if terms.is_empty() {
            return Ok(Vec::new());
        }

        // 1. Keyword (BM25).
        let expr = match tag_query {
            Some(tag) => text::fts_tag_expr(tag),
            None => text::fts_match_expr(raw),
        };
        let fts_rows = match expr {
            Some(expr) => self.store.search(&expr, &kinds, fetch)?,
            None => Vec::new(),
        };
        let keyword_ids: Vec<String> = fts_rows.iter().map(|r| r.doc.id.clone()).collect();

        // 2. Fuzzy titles (not for tag queries).
        let mut fuzzy_ids: Vec<String> = Vec::new();
        if tag_query.is_none() {
            let mut scored: Vec<(f64, String)> = self
                .title_rows()?
                .into_iter()
                .filter(|(_, kind, _)| kinds.contains(kind))
                .filter_map(|(id, _, title)| fuzzy::fuzzy_score(raw, &title).map(|s| (s, id)))
                .collect();
            scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            fuzzy_ids = scored
                .into_iter()
                .take(fetch / 2)
                .map(|(_, id)| id)
                .collect();
        }

        // 3. Semantic (notes only).
        let semantic_ids: Vec<String> = if tag_query.is_none() && kinds.contains(&SearchKind::Note)
        {
            request
                .semantic
                .iter()
                .filter(|m| m.score >= SEMANTIC_MIN_SCORE)
                .map(|m| format!("note:{}", m.note_path))
                .collect()
        } else {
            Vec::new()
        };

        let fused = reciprocal_rank_fusion(
            &[
                RankedList {
                    ids: &keyword_ids,
                    weight: 1.0,
                },
                RankedList {
                    ids: &fuzzy_ids,
                    weight: 0.9,
                },
                RankedList {
                    ids: &semantic_ids,
                    weight: 1.0,
                },
            ],
            RRF_K,
        );

        let frecency = self.recents.frecency_map(now_secs());
        let mut ranked: Vec<(String, f64)> = fused
            .into_iter()
            .map(|(id, score)| {
                let boost = frecency_boost(frecency.get(&id).copied().unwrap_or(0.0));
                (id, score * boost)
            })
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));

        // Materialise rows: FTS rows carry snippets, the rest are fetched.
        let fts_by_id: HashMap<&str, &store::FtsRow> =
            fts_rows.iter().map(|r| (r.doc.id.as_str(), r)).collect();
        let keyword_set: HashSet<&str> = keyword_ids.iter().map(String::as_str).collect();
        let fuzzy_set: HashSet<&str> = fuzzy_ids.iter().map(String::as_str).collect();
        let semantic_by_id: HashMap<String, &SemanticMatch> = request
            .semantic
            .iter()
            .map(|m| (format!("note:{}", m.note_path), m))
            .collect();

        let per_kind = request.per_kind.unwrap_or(usize::MAX).max(1);
        let mut per_kind_counts: HashMap<String, usize> = HashMap::new();
        let mut selected: Vec<(String, f64)> = Vec::new();
        let mut missing: Vec<String> = Vec::new();
        let kind_of = |id: &str| id.split(':').next().unwrap_or("").to_owned();
        for (id, score) in ranked {
            let kind = kind_of(&id);
            let count = per_kind_counts.entry(kind).or_insert(0);
            if *count >= per_kind {
                continue;
            }
            *count += 1;
            if !fts_by_id.contains_key(id.as_str()) {
                missing.push(id.clone());
            }
            selected.push((id, score));
            if selected.len() >= limit {
                break;
            }
        }
        let fetched = self.store.get_many(&missing)?;
        let top = selected
            .first()
            .map(|(_, s)| *s)
            .unwrap_or(1.0)
            .max(f64::MIN_POSITIVE);

        let mut hits = Vec::with_capacity(selected.len());
        for (id, score) in selected {
            let (doc, snippet_html): (&DocRow, String) = if let Some(row) =
                fts_by_id.get(id.as_str())
            {
                let snippet = text::render_snippet(&row.snippet);
                let only_title = text::strip_sentinels(&row.snippet).trim() == row.doc.title.trim();
                let snippet = if only_title && !row.doc.body_prefix.trim().is_empty() {
                    highlight_plain(&row.doc.body_prefix, &terms, 180)
                } else {
                    snippet
                };
                (&row.doc, snippet)
            } else if let Some(doc) = fetched.get(&id) {
                let source = semantic_by_id
                    .get(&id)
                    .map(|m| text::markdown_to_plain(&m.text))
                    .unwrap_or_else(|| doc.body_prefix.clone());
                (doc, highlight_plain(&source, &terms, 180))
            } else {
                // Semantic hit for a note the keyword index does not know
                // (yet); skip rather than show a half-empty row.
                continue;
            };
            let Some(kind) = SearchKind::parse(&doc.kind) else {
                continue;
            };
            let mut matched = Vec::new();
            if keyword_set.contains(id.as_str()) {
                matched.push("keyword".to_owned());
            }
            if fuzzy_set.contains(id.as_str()) {
                matched.push("fuzzy".to_owned());
            }
            if semantic_by_id.contains_key(&id) {
                matched.push("semantic".to_owned());
            }
            hits.push(SearchHit {
                id: doc.id.clone(),
                kind,
                title: doc.title.clone(),
                subtitle: doc.subtitle.clone(),
                path: doc.path.clone(),
                snippet_html,
                score: ((score / top) * 1000.0).round() / 1000.0,
                updated_at: doc.updated_at,
                extra: serde_json::from_str(&doc.extra).unwrap_or(serde_json::Value::Null),
                matched,
            });
        }
        Ok(hits)
    }

    // ── Recents ──

    /// Record that the user opened a result.
    pub fn record_recent(
        &self,
        id: &str,
        kind: &str,
        title: Option<String>,
    ) -> Result<RecentEntry, AetherError> {
        self.recents.record(id, kind, title, now_secs())
    }

    /// Recent results (most recent first), resolved against the index.
    /// Entries of indexed kinds whose document no longer exists are dropped.
    pub fn recent_hits(&self, limit: usize) -> Result<Vec<RecentHit>, AetherError> {
        let now = now_secs();
        let entries = self.recents.list();
        let indexed_ids: Vec<String> = entries
            .iter()
            .filter(|e| SearchKind::parse(&e.kind).is_some())
            .map(|e| e.id.clone())
            .collect();
        let docs = self.store.get_many(&indexed_ids)?;
        let mut out = Vec::new();
        for entry in entries {
            let hit = match SearchKind::parse(&entry.kind) {
                Some(kind) => match docs.get(&entry.id) {
                    Some(doc) => Some(SearchHit {
                        id: doc.id.clone(),
                        kind,
                        title: doc.title.clone(),
                        subtitle: doc.subtitle.clone(),
                        path: doc.path.clone(),
                        snippet_html: String::new(),
                        score: 1.0,
                        updated_at: doc.updated_at,
                        extra: serde_json::from_str(&doc.extra).unwrap_or(serde_json::Value::Null),
                        matched: Vec::new(),
                    }),
                    None => continue,
                },
                None => None,
            };
            out.push(RecentHit {
                frecency: frecency::frecency(&entry, now),
                id: entry.id,
                kind: entry.kind,
                title: entry.title,
                count: entry.count,
                last_used: entry.last_used,
                hit,
            });
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    /// Forget all recents.
    pub fn clear_recents(&self) -> Result<(), AetherError> {
        self.recents.clear()
    }

    // ── Status ──

    /// Document counts, last run and shortcut state.
    pub fn status(&self) -> Result<SearchStatus, AetherError> {
        let counts: Vec<KindCount> = self
            .store
            .counts()?
            .into_iter()
            .map(|(kind, count)| KindCount { kind, count })
            .collect();
        let shortcut = lock(&self.shortcut);
        Ok(SearchStatus {
            total: counts.iter().map(|c| c.count).sum(),
            counts,
            last_indexed_at: self
                .store
                .meta("last_indexed_at")?
                .and_then(|v| v.parse().ok()),
            indexing: self.is_indexing(),
            shortcut: shortcut.registered.clone(),
            shortcut_error: shortcut.error.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::memory_store::ChatMessageRecord;

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        index: SearchIndex,
        reader: VaultReader,
        vault: PathBuf,
        memory: MemoryStore,
        calendar: Calendar,
        tasks: TaskBoardEngine,
    }

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        std::fs::write(path, content).expect("write");
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().to_path_buf();
        let vault = root.join("vault");
        write(
            &vault.join("Garden.md"),
            "# Garden\nPlant tomatoes in #spring near the greenhouse.",
        );
        write(
            &vault.join("Projects/Clipboard Manager.md"),
            "Design notes for the clipboard feature.",
        );
        write(
            &vault.join("Rust.md"),
            "Ownership and borrowing explained. #rust",
        );
        write(&vault.join(".nopes/hidden.md"), "should never be indexed");
        let index = SearchIndex::new(&root.join("data/search")).expect("index");
        let reader = VaultReader::new(&root.join("data")).expect("reader");
        reader
            .set_vault_path(&vault.to_string_lossy())
            .expect("configure vault");
        let memory = MemoryStore::new(&root.join("data/memory")).expect("memory");
        let calendar = Calendar::new(&root.join("data/calendar")).expect("calendar");
        let tasks = TaskBoardEngine::new(&root.join("data/tasks")).expect("tasks");
        Fixture {
            _dir: dir,
            root,
            index,
            reader,
            vault,
            memory,
            calendar,
            tasks,
        }
    }

    fn sources(f: &Fixture) -> IndexSources<'_> {
        IndexSources {
            vault: Some((&f.reader, f.vault.to_string_lossy().to_string())),
            project_dirs: vec![f.root.join("code")],
            memory: &f.memory,
            calendar: &f.calendar,
            tasks: &f.tasks,
            app_roots: vec![f.root.join("Applications")],
        }
    }

    fn query(f: &Fixture, q: &str) -> Vec<SearchHit> {
        f.index
            .query(&SearchRequest {
                query: q.into(),
                limit: 20,
                ..SearchRequest::default()
            })
            .expect("query")
    }

    fn titles(hits: &[SearchHit]) -> Vec<&str> {
        hits.iter().map(|h| h.title.as_str()).collect()
    }

    fn vault_root(f: &Fixture) -> String {
        f.vault.to_string_lossy().to_string()
    }

    #[test]
    fn incremental_vault_indexing_only_rereads_changed_notes() {
        let f = fixture();
        let first = f
            .index
            .sync_vault(&f.reader, &vault_root(&f), false)
            .expect("first");
        assert_eq!((first.count, first.changed, first.removed), (3, 3, 0));

        let unchanged = f
            .index
            .sync_vault(&f.reader, &vault_root(&f), false)
            .expect("second");
        assert_eq!(
            (unchanged.count, unchanged.changed, unchanged.removed),
            (3, 0, 0)
        );

        // Modify one note (different size → new signature), delete one, add one.
        write(
            &f.vault.join("Garden.md"),
            "# Garden\nNow with cucumbers and a new trellis.",
        );
        std::fs::remove_file(f.vault.join("Rust.md")).expect("delete");
        write(&f.vault.join("New idea.md"), "Fresh thought");
        let third = f
            .index
            .sync_vault(&f.reader, &vault_root(&f), false)
            .expect("third");
        assert_eq!((third.count, third.changed, third.removed), (3, 2, 1));

        assert_eq!(titles(&query(&f, "cucumbers")), vec!["Garden"]);
        assert!(query(&f, "tomatoes").is_empty(), "old content is gone");
        assert!(query(&f, "ownership").is_empty(), "deleted note is gone");

        let forced = f
            .index
            .sync_vault(&f.reader, &vault_root(&f), true)
            .expect("forced");
        assert_eq!(
            forced.changed, 0,
            "forced re-read of identical content changes nothing"
        );
    }

    #[test]
    fn lazy_rescans_are_rate_limited() {
        let f = fixture();
        assert!(f
            .index
            .maybe_sync_vault(&f.reader, &vault_root(&f))
            .expect("first")
            .is_some());
        assert!(
            f.index
                .maybe_sync_vault(&f.reader, &vault_root(&f))
                .expect("second")
                .is_none(),
            "a scan within 10 s is skipped"
        );
    }

    #[test]
    fn keyword_hits_have_marked_snippets_and_fuzzy_finds_abbreviations() {
        let f = fixture();
        f.index
            .sync_vault(&f.reader, &vault_root(&f), false)
            .expect("sync");
        let hits = query(&f, "tomatoes");
        assert_eq!(titles(&hits), vec!["Garden"]);
        assert!(
            hits[0].snippet_html.contains("<mark>tomatoes</mark>"),
            "{}",
            hits[0].snippet_html
        );
        assert_eq!(hits[0].matched, vec!["keyword"]);
        assert_eq!(hits[0].score, 1.0);

        let fuzzy = query(&f, "clbrd");
        assert_eq!(titles(&fuzzy), vec!["Clipboard Manager"]);
        assert_eq!(fuzzy[0].matched, vec!["fuzzy"]);
        assert_eq!(fuzzy[0].subtitle, "Projects");
    }

    #[test]
    fn tag_queries_search_tags_only() {
        let f = fixture();
        f.index
            .sync_vault(&f.reader, &vault_root(&f), false)
            .expect("sync");
        assert_eq!(titles(&query(&f, "#spring")), vec!["Garden"]);
        assert_eq!(titles(&query(&f, "#rust")), vec!["Rust"]);
        assert!(
            query(&f, "#greenhouse").is_empty(),
            "body words are not tags"
        );
    }

    #[test]
    fn semantic_hits_are_fused_with_keyword_hits() {
        let f = fixture();
        f.index
            .sync_vault(&f.reader, &vault_root(&f), false)
            .expect("sync");
        let rust_path = f.vault.join("Rust.md").to_string_lossy().to_string();
        let garden_path = f.vault.join("Garden.md").to_string_lossy().to_string();
        let hits = f
            .index
            .query(&SearchRequest {
                query: "greenhouse".into(),
                limit: 10,
                semantic: vec![
                    SemanticMatch {
                        note_path: rust_path,
                        score: 0.8,
                        text: "Ownership and borrowing".into(),
                    },
                    SemanticMatch {
                        note_path: garden_path,
                        score: 0.7,
                        text: "garden".into(),
                    },
                    SemanticMatch {
                        note_path: "/elsewhere/unknown.md".into(),
                        score: 0.6,
                        text: "x".into(),
                    },
                ],
                ..SearchRequest::default()
            })
            .expect("query");
        assert_eq!(
            titles(&hits),
            vec!["Garden", "Rust"],
            "keyword + semantic beats semantic only"
        );
        assert_eq!(hits[0].matched, vec!["keyword", "semantic"]);
        assert_eq!(hits[1].matched, vec!["semantic"]);
        assert!(hits[1].snippet_html.contains("Ownership"));
    }

    #[test]
    fn frecency_boosts_frequently_opened_results() {
        let f = fixture();
        write(&f.vault.join("Plan A.md"), "the plan, the whole plan");
        write(&f.vault.join("Plan B.md"), "the plan");
        f.index
            .sync_vault(&f.reader, &vault_root(&f), false)
            .expect("sync");
        let before = query(&f, "plan");
        let mut top_two: Vec<&str> = titles(&before)[..2].to_vec();
        top_two.sort_unstable();
        assert_eq!(top_two, vec!["Plan A", "Plan B"]);
        let runner_up = before[1].clone();
        for _ in 0..3 {
            f.index
                .record_recent(&runner_up.id, "note", None)
                .expect("record");
        }
        let after = query(&f, "plan");
        assert_eq!(
            after[0].id, runner_up.id,
            "frecency lifts the runner-up to the top"
        );

        let recents = f.index.recent_hits(10).expect("recents");
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].count, 3);
        assert_eq!(
            recents[0].hit.as_ref().map(|h| h.title.as_str()),
            Some(runner_up.title.as_str())
        );
    }

    #[test]
    fn recents_keep_client_kinds_and_drop_deleted_documents() {
        let f = fixture();
        f.index
            .sync_vault(&f.reader, &vault_root(&f), false)
            .expect("sync");
        f.index
            .record_recent(
                "command:app.settings",
                "command",
                Some("Open settings".into()),
            )
            .expect("cmd");
        let garden = format!("note:{}", f.vault.join("Garden.md").display());
        f.index.record_recent(&garden, "note", None).expect("note");
        f.index
            .record_recent("note:/gone.md", "note", None)
            .expect("gone");
        let recents = f.index.recent_hits(10).expect("recents");
        let ids: Vec<&str> = recents.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec![garden.as_str(), "command:app.settings"]);
        assert!(recents[1].hit.is_none());
        f.index.clear_recents().expect("clear");
        assert!(f.index.recent_hits(10).expect("recents").is_empty());
    }

    #[test]
    fn per_kind_caps_and_kind_filters_apply() {
        let f = fixture();
        let docs: Vec<IndexDoc> = (0..10)
            .map(|i| {
                sources::app_doc(&AppEntry {
                    name: format!("Plan App {i}"),
                    path: format!("/Applications/P{i}.app"),
                    bundle_id: None,
                })
            })
            .collect();
        f.index.sync_kind(SearchKind::App, &docs).expect("apps");
        write(&f.vault.join("Plan.md"), "plan");
        f.index
            .sync_vault(&f.reader, &vault_root(&f), false)
            .expect("sync");

        let capped = f
            .index
            .query(&SearchRequest {
                query: "plan".into(),
                limit: 50,
                per_kind: Some(3),
                ..SearchRequest::default()
            })
            .expect("query");
        assert_eq!(
            capped.iter().filter(|h| h.kind == SearchKind::App).count(),
            3
        );
        assert!(capped.iter().any(|h| h.kind == SearchKind::Note));

        let notes_only = f
            .index
            .query(&SearchRequest {
                query: "plan".into(),
                limit: 50,
                kinds: Some(vec![SearchKind::Note]),
                ..SearchRequest::default()
            })
            .expect("query");
        assert!(notes_only.iter().all(|h| h.kind == SearchKind::Note));
        assert!(query(&f, "   ").is_empty());
        assert!(query(&f, "!!!").is_empty());
    }

    #[test]
    fn full_reindex_covers_every_source_and_reports_per_kind() {
        let f = fixture();
        // Projects with files, one ignored.
        let project = f.root.join("code/aether");
        write(&project.join("Cargo.toml"), "[package]");
        write(&project.join("src/search_index.rs"), "");
        write(&project.join(".gitignore"), "secret.env\n");
        write(&project.join("secret.env"), "");
        std::fs::create_dir_all(project.join(".git")).expect("git");
        write(&project.join(".git/HEAD"), "ref: refs/heads/main\n");
        // Apps.
        std::fs::create_dir_all(f.root.join("Applications/Zed.app/Contents")).expect("app");
        // Memory, conversations, calendar, tasks.
        f.memory
            .save_fact("Anna prefers green tea", "people")
            .expect("fact");
        f.memory
            .save_conversation(
                vec![ChatMessageRecord {
                    role: "user".into(),
                    content: "Explain reciprocal rank fusion".into(),
                }],
                vec![],
            )
            .expect("conversation");
        f.calendar
            .create(
                "Dentist appointment",
                "Bring the insurance card",
                true,
                "2026-09-24",
                "2026-09-24",
                None,
                "#3b82f6",
                vec![],
                vec![],
                Some("Main street".into()),
                None,
            )
            .expect("event");
        let board = f
            .tasks
            .create_project("Launch", "", "#10b981", None)
            .expect("project");
        f.tasks
            .create_task(
                &board.id,
                "Write launcher docs",
                "Cover prefixes",
                "todo",
                "high",
                None,
                vec!["docs".into()],
                None,
            )
            .expect("task");

        let mut seen = Vec::new();
        let report = f
            .index
            .reindex(&sources(&f), &[], false, &mut |r| seen.push(r.kind));
        assert_eq!(seen, SearchKind::all());
        assert!(report.kinds.iter().all(|k| k.error.is_none()), "{report:?}");
        let count = |kind: SearchKind| {
            report
                .kinds
                .iter()
                .find(|k| k.kind == kind)
                .map(|k| k.count)
                .unwrap_or(0)
        };
        assert_eq!(count(SearchKind::Note), 3);
        assert_eq!(count(SearchKind::Project), 1);
        assert_eq!(
            count(SearchKind::File),
            2,
            "Cargo.toml + src/search_index.rs"
        );
        assert_eq!(count(SearchKind::Memory), 1);
        assert_eq!(count(SearchKind::Conversation), 1);
        assert_eq!(count(SearchKind::Event), 1);
        assert_eq!(count(SearchKind::Task), 1);
        assert_eq!(count(SearchKind::App), 1);
        assert_eq!(report.total, 11);
        assert!(!f.index.is_indexing());

        assert_eq!(
            titles(&query(&f, "green tea")),
            vec!["Anna prefers green tea"]
        );
        assert_eq!(titles(&query(&f, "insurance")), vec!["Dentist appointment"]);
        let task = query(&f, "launcher docs");
        assert_eq!(task[0].kind, SearchKind::Task);
        assert_eq!(task[0].extra["project_id"], board.id);
        assert_eq!(titles(&query(&f, "zed")), vec!["Zed"]);
        let project_hit = query(&f, "aether");
        assert!(project_hit
            .iter()
            .any(|h| h.kind == SearchKind::Project && h.subtitle == "rust · main"));
        assert!(query(&f, "secret").is_empty(), ".gitignore is respected");
        assert_eq!(
            titles(&query(&f, "fusion")),
            vec!["Explain reciprocal rank fusion"]
        );

        let status = f.index.status().expect("status");
        assert_eq!(status.total, 11);
        assert!(status.last_indexed_at.is_some());
    }

    #[test]
    fn disabled_kinds_are_purged_and_not_searched() {
        let f = fixture();
        f.index
            .sync_vault(&f.reader, &vault_root(&f), false)
            .expect("sync");
        f.index
            .set_settings(SearchSettings {
                kinds: vec![SearchKind::App],
                ..SearchSettings::default()
            })
            .expect("settings");
        assert!(
            query(&f, "tomatoes").is_empty(),
            "disabled kinds are filtered at query time"
        );
        let report = f
            .index
            .reindex(&sources(&f), &[SearchKind::Note], false, &mut |_| {});
        assert_eq!(report.kinds[0].removed, 3);
        assert_eq!(f.index.status().expect("status").total, 0);
    }

    #[test]
    fn missing_vault_reports_an_error_for_notes_only() {
        let f = fixture();
        let mut src = sources(&f);
        src.vault = Some((
            &f.reader,
            f.root.join("no-such-vault").to_string_lossy().to_string(),
        ));
        let report = f.index.reindex(
            &src,
            &[SearchKind::Note, SearchKind::Memory],
            false,
            &mut |_| {},
        );
        assert!(report.kinds[0]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("does not exist"));
        assert!(report.kinds[1].error.is_none());
    }

    #[test]
    fn plain_highlighting_centres_on_the_first_match() {
        let text = format!(
            "{} needle in the haystack and another Needle",
            "filler ".repeat(40)
        );
        let html = highlight_plain(&text, &["needle".to_owned()], 80);
        assert!(html.starts_with('…'));
        assert!(html.contains("<mark>needle</mark>"));
        assert_eq!(
            highlight_plain("a <b> c", &["b".to_owned()], 80),
            "a &lt;<mark>b</mark>&gt; c"
        );
        assert_eq!(highlight_plain("plain text", &[], 80), "plain text");
    }

    #[test]
    fn apps_are_cached() {
        let f = fixture();
        let roots = vec![f.root.join("Applications")];
        std::fs::create_dir_all(f.root.join("Applications/One.app")).expect("app");
        assert_eq!(f.index.apps(&roots, false).len(), 1);
        std::fs::create_dir_all(f.root.join("Applications/Two.app")).expect("app");
        assert_eq!(f.index.apps(&roots, false).len(), 1, "served from cache");
        assert_eq!(f.index.apps(&roots, true).len(), 2, "force refreshes");
    }

    #[test]
    fn kinds_parse_strictly() {
        assert_eq!(
            parse_kinds(&["note".into(), "note".into(), "app".into()]).unwrap(),
            vec![SearchKind::Note, SearchKind::App]
        );
        assert!(parse_kinds(&["nope".into()]).is_err());
        assert_eq!(
            serde_json::to_string(&SearchKind::Conversation).unwrap(),
            "\"conversation\""
        );
    }
}
