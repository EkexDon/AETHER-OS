//! Conflict records and conflict-copy naming.
//!
//! When two devices changed the same file since their last common version,
//! the newer version keeps the file's path and the other one is written as a
//! *conflict copy* next to it, e.g.
//! `Plan (conflict from MacBook 2026-09-22 140533).md`. The timestamp is the
//! losing version's modification time (UTC), so two devices that detect the
//! same conflict at the same moment produce the same copy name and converge
//! instead of duplicating. App-data JSON files get their copies in a separate
//! namespace (`app-conflicts/…`) so engines never parse them as live data.
//!
//! A [`ConflictRecord`] is stored encrypted in the sync folder
//! (`conflicts/<id>.json`) so every device can list and resolve it.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

/// Longest device name used inside a conflict-copy file name.
const MAX_NAME_CHARS: usize = 40;
/// Resolved records older than this are removed from the sync folder.
pub const RESOLVED_TTL_MS: i64 = 30 * 24 * 3600 * 1000;

/// One side of a conflict: which device wrote that version and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictSide {
    /// Device id of the author.
    pub device_id: String,
    /// Human-readable device name at detection time.
    pub device_name: String,
    /// Modification time of that version (ms since the Unix epoch).
    pub mtime: i64,
}

/// How the user chose to settle a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeepChoice {
    /// Keep the version at the file's own path; remove the conflict copy.
    Local,
    /// Replace the file with the conflict copy's content; remove the copy.
    Remote,
    /// Keep both files as they are.
    Both,
}

impl KeepChoice {
    /// Parse the IPC string (`local` | `remote` | `both`).
    pub fn parse(value: &str) -> Result<Self, AetherError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "local" => Ok(Self::Local),
            "remote" => Ok(Self::Remote),
            "both" => Ok(Self::Both),
            other => Err(AetherError::InvalidInput(format!(
                "unknown conflict resolution \"{other}\" (expected local, remote or both)"
            ))),
        }
    }
}

/// A detected conflict, shared through the sync folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictRecord {
    /// Stable id (keyed hash of `copy_path`, 32 hex chars).
    pub id: String,
    /// Logical path of the file (`vault/…` or `app/…`).
    pub path: String,
    /// Logical path of the conflict copy.
    pub copy_path: String,
    /// Detection time (ms).
    pub detected_at: i64,
    /// Device that detected the conflict.
    pub detected_by: String,
    /// Name of that device.
    pub detected_by_name: String,
    /// The version that kept the file's path.
    pub current: ConflictSide,
    /// The version written to the conflict copy.
    pub other: ConflictSide,
    /// Whether a user settled it.
    #[serde(default)]
    pub resolved: bool,
    /// The choice made, once resolved.
    #[serde(default)]
    pub resolution: Option<KeepChoice>,
    /// When it was resolved (ms).
    #[serde(default)]
    pub resolved_at: Option<i64>,
    /// Device name that resolved it.
    #[serde(default)]
    pub resolved_by_name: Option<String>,
}

impl ConflictRecord {
    /// Mark the record as settled.
    pub fn resolve(&mut self, choice: KeepChoice, device_name: &str, now_ms: i64) {
        self.resolved = true;
        self.resolution = Some(choice);
        self.resolved_at = Some(now_ms);
        self.resolved_by_name = Some(device_name.to_owned());
    }

    /// True when a resolved record is old enough to be deleted.
    pub fn is_expired(&self, now_ms: i64) -> bool {
        self.resolved
            && self
                .resolved_at
                .is_some_and(|at| now_ms.saturating_sub(at) > RESOLVED_TTL_MS)
    }
}

/// Make a device name safe for use inside a file name on every OS.
pub fn sanitize_device_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed
        .trim_matches('.')
        .chars()
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = trimmed.trim().to_owned();
    if trimmed.is_empty() {
        "another device".to_owned()
    } else {
        trimmed
    }
}

/// UTC timestamp used in conflict-copy names (`2026-09-22 140533`).
pub fn copy_timestamp(mtime_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(mtime_ms)
        .unwrap_or_default()
        .format("%Y-%m-%d %H%M%S")
        .to_string()
}

/// Split the last path segment into (stem, extension-with-dot).
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        // A leading dot (".env") is part of the name, not an extension.
        Some(idx) if idx > 0 => (&name[..idx], &name[idx..]),
        _ => (name, ""),
    }
}

