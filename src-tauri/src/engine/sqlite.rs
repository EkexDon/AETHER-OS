//! Shared SQLite helper for engines that need a relational store
//! (clipboard history, universal search FTS index, …).
//!
//! Every database is opened through [`open_db`] so all engines get the same
//! pragmas: WAL journaling (readers never block the single writer), enforced
//! foreign keys and a busy timeout that absorbs short write contention.
//! Schema evolution goes through [`migrate`], which records the applied
//! version in a one-row `schema_version` table and applies each pending
//! migration inside its own transaction.
//!
//! The helpers are shared infrastructure for the Wave 2 feature engines
//! (`clipboard`, `search`); until the first of them is wired into
//! `AppState` the lib target has no caller, hence the dead-code allowance.
#![allow(dead_code)]

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};

use crate::engine::error::AetherError;

/// How long a connection waits for a competing writer before failing.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Open (or create) the SQLite database at `path`.
///
/// Parent directories are created as needed. The connection has
/// `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL` (safe
/// with WAL) and a 5 s busy timeout.
pub fn open_db(path: &Path) -> Result<Connection, AetherError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

/// Apply the shared pragmas to an already open connection.
fn configure(conn: &Connection) -> Result<(), AetherError> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    // `journal_mode` returns the resulting mode as a row, so it must be
    // queried rather than executed. In-memory databases report "memory".
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") && !mode.eq_ignore_ascii_case("memory") {
        return Err(AetherError::InvalidInput(format!(
            "SQLite refused WAL journaling (got {mode})"
        )));
    }
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")?;
    Ok(())
}

/// Current schema version recorded in `schema_version` (0 for a fresh db).
pub fn schema_version(conn: &Connection) -> Result<u32, AetherError> {
    ensure_version_table(conn)?;
    let version: Option<u32> = conn
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(version.unwrap_or(0))
}

fn ensure_version_table(conn: &Connection) -> Result<(), AetherError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL
        );",
    )?;
    Ok(())
}

