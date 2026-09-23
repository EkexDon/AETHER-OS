//! Recently opened results and frecency ("frequency × recency") scoring.
//!
//! Every time the user opens a result from the launcher or the search view
//! the frontend records it here. The last [`MAX_RECENTS`] entries are kept
//! in `<data_dir>/search/recents.json`; each remembers its visit count and
//! up to [`MAX_VISITS`] recent visit timestamps. Frecency follows the
//! Firefox model: every sampled visit contributes a weight by age bucket,
//! the average is scaled by the total visit count.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

/// How many distinct recents are kept.
pub const MAX_RECENTS: usize = 50;
/// How many visit timestamps are sampled per entry.
pub const MAX_VISITS: usize = 10;

const DAY: i64 = 86_400;

/// One recently used result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentEntry {
    /// Result id (`note:/abs/path.md`, `command:app.settings`, …).
    pub id: String,
    /// Result kind (`note`, `command`, `bookmark`, …).
    pub kind: String,
    /// Label remembered for kinds the index cannot resolve (commands, bookmarks, clips).
    #[serde(default)]
    pub title: Option<String>,
    /// Total number of visits.
    pub count: u32,
    /// Unix seconds of the latest visit.
    pub last_used: i64,
    /// Unix seconds of the most recent visits, newest first.
    #[serde(default)]
    pub visits: Vec<i64>,
}

/// Weight of a visit that happened `age_secs` ago.
pub fn visit_weight(age_secs: i64) -> f64 {
    let days = age_secs.max(0) / DAY;
    match days {
        0..=3 => 100.0,
        4..=13 => 70.0,
        14..=30 => 50.0,
        31..=89 => 30.0,
        _ => 10.0,
    }
}

/// Frecency of an entry at time `now`: total visits × average weight of
/// the sampled visits. Zero for entries without visits.
pub fn frecency(entry: &RecentEntry, now: i64) -> f64 {
    let samples: Vec<i64> = if entry.visits.is_empty() {
        vec![entry.last_used]
    } else {
        entry.visits.clone()
    };
    if entry.count == 0 {
        return 0.0;
    }
    let total: f64 = samples.iter().map(|t| visit_weight(now - t)).sum();
    f64::from(entry.count) * total / samples.len() as f64
}

