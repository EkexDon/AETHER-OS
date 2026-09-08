//! Calendar event engine.
//!
//! Mirrors the file-per-record pattern used by
//! [`crate::engine::aether_notes::AetherNotes`]: one JSON file per
//! event at `<storage_dir>/<id>.json`. Concurrent writes from two
//! tabs are rare in personal use; the kernel's atomic single-sector
//! write keeps our small (<2 KB) files consistent.
//!
//! Timezone handling: timed events are stored as RFC3339 with the
//! user's local offset at creation time and never converted on
//! display. This matches the "floating" behaviour of Apple/Google
//! Calendar for trips and avoids a hard dep on `chrono-tz`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

/// A single calendar event. See `docs/CALENDAR_PLAN.md` §1.1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalendarEvent {
    /// Internal AETHER id (uuid v4).
    pub id: String,
    /// iCalendar UID used for round-tripping with external calendars.
    /// Defaults to `<id>@aether-os.local` on create; preserved on import.
    pub uid: String,
    pub title: String,
    /// Markdown body.
    pub description: String,
    /// When true, `start` / `end` are `YYYY-MM-DD`; otherwise RFC3339.
    pub all_day: bool,
    /// `YYYY-MM-DD` when `all_day`, else RFC3339.
    pub start: String,
    /// Same format as `start`. Required (use `due` for deadline-only).
    pub end: String,
    /// Optional independent deadline (e.g. "prep this by 5pm").
    pub due: Option<String>,
    /// Hex like `#3b82f6`.
    pub color: String,
    pub tags: Vec<String>,
    /// Free-form names/emails; not validated.
    pub attendees: Vec<String>,
    pub location: Option<String>,
    /// Set when the event was created from a vault note.
    pub source_note_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Patch struct: every field optional, with `#[serde(default)]` so the
/// AI can update just the title without re-sending the whole event.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EventPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub all_day: Option<bool>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    /// Tri-state: `None` = leave alone, `Some(None)` = clear, `Some(Some(s))` = set.
    #[serde(default)]
    pub due: Option<Option<String>>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub attendees: Option<Vec<String>>,
    /// Tri-state (see `due`).
    #[serde(default)]
    pub location: Option<Option<String>>,
    /// Tri-state (see `due`).
    #[serde(default)]
    pub source_note_path: Option<Option<String>>,
}

const DEFAULT_COLOR: &str = "#7c3aed";
const EVENTS_DIR: &str = "events";

/// Calendar event store.
pub struct Calendar {
    storage_dir: PathBuf,
}

impl Calendar {
    /// Create the events directory under `storage_dir` and return a handle.
    pub fn new(storage_dir: &Path) -> Result<Self, AetherError> {
        let events_dir = storage_dir.join(EVENTS_DIR);
        std::fs::create_dir_all(&events_dir)?;
        Ok(Self {
            storage_dir: events_dir,
        })
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.storage_dir.join(format!("{id}.json"))
    }

    /// Insert a new event. Generates `id` and `uid`, sets timestamps.
    pub fn create(
        &self,
        title: &str,
        description: &str,
        all_day: bool,
        start: &str,
        end: &str,
        due: Option<String>,
        color: &str,
        tags: Vec<String>,
        attendees: Vec<String>,
        location: Option<String>,
        source_note_path: Option<String>,
    ) -> Result<CalendarEvent, AetherError> {
        validate_title(title)?;
        validate_color(color)?;
        validate_range(all_day, start, end)?;

        let id = uuid::Uuid::new_v4().to_string();
        let uid = format!("{id}@aether-os.local");
        let now = chrono::Utc::now().to_rfc3339();

        let event = CalendarEvent {
            id: id.clone(),
            uid,
            title: title.trim().to_owned(),
            description: description.to_owned(),
            all_day,
            start: start.to_owned(),
            end: end.to_owned(),
            due,
            color: color.to_owned(),
            tags,
            attendees,
            location,
            source_note_path,
            created_at: now.clone(),
            updated_at: now,
        };

        self.write(&event)?;
        Ok(event)
    }

