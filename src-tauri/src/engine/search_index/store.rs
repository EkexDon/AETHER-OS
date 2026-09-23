//! SQLite + FTS5 storage of the search index.
//!
//! `docs` holds one row per searchable item; `docs_fts` is an external
//! content FTS5 table over `title`, `body` and `tags`, kept in sync by
//! triggers. Upserts only touch rows whose content actually changed, so a
//! full re-sync of 50 000 unchanged files does not rewrite the FTS index.
//! A separate reader connection lets queries run while an indexing
//! transaction is in progress (WAL mode).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension};

use super::SearchKind;
use crate::engine::error::AetherError;
use crate::engine::sqlite::{migrate, open_db};

/// Schema migrations (index `i` upgrades version `i` → `i + 1`).
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE docs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0,
    extra TEXT NOT NULL DEFAULT '{}',
    sig TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_docs_kind ON docs(kind);
CREATE VIRTUAL TABLE docs_fts USING fts5(
    title, body, tags,
    content = 'docs',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3'
);
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts (rowid, title, body, tags)
    VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
    INSERT INTO docs_fts (docs_fts, rowid, title, body, tags)
    VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
    INSERT INTO docs_fts (docs_fts, rowid, title, body, tags)
    VALUES ('delete', old.rowid, old.title, old.body, old.tags);
    INSERT INTO docs_fts (rowid, title, body, tags)
    VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#];

/// Column weights for `bm25()`: title, body, tags.
const BM25_WEIGHTS: &str = "10.0, 1.0, 5.0";
/// Characters of the body returned alongside rows for plain snippets.
const BODY_PREFIX_CHARS: i64 = 1200;

/// A document to index.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexDoc {
    /// Globally unique id, `<kind>:<natural id>`.
    pub id: String,
    pub kind: SearchKind,
    pub title: String,
    pub subtitle: String,
    pub path: String,
    /// Plain text searched and used for snippets.
    pub body: String,
    pub tags: Vec<String>,
    /// Unix seconds.
    pub updated_at: i64,
    /// Kind-specific JSON (project id, event date, …).
    pub extra: serde_json::Value,
    /// Change-detection signature (e.g. mtime + size); empty when unused.
    pub sig: String,
}

/// A stored document as read back (body truncated to a prefix).
#[derive(Debug, Clone)]
pub struct DocRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    pub path: String,
    pub body_prefix: String,
    pub updated_at: i64,
    pub extra: String,
}

/// A full-text match.
#[derive(Debug, Clone)]
pub struct FtsRow {
    pub doc: DocRow,
    /// Raw `snippet()` output with the delimiter characters from `text.rs`.
    pub snippet: String,
}

/// Result of synchronising one kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncStats {
    /// Documents of the kind after the sync.
    pub total: usize,
    /// Inserted or updated rows.
    pub changed: usize,
    /// Deleted rows.
    pub removed: usize,
}

/// The index database (one writer and one reader connection).
pub struct IndexStore {
    writer: Mutex<Connection>,
    reader: Mutex<Connection>,
}

fn lock(conn: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    conn.lock().unwrap_or_else(|e| e.into_inner())
}

const UPSERT_SQL: &str = "
INSERT INTO docs (id, kind, title, subtitle, path, body, tags, updated_at, extra, sig)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
ON CONFLICT(id) DO UPDATE SET
    kind = excluded.kind, title = excluded.title, subtitle = excluded.subtitle,
    path = excluded.path, body = excluded.body, tags = excluded.tags,
    updated_at = excluded.updated_at, extra = excluded.extra, sig = excluded.sig
WHERE docs.kind IS NOT excluded.kind OR docs.title IS NOT excluded.title
   OR docs.subtitle IS NOT excluded.subtitle OR docs.path IS NOT excluded.path
   OR docs.body IS NOT excluded.body OR docs.tags IS NOT excluded.tags
   OR docs.updated_at IS NOT excluded.updated_at OR docs.extra IS NOT excluded.extra
   OR docs.sig IS NOT excluded.sig";

