//! Desktop-notification scheduler for upcoming calendar events.
//!
//! Polls every 60s, fires a notification when an event's
//! pre-computed reminder trigger falls in the recent past and hasn't
//! already been delivered this session. Dedupe is by
//! `(event_id, lead_minutes)`. See `docs/CALENDAR_PLAN.md` §8.5 for
//! the rationale (no leaked timers, easy to reschedule, 60s
//! resolution is fine for a reminder).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::engine::calendar::Calendar;
use crate::engine::error::AetherError;

const SETTINGS_FILE: &str = "reminders.json";
const STATE_FILE: &str = "reminders_state.json";

/// User-configurable reminder behaviour.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReminderSettings {
    /// Master switch.
    pub enabled: bool,
    /// Lead times in minutes (e.g. `[15, 0]` = 15 min before + at start).
    pub lead_times_minutes: Vec<u32>,
}

impl Default for ReminderSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            lead_times_minutes: vec![15, 0],
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct DeliveredState {
    /// `(event_id, lead_minutes)` tuples.
    delivered: Vec<(String, u32)>,
}

/// Owns reminder settings + the scheduler task.
pub struct CalendarNotifier {
    app: AppHandle,
    settings_path: PathBuf,
    state_path: PathBuf,
    delivered: Mutex<HashSet<(String, u32)>>,
}

impl CalendarNotifier {
    /// Create the JSON files if missing, load both, and return a handle.
    pub fn new(app: &AppHandle, data_dir: &Path) -> Result<Self, AetherError> {
        let dir = data_dir.join("calendar");
        std::fs::create_dir_all(&dir)?;
        let settings_path = dir.join(SETTINGS_FILE);
        let state_path = dir.join(STATE_FILE);

        if !settings_path.exists() {
            let default = ReminderSettings::default();
            let json = serde_json::to_string_pretty(&default)
                .map_err(|e| AetherError::Vault(format!("settings serialize: {e}")))?;
            std::fs::write(&settings_path, json)?;
        }
        if !state_path.exists() {
            let json = serde_json::to_string_pretty(&DeliveredState::default())
                .map_err(|e| AetherError::Vault(format!("state serialize: {e}")))?;
            std::fs::write(&state_path, json)?;
        }

        let mut delivered = HashSet::new();
        if let Ok(content) = std::fs::read_to_string(&state_path) {
            if let Ok(parsed) = serde_json::from_str::<DeliveredState>(&content) {
                delivered.extend(parsed.delivered);
            }
        }

        Ok(Self {
            app: app.clone(),
            settings_path,
            state_path,
            delivered: Mutex::new(delivered),
        })
    }

    /// Read settings from disk.
    pub fn settings(&self) -> ReminderSettings {
        match std::fs::read_to_string(&self.settings_path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => ReminderSettings::default(),
        }
    }

    /// Persist settings to disk.
    pub fn set_settings(&self, settings: ReminderSettings) -> Result<(), AetherError> {
        let json = serde_json::to_string_pretty(&settings)
            .map_err(|e| AetherError::Vault(format!("settings serialize: {e}")))?;
        std::fs::write(&self.settings_path, json)?;
        Ok(())
    }

    /// Spawn the polling scheduler. Returns immediately; the task
    /// runs until the Tauri runtime shuts down.
    pub fn start(&self, calendar: Arc<Calendar>) -> Result<(), AetherError> {
        let app = self.app.clone();
        let state_path = self.state_path.clone();
        let delivered: Arc<Mutex<HashSet<(String, u32)>>> = Arc::new(Mutex::new(
            self.delivered.lock().expect("delivered lock").clone(),
        ));

        // Initial prune: drop delivered entries whose event no longer exists.
        if let Ok(events) = calendar.list() {
            let ids: HashSet<String> = events.iter().map(|e| e.id.clone()).collect();
            let mut d = delivered.lock().expect("delivered lock");
            let before = d.len();
            d.retain(|(id, _)| ids.contains(id));
            if d.len() != before {
                persist_state_inner(&state_path, &d);
            }
        }

        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(60));
            // First tick fires immediately; skip it so we don't
            // double-process anything right after startup.
            ticker.tick().await;

            loop {
                ticker.tick().await;

                let settings = match read_settings_static(&state_path) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                if !settings.enabled {
                    continue;
                }

                let events = match calendar.list() {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                let now = chrono::Utc::now();
                let window_start = now - chrono::Duration::seconds(60);
                let window_end = now + chrono::Duration::seconds(5);

                for event in &events {
                    let start = match chrono::DateTime::parse_from_rfc3339(&event.start) {
                        Ok(dt) => dt.with_timezone(&chrono::Utc),
                        Err(_) => continue,
                    };
                    for &lead in &settings.lead_times_minutes {
                        let trigger = start - chrono::Duration::minutes(lead as i64);
                        if trigger >= window_start && trigger <= window_end {
                            let key = (event.id.clone(), lead);
                            let mut d = delivered.lock().expect("delivered lock");
                            if d.contains(&key) {
                                continue;
                            }
                            d.insert(key);
                            drop(d);
                            fire_notification(&app, event, lead);
                            persist_state(&state_path, &delivered);
                        }
                    }
                }
            }
        });
        Ok(())
    }

    /// No-op for the polling design — the next tick will re-evaluate.
    /// Documented for symmetry with the plan.
    pub fn reschedule(&self) {}

    /// Drop delivered entries for a deleted event.
    pub fn prune_delivered(&self, event_id: &str) {
        let mut d = self.delivered.lock().expect("delivered lock");
        d.retain(|(id, _)| id != event_id);
        persist_state_inner(&self.state_path, &d);
    }
}