    fn write(&self, event: &CalendarEvent) -> Result<(), AetherError> {
        let path = self.path_for(&event.id);
        let json = serde_json::to_string_pretty(event)
            .map_err(|e| AetherError::Vault(format!("calendar event serialize: {e}")))?;
        std::fs::write(path, json)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<CalendarEvent, AetherError> {
        let path = self.path_for(id);
        if !path.exists() {
            return Err(AetherError::Vault(format!("event not found: {id}")));
        }
        let content = std::fs::read_to_string(&path)?;
        serde_json::from_str(&content)
            .map_err(|e| AetherError::Vault(format!("event parse: {e}")))
    }

    /// Find an event by its iCalendar UID. Scans the storage dir.
    pub fn get_by_uid(&self, uid: &str) -> Result<Option<CalendarEvent>, AetherError> {
        for event in self.iter_events()? {
            if event.uid == uid {
                return Ok(Some(event));
            }
        }
        Ok(None)
    }

    /// List all events, sorted by `start` ascending. Strings sort
    /// chronologically for both `YYYY-MM-DD` and RFC3339 with offset.
    pub fn list(&self) -> Result<Vec<CalendarEvent>, AetherError> {
        let mut events = self.iter_events()?;
        events.sort_by(|a, b| a.start.cmp(&b.start));
        Ok(events)
    }

    fn iter_events(&self) -> Result<Vec<CalendarEvent>, AetherError> {
        let mut events = Vec::new();
        if !self.storage_dir.exists() {
            return Ok(events);
        }
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
            match serde_json::from_str::<CalendarEvent>(&content) {
                Ok(event) => events.push(event),
                Err(e) => {
                    return Err(AetherError::Vault(format!(
                        "event parse error in {}: {e}",
                        path.display()
                    )))
                }
            }
        }
        Ok(events)
    }

    /// Apply a patch to the stored event. Preserves `id`, `uid`,
    /// `created_at`. Updates `updated_at`. Validates the new state.
    pub fn update(&self, id: &str, patch: EventPatch) -> Result<CalendarEvent, AetherError> {
        let mut event = self.get(id)?;

        if let Some(title) = patch.title.as_deref() {
            validate_title(title)?;
            event.title = title.trim().to_owned();
        }
        if let Some(description) = patch.description {
            event.description = description;
        }
        if let Some(all_day) = patch.all_day {
            event.all_day = all_day;
        }
        if let Some(start) = patch.start.as_deref() {
            event.start = start.to_owned();
        }
        if let Some(end) = patch.end.as_deref() {
            event.end = end.to_owned();
        }
        if let Some(color) = patch.color.as_deref() {
            validate_color(color)?;
            event.color = color.to_owned();
        }
        if let Some(tags) = patch.tags {
            event.tags = tags;
        }
        if let Some(attendees) = patch.attendees {
            event.attendees = attendees;
        }
        match patch.due {
            Some(Some(d)) => event.due = Some(d),
            Some(None) => event.due = None,
            None => {}
        }
        match patch.location {
            Some(Some(l)) => event.location = Some(l),
            Some(None) => event.location = None,
            None => {}
        }
        match patch.source_note_path {
            Some(Some(p)) => event.source_note_path = Some(p),
            Some(None) => event.source_note_path = None,
            None => {}
        }

        validate_title(&event.title)?;
        validate_color(&event.color)?;
        validate_range(event.all_day, &event.start, &event.end)?;

        event.updated_at = chrono::Utc::now().to_rfc3339();
        self.write(&event)?;
        Ok(event)
    }

    pub fn delete(&self, id: &str) -> Result<(), AetherError> {
        let path = self.path_for(id);
        if !path.exists() {
            return Err(AetherError::Vault(format!("event not found: {id}")));
        }
        std::fs::remove_file(path)?;
        Ok(())
    }
}

fn validate_title(title: &str) -> Result<(), AetherError> {
    if title.trim().is_empty() {
        return Err(AetherError::InvalidInput("title is required".to_owned()));
    }
    Ok(())
}