fn upsert_in(tx: &rusqlite::Transaction<'_>, docs: &[IndexDoc]) -> Result<usize, AetherError> {
    let mut stmt = tx.prepare_cached(UPSERT_SQL)?;
    let mut changed = 0;
    for doc in docs {
        let tags = doc.tags.join(" ");
        let extra = doc.extra.to_string();
        changed += stmt.execute(params![
            doc.id,
            doc.kind.as_str(),
            doc.title,
            doc.subtitle,
            doc.path,
            doc.body,
            tags,
            doc.updated_at,
            extra,
            doc.sig
        ])?;
    }
    Ok(changed)
}

fn delete_in(tx: &rusqlite::Transaction<'_>, ids: &[String]) -> Result<usize, AetherError> {
    let mut stmt = tx.prepare_cached("DELETE FROM docs WHERE id = ?1")?;
    let mut removed = 0;
    for id in ids {
        removed += stmt.execute([id])?;
    }
    Ok(removed)
}

fn read_doc(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocRow> {
    Ok(DocRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        subtitle: row.get(3)?,
        path: row.get(4)?,
        body_prefix: row.get(5)?,
        updated_at: row.get(6)?,
        extra: row.get(7)?,
    })
}

fn kind_placeholders(start: usize, count: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", start + i))
        .collect::<Vec<_>>()
        .join(", ")
}

impl IndexStore {
    /// Open (and migrate) the index at `path`.
    pub fn open(path: &Path) -> Result<Self, AetherError> {
        let mut writer = open_db(path)?;
        migrate(&mut writer, MIGRATIONS)?;
        let reader = open_db(path)?;
        Ok(Self {
            writer: Mutex::new(writer),
            reader: Mutex::new(reader),
        })
    }