/// Multiplicative ranking boost for a frecency value: 1.0 for never-used
/// results, growing logarithmically (≈1.35 for one visit today, capped at 2).
pub fn frecency_boost(value: f64) -> f64 {
    if !(value.is_finite() && value > 0.0) {
        return 1.0;
    }
    (1.0 + 0.5 * (1.0 + value / 100.0).ln()).min(2.0)
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RecentsFile {
    entries: Vec<RecentEntry>,
}

/// JSON-backed store of recent results.
pub struct RecentsStore {
    path: PathBuf,
    entries: Mutex<Vec<RecentEntry>>,
}

impl RecentsStore {
    /// Open the store at `path` (created on first write). A corrupt file is
    /// treated as empty rather than blocking search.
    pub fn open(path: &Path) -> Self {
        let entries = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<RecentsFile>(&raw).ok())
            .map(|f| f.entries)
            .unwrap_or_default();
        Self {
            path: path.to_path_buf(),
            entries: Mutex::new(entries),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<RecentEntry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Record a visit of `id` at `now`. Keeps the newest [`MAX_RECENTS`].
    pub fn record(
        &self,
        id: &str,
        kind: &str,
        title: Option<String>,
        now: i64,
    ) -> Result<RecentEntry, AetherError> {
        let id = id.trim();
        let kind = kind.trim();
        if id.is_empty() || kind.is_empty() {
            return Err(AetherError::InvalidInput(
                "recent id and kind are required".to_owned(),
            ));
        }
        if id.len() > 4096 {
            return Err(AetherError::InvalidInput(
                "recent id is too long".to_owned(),
            ));
        }
        let title = title
            .map(|t| t.trim().chars().take(300).collect::<String>())
            .filter(|t| !t.is_empty());
        let mut entries = self.lock();
        let entry = match entries.iter().position(|e| e.id == id) {
            Some(idx) => {
                let mut entry = entries.remove(idx);
                entry.count = entry.count.saturating_add(1);
                entry.kind = kind.to_owned();
                if title.is_some() {
                    entry.title = title;
                }
                entry.last_used = now;
                entry.visits.insert(0, now);
                entry.visits.truncate(MAX_VISITS);
                entry
            }
            None => RecentEntry {
                id: id.to_owned(),
                kind: kind.to_owned(),
                title,
                count: 1,
                last_used: now,
                visits: vec![now],
            },
        };
        entries.insert(0, entry.clone());
        entries.truncate(MAX_RECENTS);
        self.persist(&entries)?;
        Ok(entry)
    }

    /// All entries, most recently used first.
    pub fn list(&self) -> Vec<RecentEntry> {
        let mut entries = self.lock().clone();
        entries.sort_by_key(|e| std::cmp::Reverse(e.last_used));
        entries
    }

    /// Snapshot of `id → frecency` for ranking a whole result list.
    pub fn frecency_map(&self, now: i64) -> std::collections::HashMap<String, f64> {
        self.lock()
            .iter()
            .map(|e| (e.id.clone(), frecency(e, now)))
            .collect()
    }

    /// Forget everything.
    pub fn clear(&self) -> Result<(), AetherError> {
        let mut entries = self.lock();
        entries.clear();
        self.persist(&entries)
    }

    fn persist(&self, entries: &[RecentEntry]) -> Result<(), AetherError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = RecentsFile {
            entries: entries.to_vec(),
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| AetherError::InvalidInput(format!("recents serialize: {e}")))?;
        // Write-then-rename so a crash never leaves a truncated file.
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn entry(count: u32, visits: &[i64]) -> RecentEntry {
        RecentEntry {
            id: "x".into(),
            kind: "note".into(),
            title: None,
            count,
            last_used: visits.first().copied().unwrap_or(0),
            visits: visits.to_vec(),
        }
    }

    #[test]
    fn recent_visits_weigh_more_than_old_ones() {
        let fresh = frecency(&entry(1, &[NOW - 3600]), NOW);
        let old = frecency(&entry(1, &[NOW - 120 * DAY]), NOW);
        assert_eq!(fresh, 100.0);
        assert_eq!(old, 10.0);
        assert!(frecency(&entry(1, &[NOW - 10 * DAY]), NOW) < fresh);
    }

    #[test]
    fn frequent_use_beats_a_single_visit_at_the_same_recency() {
        let once = frecency(&entry(1, &[NOW - DAY]), NOW);
        let often = frecency(&entry(5, &[NOW - DAY, NOW - 2 * DAY]), NOW);
        assert!(often > once);
        assert_eq!(frecency(&entry(0, &[]), NOW), 0.0);
    }

    #[test]
    fn boost_is_neutral_for_unused_and_bounded() {
        assert_eq!(frecency_boost(0.0), 1.0);
        assert_eq!(frecency_boost(f64::NAN), 1.0);
        assert!(frecency_boost(100.0) > 1.3 && frecency_boost(100.0) < 1.4);
        assert_eq!(frecency_boost(1e12), 2.0);
    }

    #[test]
    fn record_bumps_moves_to_front_and_caps_the_list() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = RecentsStore::open(&dir.path().join("search/recents.json"));
        for i in 0..(MAX_RECENTS as i64 + 5) {
            store
                .record(&format!("note:{i}"), "note", None, NOW + i)
                .expect("record");
        }
        assert_eq!(store.list().len(), MAX_RECENTS);
        assert!(
            store.list().iter().all(|e| e.id != "note:0"),
            "oldest dropped"
        );

        let bumped = store
            .record("note:10", "note", Some("Ten".into()), NOW + 1000)
            .expect("bump");
        assert_eq!(bumped.count, 2);
        assert_eq!(bumped.visits, vec![NOW + 1000, NOW + 10]);
        assert_eq!(store.list()[0].id, "note:10");
        assert_eq!(store.list()[0].title.as_deref(), Some("Ten"));
    }

    #[test]
    fn visits_are_sampled_and_persisted() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("recents.json");
        {
            let store = RecentsStore::open(&path);
            for i in 0..15 {
                store
                    .record("cmd", "command", None, NOW + i)
                    .expect("record");
            }
        }
        let reopened = RecentsStore::open(&path);
        let list = reopened.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].count, 15);
        assert_eq!(list[0].visits.len(), MAX_VISITS);
        let map = reopened.frecency_map(NOW + 20);
        assert!(map["cmd"] > 1000.0);
        assert!(!map.contains_key("missing"));
    }

    #[test]
    fn rejects_empty_ids_and_survives_corrupt_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("recents.json");
        std::fs::write(&path, "{not json").expect("write");
        let store = RecentsStore::open(&path);
        assert!(store.list().is_empty());
        assert!(store.record("  ", "note", None, NOW).is_err());
        store.record("b", "note", None, NOW).expect("record");
        store.clear().expect("clear");
        assert!(RecentsStore::open(&path).list().is_empty());
    }
}