/// `#RRGGBB` (case-insensitive, 6 hex digits).
fn is_valid_color(s: &str) -> bool {
    if s.len() != 7 || !s.starts_with('#') {
        return false;
    }
    s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn validate_color(color: &str) -> Result<(), AetherError> {
    if !is_valid_color(color) {
        return Err(AetherError::InvalidInput(format!(
            "color must match #RRGGBB, got {color:?}"
        )));
    }
    Ok(())
}

fn validate_range(all_day: bool, start: &str, end: &str) -> Result<(), AetherError> {
    if all_day {
        let s = chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d")
            .map_err(|e| AetherError::InvalidInput(format!("start date: {e}")))?;
        let e = chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d")
            .map_err(|e| AetherError::InvalidInput(format!("end date: {e}")))?;
        if e < s {
            return Err(AetherError::InvalidInput(format!(
                "end {end} is before start {start}"
            )));
        }
    } else {
        let s = chrono::DateTime::parse_from_rfc3339(start)
            .map_err(|e| AetherError::InvalidInput(format!("start datetime: {e}")))?;
        let e = chrono::DateTime::parse_from_rfc3339(end)
            .map_err(|e| AetherError::InvalidInput(format!("end datetime: {e}")))?;
        if e < s {
            return Err(AetherError::InvalidInput(format!(
                "end {end} is before start {start}"
            )));
        }
    }
    Ok(())
}

/// Convenience: the default color used when an event doesn't specify one.
#[allow(dead_code)]
pub fn default_color() -> &'static str {
    DEFAULT_COLOR
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Calendar, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("temp dir");
        let cal = Calendar::new(dir.path()).expect("calendar");
        (cal, dir)
    }

    #[test]
    fn creates_and_lists_events() {
        let (cal, _dir) = store();
        let event = cal
            .create(
                "Standup",
                "Daily sync",
                false,
                "2026-10-10T09:00:00+02:00",
                "2026-10-10T09:15:00+02:00",
                None,
                "#3b82f6",
                vec!["work".to_owned()],
                vec![],
                Some("Room 1".to_owned()),
                None,
            )
            .expect("create");

        assert_eq!(event.title, "Standup");
        assert!(event.uid.ends_with("@aether-os.local"));
        assert!(event.uid.starts_with(&event.id));

        let list = cal.list().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, event.id);
    }

    #[test]
    fn updates_event_preserves_id_and_created_at() {
        let (cal, _dir) = store();
        let event = cal
            .create(
                "T",
                "",
                false,
                "2026-10-10T09:00:00+00:00",
                "2026-10-10T10:00:00+00:00",
                None,
                "#7c3aed",
                vec![],
                vec![],
                None,
                None,
            )
            .expect("create");

        let updated = cal
            .update(
                &event.id,
                EventPatch {
                    title: Some("Renamed".to_owned()),
                    ..Default::default()
                },
            )
            .expect("update");

        assert_eq!(updated.id, event.id);
        assert_eq!(updated.created_at, event.created_at);
        assert_ne!(updated.updated_at, event.updated_at);
        assert_eq!(updated.title, "Renamed");
    }

    #[test]
    fn deletes_an_event() {
        let (cal, _dir) = store();
        let event = cal
            .create(
                "X",
                "",
                false,
                "2026-10-10T09:00:00+00:00",
                "2026-10-10T10:00:00+00:00",
                None,
                "#7c3aed",
                vec![],
                vec![],
                None,
                None,
            )
            .expect("create");

        cal.delete(&event.id).expect("delete");
        assert!(cal.list().expect("list").is_empty());
    }

    #[test]
    fn rejects_empty_title() {
        let (cal, _dir) = store();
        let err = cal
            .create(
                "  ",
                "",
                false,
                "2026-10-10T09:00:00+00:00",
                "2026-10-10T10:00:00+00:00",
                None,
                "#7c3aed",
                vec![],
                vec![],
                None,
                None,
            )
            .expect_err("must reject");
        assert!(err.to_string().contains("title"));
    }

    #[test]
    fn rejects_end_before_start() {
        let (cal, _dir) = store();
        let err = cal
            .create(
                "X",
                "",
                false,
                "2026-10-10T10:00:00+00:00",
                "2026-10-10T09:00:00+00:00",
                None,
                "#7c3aed",
                vec![],
                vec![],
                None,
                None,
            )
            .expect_err("must reject");
        assert!(err.to_string().contains("before"));
    }

    #[test]
    fn rejects_invalid_color() {
        let (cal, _dir) = store();
        let err = cal
            .create(
                "X",
                "",
                false,
                "2026-10-10T09:00:00+00:00",
                "2026-10-10T10:00:00+00:00",
                None,
                "blue",
                vec![],
                vec![],
                None,
                None,
            )
            .expect_err("must reject");
        assert!(err.to_string().contains("color"));
    }

    #[test]
    fn list_is_sorted_by_start() {
        let (cal, _dir) = store();
        let later = cal
            .create(
                "Later",
                "",
                false,
                "2026-10-12T09:00:00+00:00",
                "2026-10-12T10:00:00+00:00",
                None,
                "#7c3aed",
                vec![],
                vec![],
                None,
                None,
            )
            .expect("create");
        let earlier = cal
            .create(
                "Earlier",
                "",
                false,
                "2026-10-08T09:00:00+00:00",
                "2026-10-08T10:00:00+00:00",
                None,
                "#7c3aed",
                vec![],
                vec![],
                None,
                None,
            )
            .expect("create");
        let list = cal.list().expect("list");
        assert_eq!(list[0].id, earlier.id);
        assert_eq!(list[1].id, later.id);
    }

    #[test]
    fn get_by_uid_finds_event() {
        let (cal, _dir) = store();
        let event = cal
            .create(
                "X",
                "",
                false,
                "2026-10-10T09:00:00+00:00",
                "2026-10-10T10:00:00+00:00",
                None,
                "#7c3aed",
                vec![],
                vec![],
                None,
                None,
            )
            .expect("create");
        let found = cal.get_by_uid(&event.uid).expect("lookup").expect("found");
        assert_eq!(found.id, event.id);
        let missing = cal.get_by_uid("nope@nope.local").expect("lookup");
        assert!(missing.is_none());
    }
}