/// Bring the schema up to date.
///
/// `migrations[i]` upgrades the schema from version `i` to `i + 1`; each
/// entry may contain several `;`-separated statements. Migrations that were
/// already applied are skipped, so calling this on every start-up is cheap
/// and idempotent. Each pending migration runs in its own transaction: a
/// failing migration leaves the database at the last good version.
///
/// Returns the resulting schema version. A database whose recorded version
/// is newer than `migrations.len()` (written by a newer app build) is
/// rejected instead of being silently downgraded.
pub fn migrate(conn: &mut Connection, migrations: &[&str]) -> Result<u32, AetherError> {
    let current = schema_version(conn)?;
    let target = u32::try_from(migrations.len())
        .map_err(|_| AetherError::InvalidInput("too many migrations".to_owned()))?;
    if current > target {
        return Err(AetherError::InvalidInput(format!(
            "database schema version {current} is newer than this build supports ({target})"
        )));
    }

    for (index, sql) in migrations.iter().enumerate().skip(current as usize) {
        let next = index as u32 + 1;
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_version (id, version) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET version = excluded.version",
            [next],
        )?;
        tx.commit()?;
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIGRATIONS: &[&str] = &[
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        "ALTER TABLE items ADD COLUMN tag TEXT;
         CREATE INDEX idx_items_tag ON items(tag);",
    ];

    fn temp_db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().expect("temp dir");
        let conn = open_db(&dir.path().join("nested/dir/test.db")).expect("open db");
        (dir, conn)
    }

    #[test]
    fn open_db_creates_parent_dirs_and_enables_wal_and_foreign_keys() {
        let (dir, conn) = temp_db();
        assert!(dir.path().join("nested/dir/test.db").exists());

        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .expect("journal mode");
        assert_eq!(mode.to_lowercase(), "wal");

        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .expect("foreign keys");
        assert_eq!(fk, 1);
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let (_dir, mut conn) = temp_db();
        migrate(
            &mut conn,
            &["CREATE TABLE parent (id INTEGER PRIMARY KEY);
               CREATE TABLE child (id INTEGER PRIMARY KEY,
                   parent_id INTEGER NOT NULL REFERENCES parent(id));"],
        )
        .expect("migrate");
        let err = conn
            .execute("INSERT INTO child (id, parent_id) VALUES (1, 42)", [])
            .expect_err("dangling foreign key must be rejected");
        assert!(err.to_string().to_lowercase().contains("foreign key"));
    }

    #[test]
    fn migrate_applies_all_migrations_on_a_fresh_db() {
        let (_dir, mut conn) = temp_db();
        assert_eq!(schema_version(&conn).expect("version"), 0);
        assert_eq!(migrate(&mut conn, MIGRATIONS).expect("migrate"), 2);
        assert_eq!(schema_version(&conn).expect("version"), 2);
        conn.execute("INSERT INTO items (name, tag) VALUES ('a', 't')", [])
            .expect("insert uses both migrations");
    }

    #[test]
    fn migrate_is_idempotent_and_incremental() {
        let (_dir, mut conn) = temp_db();
        assert_eq!(migrate(&mut conn, &MIGRATIONS[..1]).expect("v1"), 1);
        conn.execute("INSERT INTO items (name) VALUES ('kept')", [])
            .expect("insert");
        // Re-running with more migrations only applies the new one.
        assert_eq!(migrate(&mut conn, MIGRATIONS).expect("v2"), 2);
        assert_eq!(migrate(&mut conn, MIGRATIONS).expect("again"), 2);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1, "existing rows survive later migrations");
    }

    #[test]
    fn failing_migration_rolls_back_and_keeps_last_good_version() {
        let (_dir, mut conn) = temp_db();
        let broken: &[&str] = &[
            MIGRATIONS[0],
            "CREATE TABLE half_done (id INTEGER); THIS IS NOT SQL;",
        ];
        let err = migrate(&mut conn, broken).expect_err("broken migration must fail");
        assert!(err.to_string().starts_with("database error"));
        assert_eq!(schema_version(&conn).expect("version"), 1);
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'half_done'",
                [],
                |r| r.get(0),
            )
            .expect("lookup");
        assert_eq!(exists, 0, "partial migration must be rolled back");
    }

    #[test]
    fn refuses_to_downgrade_a_newer_schema() {
        let (_dir, mut conn) = temp_db();
        migrate(&mut conn, MIGRATIONS).expect("v2");
        let err = migrate(&mut conn, &MIGRATIONS[..1]).expect_err("downgrade must fail");
        assert!(err.to_string().contains("newer than this build"));
    }

    #[test]
    fn bundled_sqlite_supports_fts5() {
        let (_dir, mut conn) = temp_db();
        migrate(
            &mut conn,
            &["CREATE VIRTUAL TABLE docs USING fts5(title, body);"],
        )
        .expect("fts5 virtual table must be creatable");
        conn.execute(
            "INSERT INTO docs (title, body) VALUES (?1, ?2), (?3, ?4)",
            [
                "Rust notes",
                "ownership and borrowing",
                "Kochrezept",
                "Spätzle mit Käse",
            ],
        )
        .expect("insert");
        let title: String = conn
            .query_row(
                "SELECT title FROM docs WHERE docs MATCH ?1 ORDER BY rank LIMIT 1",
                ["borrow*"],
                |r| r.get(0),
            )
            .expect("match");
        assert_eq!(title, "Rust notes");
    }

    #[test]
    fn reopening_keeps_data_and_version() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("persist.db");
        {
            let mut conn = open_db(&path).expect("open");
            migrate(&mut conn, MIGRATIONS).expect("migrate");
            conn.execute("INSERT INTO items (name) VALUES ('x')", [])
                .expect("insert");
        }
        let mut conn = open_db(&path).expect("reopen");
        assert_eq!(migrate(&mut conn, MIGRATIONS).expect("noop"), 2);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
    }
}