fn fire_notification(app: &AppHandle, event: &crate::engine::calendar::CalendarEvent, lead: u32) {
    let title = format!("Upcoming: {}", event.title);
    let body = if lead == 0 {
        format!("Starting now ({})", event.start)
    } else {
        format!("In {lead} minutes ({})", event.start)
    };
    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| eprintln!("notification failed: {e}"));
}

fn persist_state(path: &Path, delivered: &Arc<Mutex<HashSet<(String, u32)>>>) {
    let d = delivered.lock().expect("delivered lock");
    persist_state_inner(path, &d);
}

fn persist_state_inner(path: &Path, delivered: &HashSet<(String, u32)>) {
    let state = DeliveredState {
        delivered: delivered.iter().cloned().collect(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = std::fs::write(path, json);
    }
}

fn read_settings_static(path: &Path) -> Result<ReminderSettings, AetherError> {
    let content = std::fs::read_to_string(path)?;
    serde_json::from_str(&content)
        .map_err(|e| AetherError::Vault(format!("settings parse: {e}")))
}

// --- Test-only helpers ---------------------------------------------------

#[cfg(test)]
mod test_support {
    use super::*;

    /// Build a notifier-shaped object without an `AppHandle`. Tests
    /// only exercise the IO methods, none of which touch `app`.
    pub fn notifier_for_io(settings_path: PathBuf, state_path: PathBuf) -> TestNotifier {
        if !settings_path.exists() {
            std::fs::write(
                &settings_path,
                serde_json::to_string_pretty(&ReminderSettings::default()).unwrap(),
            )
            .unwrap();
        }
        if !state_path.exists() {
            std::fs::write(
                &state_path,
                serde_json::to_string_pretty(&DeliveredState::default()).unwrap(),
            )
            .unwrap();
        }
        TestNotifier {
            settings_path,
            state_path,
        }
    }

    pub struct TestNotifier {
        pub settings_path: PathBuf,
        #[allow(dead_code)]
        pub state_path: PathBuf,
    }

    impl TestNotifier {
        pub fn read_settings(&self) -> ReminderSettings {
            match std::fs::read_to_string(&self.settings_path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => ReminderSettings::default(),
            }
        }
        pub fn write_settings(&self, settings: &ReminderSettings) -> Result<(), AetherError> {
            let json = serde_json::to_string_pretty(settings)
                .map_err(|e| AetherError::Vault(format!("settings serialize: {e}")))?;
            std::fs::write(&self.settings_path, json)?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{notifier_for_io, TestNotifier};
    use super::{ReminderSettings, SETTINGS_FILE, STATE_FILE};

    fn fresh_dir() -> (tempfile::TempDir, TestNotifier) {
        let dir = tempfile::tempdir().expect("temp dir");
        let cal_dir = dir.path().join("calendar");
        std::fs::create_dir_all(&cal_dir).expect("mkdir");
        let n = notifier_for_io(cal_dir.join(SETTINGS_FILE), cal_dir.join(STATE_FILE));
        (dir, n)
    }

    #[test]
    fn settings_round_trip() {
        let (_dir, n) = fresh_dir();
        let mut s = n.read_settings();
        s.enabled = true;
        s.lead_times_minutes = vec![30, 10, 0];
        n.write_settings(&s).expect("set");

        // Reopen the dir to simulate a fresh process.
        let dir2 = tempfile::tempdir().expect("temp dir");
        let cal_dir2 = dir2.path().join("calendar");
        std::fs::create_dir_all(&cal_dir2).expect("mkdir");
        // Copy the previously written settings file across.
        let src = n.settings_path.clone();
        let dst = cal_dir2.join(SETTINGS_FILE);
        std::fs::copy(&src, &dst).expect("copy");
        let dst_state = cal_dir2.join(STATE_FILE);
        std::fs::write(&dst_state, "{}").expect("write");

        let n2 = notifier_for_io(dst, dst_state);
        let s2 = n2.read_settings();
        assert!(s2.enabled);
        assert_eq!(s2.lead_times_minutes, vec![30, 10, 0]);
    }

    #[test]
    fn default_settings_disabled() {
        let (_dir, n) = fresh_dir();
        let s = n.read_settings();
        assert!(!s.enabled);
        assert_eq!(s.lead_times_minutes, vec![15, 0]);
    }

    #[test]
    fn lead_times_persisted() {
        let (_dir, n) = fresh_dir();
        n.write_settings(&ReminderSettings {
            enabled: true,
            lead_times_minutes: vec![60, 5],
        })
        .expect("set");
        let content = std::fs::read_to_string(&n.settings_path).expect("read");
        assert!(content.contains("60"));
        assert!(content.contains("5"));
    }
}