    /// Make the stored documents of `kind` exactly `docs`: changed rows are
    /// upserted, rows that are no longer present are deleted — all in one
    /// transaction.
    pub fn sync_kind(&self, kind: SearchKind, docs: &[IndexDoc]) -> Result<SyncStats, AetherError> {
        let mut conn = lock(&self.writer);
        let tx = conn.transaction()?;
        let existing: HashSet<String> = {
            let mut stmt = tx.prepare_cached("SELECT id FROM docs WHERE kind = ?1")?;
            let rows = stmt.query_map([kind.as_str()], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<HashSet<_>, _>>()?
        };
        let mut seen: HashSet<&str> = HashSet::with_capacity(docs.len());
        let mut unique: Vec<IndexDoc> = Vec::with_capacity(docs.len());
        for doc in docs {
            if doc.kind == kind && seen.insert(doc.id.as_str()) {
                unique.push(doc.clone());
            }
        }
        let changed = upsert_in(&tx, &unique)?;
        let stale: Vec<String> = existing
            .into_iter()
            .filter(|id| !seen.contains(id.as_str()))
            .collect();
        let removed = delete_in(&tx, &stale)?;
        tx.commit()?;
        Ok(SyncStats {
            total: unique.len(),
            changed,
            removed,
        })
    }

    /// Insert or update documents; returns how many rows changed.
    pub fn upsert(&self, docs: &[IndexDoc]) -> Result<usize, AetherError> {
        let mut conn = lock(&self.writer);
        let tx = conn.transaction()?;
        let changed = upsert_in(&tx, docs)?;
        tx.commit()?;
        Ok(changed)
    }

    /// Delete documents by id; returns how many existed.
    pub fn delete_ids(&self, ids: &[String]) -> Result<usize, AetherError> {
        let mut conn = lock(&self.writer);
        let tx = conn.transaction()?;
        let removed = delete_in(&tx, ids)?;
        tx.commit()?;
        Ok(removed)
    }

    /// `id → sig` of every document of `kind` (incremental indexing).
    pub fn signatures(&self, kind: SearchKind) -> Result<HashMap<String, String>, AetherError> {
        let conn = lock(&self.reader);
        let mut stmt = conn.prepare_cached("SELECT id, sig FROM docs WHERE kind = ?1")?;
        let map = stmt
            .query_map([kind.as_str()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<HashMap<_, _>, _>>()?;
        Ok(map)
    }

    /// Full-text search. `expr` is an FTS5 MATCH expression built by
    /// `text::fts_match_expr` / `fts_tag_expr`; results are best-first.
    pub fn search(
        &self,
        expr: &str,
        kinds: &[SearchKind],
        limit: usize,
    ) -> Result<Vec<FtsRow>, AetherError> {
        if kinds.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT d.id, d.kind, d.title, d.subtitle, d.path, substr(d.body, 1, {BODY_PREFIX_CHARS}),
                    d.updated_at, d.extra,
                    snippet(docs_fts, -1, char(2), char(3), '…', 14),
                    bm25(docs_fts, {BM25_WEIGHTS}) AS relevance
             FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
             WHERE docs_fts MATCH ?1 AND d.kind IN ({})
             ORDER BY relevance, d.rowid
             LIMIT ?{}",
            kind_placeholders(2, kinds.len()),
            kinds.len() + 2
        );
        let mut values: Vec<SqlValue> = Vec::with_capacity(kinds.len() + 2);
        values.push(SqlValue::Text(expr.to_owned()));
        values.extend(kinds.iter().map(|k| SqlValue::Text(k.as_str().to_owned())));
        values.push(SqlValue::Integer(limit.min(10_000) as i64));
        let conn = lock(&self.reader);
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |r| {
                Ok(FtsRow {
                    doc: read_doc(r)?,
                    snippet: r.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// `(id, kind, title)` of every document, for the fuzzy title matcher.
    pub fn titles(&self) -> Result<Vec<(String, String, String)>, AetherError> {
        let conn = lock(&self.reader);
        let mut stmt = conn.prepare_cached("SELECT id, kind, title FROM docs")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Look up documents by id (missing ids are simply absent).
    pub fn get_many(&self, ids: &[String]) -> Result<HashMap<String, DocRow>, AetherError> {
        let mut out = HashMap::with_capacity(ids.len());
        if ids.is_empty() {
            return Ok(out);
        }
        let conn = lock(&self.reader);
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT id, kind, title, subtitle, path, substr(body, 1, {BODY_PREFIX_CHARS}), updated_at, extra
             FROM docs WHERE id = ?1"
        ))?;
        for id in ids {
            if let Some(row) = stmt.query_row([id], read_doc).optional()? {
                out.insert(row.id.clone(), row);
            }
        }
        Ok(out)
    }

    /// Number of documents per kind.
    pub fn counts(&self) -> Result<Vec<(String, usize)>, AetherError> {
        let conn = lock(&self.reader);
        let mut stmt =
            conn.prepare_cached("SELECT kind, COUNT(*) FROM docs GROUP BY kind ORDER BY kind")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Read a value from the `meta` table.
    pub fn meta(&self, key: &str) -> Result<Option<String>, AetherError> {
        let conn = lock(&self.reader);
        let value = conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?;
        Ok(value)
    }

    /// Write a value to the `meta` table.
    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), AetherError> {
        let conn = lock(&self.writer);
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    /// Check the FTS index against its content table; returns an error
    /// when they diverged.
    #[cfg(test)]
    pub fn integrity_check(&self) -> Result<(), AetherError> {
        let conn = lock(&self.writer);
        conn.execute(
            "INSERT INTO docs_fts (docs_fts, rank) VALUES ('integrity-check', 1)",
            [],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::search_index::text::{fts_match_expr, fts_tag_expr, render_snippet};

    fn doc(id: &str, kind: SearchKind, title: &str, body: &str) -> IndexDoc {
        IndexDoc {
            id: id.to_owned(),
            kind,
            title: title.to_owned(),
            subtitle: String::new(),
            path: String::new(),
            body: body.to_owned(),
            tags: Vec::new(),
            updated_at: 0,
            extra: serde_json::json!({}),
            sig: String::new(),
        }
    }

    fn store() -> (tempfile::TempDir, IndexStore) {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = IndexStore::open(&dir.path().join("search/index.db")).expect("open");
        (dir, store)
    }

    fn ids(rows: &[FtsRow]) -> Vec<&str> {
        rows.iter().map(|r| r.doc.id.as_str()).collect()
    }

    #[test]
    fn bm25_prefers_title_matches_and_frequency() {
        let (_dir, store) = store();
        store
            .sync_kind(
                SearchKind::Note,
                &[
                    doc(
                        "note:body",
                        SearchKind::Note,
                        "Weekly review",
                        "we talked about the garden once",
                    ),
                    doc(
                        "note:title",
                        SearchKind::Note,
                        "Garden plan",
                        "tomatoes and beans",
                    ),
                    doc(
                        "note:many",
                        SearchKind::Note,
                        "Misc",
                        "garden garden garden soil garden",
                    ),
                    doc("note:none", SearchKind::Note, "Unrelated", "nothing to see"),
                ],
            )
            .expect("sync");
        let rows = store
            .search(&fts_match_expr("garden").unwrap(), &[SearchKind::Note], 10)
            .expect("search");
        assert_eq!(ids(&rows), vec!["note:title", "note:many", "note:body"]);
    }

    #[test]
    fn prefix_matching_diacritics_and_kind_filters() {
        let (_dir, store) = store();
        store
            .sync_kind(
                SearchKind::Note,
                &[doc("note:1", SearchKind::Note, "Käsespätzle", "Rezept")],
            )
            .expect("notes");
        store
            .sync_kind(
                SearchKind::File,
                &[doc("file:1", SearchKind::File, "kaese.rs", "src kaese.rs")],
            )
            .expect("files");
        let expr = fts_match_expr("kase").unwrap();
        assert_eq!(
            ids(&store.search(&expr, &[SearchKind::Note], 10).unwrap()),
            vec!["note:1"]
        );
        assert!(store
            .search(&expr, &[SearchKind::File], 10)
            .unwrap()
            .is_empty());
        let both = store
            .search(&fts_match_expr("ka").unwrap(), &SearchKind::all(), 10)
            .unwrap();
        assert_eq!(both.len(), 2);
        assert!(store.search(&expr, &[], 10).unwrap().is_empty());
    }

    #[test]
    fn snippets_mark_matches_and_stay_safe() {
        let (_dir, store) = store();
        store
            .sync_kind(
                SearchKind::Note,
                &[doc(
                    "note:1",
                    SearchKind::Note,
                    "Plan",
                    "Intro <b>bold</b> text. Later the ownership rules of Rust are explained in detail.",
                )],
            )
            .expect("sync");
        let rows = store
            .search(
                &fts_match_expr("ownership").unwrap(),
                &[SearchKind::Note],
                5,
            )
            .expect("search");
        let html = render_snippet(&rows[0].snippet);
        assert!(html.contains("<mark>ownership</mark>"), "{html}");
        assert!(!html.contains("<b>"), "{html}");
    }

    #[test]
    fn tag_queries_only_match_the_tags_column() {
        let (_dir, store) = store();
        let mut tagged = doc("note:tagged", SearchKind::Note, "A", "text");
        tagged.tags = vec!["project".into(), "alpha".into()];
        let untagged = doc(
            "note:plain",
            SearchKind::Note,
            "Project notes",
            "project project",
        );
        store
            .sync_kind(SearchKind::Note, &[tagged, untagged])
            .expect("sync");
        let rows = store
            .search(&fts_tag_expr("proj").unwrap(), &[SearchKind::Note], 10)
            .expect("search");
        assert_eq!(ids(&rows), vec!["note:tagged"]);
    }

    #[test]
    fn sync_only_touches_changed_rows_and_removes_stale_ones() {
        let (_dir, store) = store();
        let a = doc("file:a", SearchKind::File, "a.rs", "a");
        let b = doc("file:b", SearchKind::File, "b.rs", "b");
        let first = store
            .sync_kind(SearchKind::File, &[a.clone(), b.clone()])
            .expect("first");
        assert_eq!(
            first,
            SyncStats {
                total: 2,
                changed: 2,
                removed: 0
            }
        );

        let again = store
            .sync_kind(SearchKind::File, &[a.clone(), b.clone()])
            .expect("again");
        assert_eq!(
            again,
            SyncStats {
                total: 2,
                changed: 0,
                removed: 0
            },
            "unchanged rows are skipped"
        );

        let mut a2 = a.clone();
        a2.title = "renamed.rs".into();
        let c = doc("file:c", SearchKind::File, "c.rs", "c");
        let third = store
            .sync_kind(SearchKind::File, &[a2, c.clone(), c])
            .expect("third");
        assert_eq!(
            third,
            SyncStats {
                total: 2,
                changed: 2,
                removed: 1
            }
        );
        assert!(store
            .search(&fts_match_expr("b").unwrap(), &[SearchKind::File], 5)
            .unwrap()
            .is_empty());
        assert_eq!(
            ids(&store
                .search(&fts_match_expr("renamed").unwrap(), &[SearchKind::File], 5)
                .unwrap()),
            vec!["file:a"]
        );
        store
            .integrity_check()
            .expect("fts stays consistent with docs");
    }

    #[test]
    fn syncing_one_kind_leaves_others_alone() {
        let (_dir, store) = store();
        store
            .sync_kind(
                SearchKind::App,
                &[doc("app:x", SearchKind::App, "Xcode", "")],
            )
            .expect("apps");
        store.sync_kind(SearchKind::Note, &[]).expect("empty notes");
        let counts = store.counts().expect("counts");
        assert_eq!(counts, vec![("app".to_owned(), 1)]);
    }

    #[test]
    fn lookups_signatures_meta_and_deletes() {
        let (_dir, store) = store();
        let mut n = doc("note:1", SearchKind::Note, "One", "body");
        n.sig = "100:5".into();
        store.upsert(&[n]).expect("upsert");
        assert_eq!(
            store
                .signatures(SearchKind::Note)
                .unwrap()
                .get("note:1")
                .map(String::as_str),
            Some("100:5")
        );
        let found = store
            .get_many(&["note:1".into(), "note:missing".into()])
            .expect("get");
        assert_eq!(found.len(), 1);
        assert_eq!(found["note:1"].body_prefix, "body");
        assert_eq!(
            store.titles().unwrap(),
            vec![("note:1".into(), "note".into(), "One".into())]
        );
        store.set_meta("k", "v1").expect("meta");
        store.set_meta("k", "v2").expect("meta");
        assert_eq!(store.meta("k").unwrap().as_deref(), Some("v2"));
        assert_eq!(store.meta("missing").unwrap(), None);
        assert_eq!(
            store
                .delete_ids(&["note:1".into(), "note:1".into()])
                .unwrap(),
            1
        );
        assert!(store.titles().unwrap().is_empty());
    }

    #[test]
    fn reopening_keeps_the_index() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("index.db");
        {
            let store = IndexStore::open(&path).expect("open");
            store
                .sync_kind(
                    SearchKind::Task,
                    &[doc("task:1", SearchKind::Task, "Ship v0.2", "")],
                )
                .expect("sync");
        }
        let store = IndexStore::open(&path).expect("reopen");
        let rows = store
            .search(&fts_match_expr("ship").unwrap(), &[SearchKind::Task], 5)
            .expect("search");
        assert_eq!(ids(&rows), vec!["task:1"]);
    }
}