/// Logical path of the conflict copy for `path` whose losing version came
/// from `loser_device` at `loser_mtime_ms`. Vault copies sit next to the
/// file; app-data copies move to the `app-conflicts/` namespace.
pub fn conflict_copy_path(path: &str, loser_device: &str, loser_mtime_ms: i64) -> String {
    let (dir, name) = match path.rfind('/') {
        Some(idx) => (&path[..idx], &path[idx + 1..]),
        None => ("", path),
    };
    let dir = match dir.strip_prefix("app/") {
        Some(rest) => format!("app-conflicts/{rest}"),
        None if dir == "app" => "app-conflicts".to_owned(),
        None => dir.to_owned(),
    };
    let (stem, ext) = split_ext(name);
    let file = format!(
        "{stem} (conflict from {} {}){ext}",
        sanitize_device_name(loser_device),
        copy_timestamp(loser_mtime_ms)
    );
    if dir.is_empty() {
        file
    } else {
        format!("{dir}/{file}")
    }
}

/// `path` with a counter (" 2", " 3", …) before the extension.
pub fn numbered_path(path: &str, n: u32) -> String {
    if n <= 1 {
        return path.to_owned();
    }
    let (dir, name) = match path.rfind('/') {
        Some(idx) => (&path[..=idx], &path[idx + 1..]),
        None => ("", path),
    };
    let (stem, ext) = split_ext(name);
    format!("{dir}{stem} {n}{ext}")
}

/// Strip the namespace for display (`vault/Notes/a.md` → `Notes/a.md`).
pub fn display_path(path: &str) -> String {
    for prefix in ["vault/", "app-conflicts/", "app/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            return rest.to_owned();
        }
    }
    path.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_names_sit_next_to_vault_files() {
        // 2026-09-22T14:05:33Z
        let ms = 1_790_085_933_000;
        assert_eq!(copy_timestamp(ms), "2026-09-22 140533");
        assert_eq!(
            conflict_copy_path("vault/Projects/Plan.md", "Ekin's MacBook", ms),
            "vault/Projects/Plan (conflict from Ekin's MacBook 2026-09-22 140533).md"
        );
        assert_eq!(
            conflict_copy_path("vault/README", "Mac", ms),
            "vault/README (conflict from Mac 2026-09-22 140533)"
        );
        assert_eq!(
            conflict_copy_path("vault/.obsidian/app.json", "Mac", ms),
            "vault/.obsidian/app (conflict from Mac 2026-09-22 140533).json"
        );
    }

    #[test]
    fn app_data_copies_move_to_their_own_namespace() {
        let ms = 1_790_085_933_000;
        assert_eq!(
            conflict_copy_path("app/memory/facts.json", "Mac", ms),
            "app-conflicts/memory/facts (conflict from Mac 2026-09-22 140533).json"
        );
    }

    #[test]
    fn device_names_are_sanitized() {
        assert_eq!(sanitize_device_name("a/b\\c:d*e?f"), "a b c d e f");
        assert_eq!(sanitize_device_name("   "), "another device");
        assert_eq!(sanitize_device_name("..hidden.."), "hidden");
        assert_eq!(sanitize_device_name(&"x".repeat(80)).chars().count(), 40);
    }

    #[test]
    fn numbered_paths_keep_the_extension() {
        assert_eq!(numbered_path("vault/a/b.md", 1), "vault/a/b.md");
        assert_eq!(numbered_path("vault/a/b.md", 2), "vault/a/b 2.md");
        assert_eq!(numbered_path("vault/README", 3), "vault/README 3");
    }

    #[test]
    fn keep_choice_parses_and_rejects() {
        assert_eq!(KeepChoice::parse("local").unwrap(), KeepChoice::Local);
        assert_eq!(KeepChoice::parse(" Remote ").unwrap(), KeepChoice::Remote);
        assert_eq!(KeepChoice::parse("both").unwrap(), KeepChoice::Both);
        assert!(KeepChoice::parse("mine").is_err());
    }

    #[test]
    fn resolved_records_expire_after_ttl() {
        let mut record = ConflictRecord {
            id: "x".into(),
            path: "vault/a.md".into(),
            copy_path: "vault/a (conflict).md".into(),
            detected_at: 0,
            detected_by: "d".into(),
            detected_by_name: "D".into(),
            current: ConflictSide {
                device_id: "d".into(),
                device_name: "D".into(),
                mtime: 0,
            },
            other: ConflictSide {
                device_id: "e".into(),
                device_name: "E".into(),
                mtime: 0,
            },
            resolved: false,
            resolution: None,
            resolved_at: None,
            resolved_by_name: None,
        };
        assert!(!record.is_expired(i64::MAX / 2));
        record.resolve(KeepChoice::Both, "D", 1_000);
        assert!(!record.is_expired(1_000 + RESOLVED_TTL_MS));
        assert!(record.is_expired(1_001 + RESOLVED_TTL_MS));
    }

    #[test]
    fn display_path_strips_namespaces() {
        assert_eq!(display_path("vault/Notes/a.md"), "Notes/a.md");
        assert_eq!(display_path("app/memory/facts.json"), "memory/facts.json");
        assert_eq!(display_path("app-conflicts/memory/x.json"), "memory/x.json");
    }
}
