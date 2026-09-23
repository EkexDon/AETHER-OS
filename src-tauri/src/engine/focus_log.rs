//! Focus (Pomodoro) session log.
//!
//! Every completed Pomodoro phase is appended as one JSON object per line to
//! `<storage_dir>/sessions.jsonl` (the app wires `storage_dir` to
//! `<data_dir>/focus`). The file is append-only, so a crash can at worst
//! leave one truncated trailing line; readers skip malformed lines and the
//! writer starts a fresh line when the previous one was cut off.
//!
//! Statistics are derived on demand: minutes and session counts per local
//! calendar day, today's totals and the current streak of consecutive days
//! with at least one completed work session. Only `work` sessions count
//! towards minutes and streaks; breaks are logged for completeness.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Duration, FixedOffset, Local, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

/// File name of the session log inside the storage directory.
pub const SESSIONS_FILE: &str = "sessions.jsonl";
/// Longest accepted session (a whole day).
pub const MAX_SESSION_MINUTES: u32 = 24 * 60;
/// Largest window `stats` aggregates over.
pub const MAX_STATS_DAYS: u32 = 366;
/// Largest page `list` returns.
pub const MAX_LIST_LIMIT: u32 = 1000;
/// Longest accepted `note_path` (bytes).
const MAX_NOTE_PATH_LEN: usize = 4096;

/// What a logged session was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FocusKind {
    /// A focused work interval (counts towards statistics).
    Work,
    /// A short break between work intervals.
    Break,
    /// The long break after a full cycle of work intervals.
    LongBreak,
}

/// One completed session as stored in `sessions.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FocusSession {
    /// UUID v4.
    pub id: String,
    /// RFC 3339 start, normalised to the local UTC offset at logging time.
    pub started_at: String,
    /// RFC 3339 end, normalised like `started_at`.
    pub ended_at: String,
    /// Whole minutes of the session (at least 1).
    pub minutes: u32,
    pub kind: FocusKind,
    /// Absolute path of the note that was open while focusing, if any.
    /// Stored as metadata only; it is never used to access the file system.
    #[serde(default)]
    pub note_path: Option<String>,
}

/// A session to append, as sent by the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct FocusSessionInput {
    /// RFC 3339 timestamp.
    pub started_at: String,
    /// RFC 3339 timestamp, not before `started_at`.
    pub ended_at: String,
    /// Whole minutes; derived from the timestamps when omitted.
    #[serde(default)]
    pub minutes: Option<u32>,
    pub kind: FocusKind,
    #[serde(default)]
    pub note_path: Option<String>,
}

/// Work minutes on one local calendar day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FocusDay {
    /// `YYYY-MM-DD`.
    pub date: String,
    pub minutes: u32,
    /// Completed work sessions that day.
    pub sessions: u32,
}

/// Aggregated focus statistics for the Home dashboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FocusStats {
    /// Work minutes logged today.
    pub today_minutes: u32,
    /// Work sessions completed today.
    pub today_sessions: u32,
    /// Consecutive days with at least one work session, ending today — or
    /// yesterday when nothing has been logged yet today.
    pub streak_days: u32,
    /// Work minutes across the whole `by_day` window.
    pub total_minutes: u32,
    /// One entry per day of the window, oldest first, ending today.
    pub by_day: Vec<FocusDay>,
}

/// Append-only focus session log.
pub struct FocusLog {
    path: PathBuf,
    /// Serialises appends so concurrent commands never interleave lines.
    write_lock: Mutex<()>,
}

impl FocusLog {
    /// Open (and create) the log inside `storage_dir`.
    pub fn new(storage_dir: &Path) -> Result<Self, AetherError> {
        std::fs::create_dir_all(storage_dir)?;
        Ok(Self {
            path: storage_dir.join(SESSIONS_FILE),
            write_lock: Mutex::new(()),
        })
    }

    /// Path of the JSONL file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Validate `input` and append it as a new session.
    pub fn log_session(&self, input: FocusSessionInput) -> Result<FocusSession, AetherError> {
        let session = validate_input(input)?;
        let mut line = serde_json::to_string(&session)
            .map_err(|e| AetherError::InvalidInput(format!("focus session serialize: {e}")))?;
        line.push('\n');

        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| AetherError::InvalidInput("focus log lock poisoned".to_owned()))?;
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&self.path)?;
        if !ends_with_newline(&mut file)? {
            // The previous write was cut off; start a clean line so the new
            // record does not merge with the broken one.
            line.insert(0, '\n');
        }
        file.write_all(line.as_bytes())?;
        file.flush()?;
        Ok(session)
    }

    /// All readable sessions in file (append) order. Malformed lines are
    /// skipped.
    pub fn sessions(&self) -> Result<Vec<FocusSession>, AetherError> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut sessions = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(session) = serde_json::from_str::<FocusSession>(trimmed) {
                sessions.push(session);
            }
        }
        Ok(sessions)
    }

    /// The most recent sessions (by end time), newest first. `limit` is
    /// clamped to `1..=MAX_LIST_LIMIT`.
    pub fn list(&self, limit: u32) -> Result<Vec<FocusSession>, AetherError> {
        let limit = limit.clamp(1, MAX_LIST_LIMIT) as usize;
        let mut sessions: Vec<(Option<DateTime<FixedOffset>>, usize, FocusSession)> = self
            .sessions()?
            .into_iter()
            .enumerate()
            .map(|(i, s)| (parse_ts(&s.ended_at).ok(), i, s))
            .collect();
        // Newest end first; unparsable timestamps sink; ties keep newest
        // appended first.
        sessions.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        Ok(sessions
            .into_iter()
            .take(limit)
            .map(|(_, _, s)| s)
            .collect())
    }

    /// Statistics over the last `days` days (clamped to
    /// `1..=MAX_STATS_DAYS`) ending on `today`.
    pub fn stats(&self, days: u32, today: NaiveDate) -> Result<FocusStats, AetherError> {
        Ok(compute_stats(&self.sessions()?, today, days))
    }
}

/// Aggregate `sessions` into [`FocusStats`] for the `days`-day window
/// ending on `today`. Pure, so it is tested without touching disk.
pub fn compute_stats(sessions: &[FocusSession], today: NaiveDate, days: u32) -> FocusStats {
    let days = days.clamp(1, MAX_STATS_DAYS);
    let mut per_day: BTreeMap<NaiveDate, (u32, u32)> = BTreeMap::new();
    for session in sessions.iter().filter(|s| s.kind == FocusKind::Work) {
        let Some(date) = session_date(session) else {
            continue;
        };
        let entry = per_day.entry(date).or_insert((0, 0));
        entry.0 = entry.0.saturating_add(session.minutes);
        entry.1 = entry.1.saturating_add(1);
    }

    let by_day: Vec<FocusDay> = (0..days)
        .rev()
        .map(|offset| {
            let date = today - Duration::days(i64::from(offset));
            let (minutes, count) = per_day.get(&date).copied().unwrap_or((0, 0));
            FocusDay {
                date: date.format("%Y-%m-%d").to_string(),
                minutes,
                sessions: count,
            }
        })
        .collect();

    let (today_minutes, today_sessions) = per_day.get(&today).copied().unwrap_or((0, 0));
    let active: BTreeSet<NaiveDate> = per_day
        .iter()
        .filter(|(_, (minutes, _))| *minutes > 0)
        .map(|(date, _)| *date)
        .collect();

    FocusStats {
        today_minutes,
        today_sessions,
        streak_days: streak_days(&active, today),
        total_minutes: by_day.iter().map(|d| d.minutes).sum(),
        by_day,
    }
}

/// Length of the run of consecutive active days ending on `today`, or on
/// the day before when `today` itself is not (yet) active. Days in the
/// future are ignored.
pub fn streak_days(active: &BTreeSet<NaiveDate>, today: NaiveDate) -> u32 {
    let mut day = if active.contains(&today) {
        today
    } else {
        today - Duration::days(1)
    };
    let mut streak = 0;
    while active.contains(&day) {
        streak += 1;
        day -= Duration::days(1);
    }
    streak
}

/// Local calendar date a session belongs to: the date of `started_at` in
/// the UTC offset it was recorded with.
fn session_date(session: &FocusSession) -> Option<NaiveDate> {
    parse_ts(&session.started_at).ok().map(|ts| ts.date_naive())
}

fn parse_ts(value: &str) -> Result<DateTime<FixedOffset>, AetherError> {
    DateTime::parse_from_rfc3339(value.trim())
        .map_err(|e| AetherError::InvalidInput(format!("invalid timestamp \"{value}\": {e}")))
}

/// Check an incoming session and turn it into a stored record.
fn validate_input(input: FocusSessionInput) -> Result<FocusSession, AetherError> {
    let started = parse_ts(&input.started_at)?;
    let ended = parse_ts(&input.ended_at)?;
    if ended < started {
        return Err(AetherError::InvalidInput(
            "ended_at must not be before started_at".to_owned(),
        ));
    }
    let span_seconds = (ended - started).num_seconds();
    // Round to the nearest minute; a session never exceeds its span by
    // more than that rounding.
    let span_minutes = u32::try_from((span_seconds + 30) / 60).unwrap_or(u32::MAX);
    let minutes = input.minutes.unwrap_or(span_minutes);
    if minutes == 0 {
        return Err(AetherError::InvalidInput(
            "a focus session must last at least one minute".to_owned(),
        ));
    }
    if minutes > MAX_SESSION_MINUTES {
        return Err(AetherError::InvalidInput(format!(
            "a focus session cannot exceed {MAX_SESSION_MINUTES} minutes"
        )));
    }
    if minutes > span_minutes.saturating_add(1) {
        return Err(AetherError::InvalidInput(format!(
            "{minutes} minutes do not fit between started_at and ended_at"
        )));
    }

    let note_path = match input.note_path {
        Some(path) => {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                None
            } else if trimmed.len() > MAX_NOTE_PATH_LEN || trimmed.chars().any(char::is_control) {
                return Err(AetherError::InvalidInput(
                    "note_path must be a single line of at most 4096 bytes".to_owned(),
                ));
            } else {
                Some(trimmed.to_owned())
            }
        }
        None => None,
    };

    Ok(FocusSession {
        id: uuid::Uuid::new_v4().to_string(),
        started_at: started.with_timezone(&Local).to_rfc3339(),
        ended_at: ended.with_timezone(&Local).to_rfc3339(),
        minutes,
        kind: input.kind,
        note_path,
    })
}

/// True when `file` is empty or its last byte is `\n`.
fn ends_with_newline(file: &mut File) -> Result<bool, AetherError> {
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(true);
    }
    file.seek(SeekFrom::Start(len - 1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    Ok(last[0] == b'\n')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").expect("date")
    }

    fn session(started_at: &str, minutes: u32, kind: FocusKind) -> FocusSession {
        FocusSession {
            id: format!("id-{started_at}-{minutes}"),
            started_at: started_at.to_owned(),
            ended_at: started_at.to_owned(),
            minutes,
            kind,
            note_path: None,
        }
    }

    fn work(started_at: &str, minutes: u32) -> FocusSession {
        session(started_at, minutes, FocusKind::Work)
    }

    fn input(started_at: &str, ended_at: &str, minutes: Option<u32>) -> FocusSessionInput {
        FocusSessionInput {
            started_at: started_at.to_owned(),
            ended_at: ended_at.to_owned(),
            minutes,
            kind: FocusKind::Work,
            note_path: None,
        }
    }

    #[test]
    fn streak_counts_consecutive_days_ending_today() {
        let active: BTreeSet<NaiveDate> = ["2026-09-20", "2026-09-21", "2026-09-22"]
            .iter()
            .map(|d| date(d))
            .collect();
        assert_eq!(streak_days(&active, date("2026-09-22")), 3);
    }

    #[test]
    fn streak_survives_until_today_is_logged() {
        let active: BTreeSet<NaiveDate> = ["2026-09-20", "2026-09-21"]
            .iter()
            .map(|d| date(d))
            .collect();
        // Nothing logged yet today: yesterday's run still counts.
        assert_eq!(streak_days(&active, date("2026-09-22")), 2);
    }

    #[test]
    fn streak_breaks_on_a_gap() {
        let active: BTreeSet<NaiveDate> = ["2026-09-15", "2026-09-16", "2026-09-18", "2026-09-19"]
            .iter()
            .map(|d| date(d))
            .collect();
        assert_eq!(streak_days(&active, date("2026-09-19")), 2);
        // Two days without focus reset the streak entirely.
        assert_eq!(streak_days(&active, date("2026-09-21")), 0);
    }

    #[test]
    fn streak_crosses_month_and_year_boundaries() {
        let active: BTreeSet<NaiveDate> = ["2025-12-30", "2025-12-31", "2026-01-01"]
            .iter()
            .map(|d| date(d))
            .collect();
        assert_eq!(streak_days(&active, date("2026-01-01")), 3);
        assert_eq!(streak_days(&BTreeSet::new(), date("2026-01-01")), 0);
    }

    #[test]
    fn stats_aggregate_work_minutes_per_local_day() {
        let sessions = vec![
            work("2026-09-22T09:00:00+02:00", 25),
            work("2026-09-22T09:30:00+02:00", 25),
            session("2026-09-22T09:25:00+02:00", 5, FocusKind::Break),
            session("2026-09-22T10:00:00+02:00", 15, FocusKind::LongBreak),
            work("2026-09-21T23:50:00+02:00", 25),
            work("2026-09-19T08:00:00+02:00", 50),
        ];
        let stats = compute_stats(&sessions, date("2026-09-22"), 7);
        assert_eq!(stats.today_minutes, 50);
        assert_eq!(stats.today_sessions, 2);
        assert_eq!(stats.streak_days, 2);
        assert_eq!(stats.total_minutes, 125);
        assert_eq!(stats.by_day.len(), 7);
        assert_eq!(
            stats.by_day.first().map(|d| d.date.as_str()),
            Some("2026-09-16")
        );
        let last = stats.by_day.last().expect("today");
        assert_eq!(
            (last.date.as_str(), last.minutes, last.sessions),
            ("2026-09-22", 50, 2)
        );
        let sept_19 = stats
            .by_day
            .iter()
            .find(|d| d.date == "2026-09-19")
            .expect("19th");
        assert_eq!(sept_19.minutes, 50);
        let sept_20 = stats
            .by_day
            .iter()
            .find(|d| d.date == "2026-09-20")
            .expect("20th");
        assert_eq!((sept_20.minutes, sept_20.sessions), (0, 0));
    }

    #[test]
    fn stats_use_the_recorded_offset_for_the_day() {
        // 23:30 local on the 21st is already the 22nd in UTC; it must count
        // for the 21st.
        let sessions = vec![work("2026-09-21T23:30:00-04:00", 30)];
        let stats = compute_stats(&sessions, date("2026-09-22"), 2);
        assert_eq!(stats.by_day[0].date, "2026-09-21");
        assert_eq!(stats.by_day[0].minutes, 30);
        assert_eq!(stats.today_minutes, 0);
        assert_eq!(stats.streak_days, 1);
    }

    #[test]
    fn stats_window_is_clamped_and_ignores_sessions_outside_it() {
        let sessions = vec![
            work("2026-01-01T10:00:00+00:00", 25),
            work("not a timestamp", 25),
        ];
        let stats = compute_stats(&sessions, date("2026-09-22"), 0);
        assert_eq!(stats.by_day.len(), 1);
        assert_eq!(stats.total_minutes, 0);
        let wide = compute_stats(&sessions, date("2026-09-22"), 10_000);
        assert_eq!(wide.by_day.len(), MAX_STATS_DAYS as usize);
        assert_eq!(wide.total_minutes, 25);
    }

    #[test]
    fn log_session_appends_and_reads_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = FocusLog::new(&dir.path().join("focus")).expect("log");
        assert!(log.sessions().expect("empty").is_empty());

        let first = log
            .log_session(input(
                "2026-09-22T09:00:00+02:00",
                "2026-09-22T09:25:00+02:00",
                None,
            ))
            .expect("first");
        assert_eq!(first.minutes, 25);
        assert_eq!(first.kind, FocusKind::Work);
        let second = log
            .log_session(FocusSessionInput {
                kind: FocusKind::Break,
                note_path: Some("  /vault/daily/2026-09-22.md ".to_owned()),
                ..input(
                    "2026-09-22T09:25:00+02:00",
                    "2026-09-22T09:30:00+02:00",
                    Some(5),
                )
            })
            .expect("second");
        assert_eq!(
            second.note_path.as_deref(),
            Some("/vault/daily/2026-09-22.md")
        );
        assert_ne!(first.id, second.id);

        let all = log.sessions().expect("sessions");
        assert_eq!(all, vec![first.clone(), second.clone()]);
        let raw = std::fs::read_to_string(log.path()).expect("raw");
        assert_eq!(raw.lines().count(), 2);
        assert!(raw.ends_with('\n'));

        // Timestamps are normalised but keep the same instant.
        let started = parse_ts(&first.started_at).expect("started");
        assert_eq!(
            started,
            parse_ts("2026-09-22T09:00:00+02:00").expect("expected")
        );
    }

    #[test]
    fn list_returns_newest_first_with_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = FocusLog::new(dir.path()).expect("log");
        for (start, end) in [
            ("2026-09-20T09:00:00Z", "2026-09-20T09:25:00Z"),
            ("2026-09-22T09:00:00Z", "2026-09-22T09:25:00Z"),
            ("2026-09-21T09:00:00Z", "2026-09-21T09:25:00Z"),
        ] {
            log.log_session(input(start, end, None)).expect("log");
        }
        let newest = log.list(2).expect("list");
        assert_eq!(newest.len(), 2);
        let days: Vec<NaiveDate> = newest
            .iter()
            .map(|s| {
                parse_ts(&s.ended_at)
                    .expect("ts")
                    .with_timezone(&chrono::Utc)
                    .date_naive()
            })
            .collect();
        assert_eq!(days, vec![date("2026-09-22"), date("2026-09-21")]);
        assert_eq!(log.list(0).expect("clamped").len(), 1);
    }

    #[test]
    fn malformed_and_truncated_lines_are_skipped_and_repaired() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = FocusLog::new(dir.path()).expect("log");
        let good = log
            .log_session(input("2026-09-22T09:00:00Z", "2026-09-22T09:25:00Z", None))
            .expect("good");
        // Simulate a crash in the middle of a write: no trailing newline.
        let mut file = OpenOptions::new()
            .append(true)
            .open(log.path())
            .expect("open");
        file.write_all(b"{\"id\":\"broken\",\"started_")
            .expect("write");
        drop(file);

        let next = log
            .log_session(input("2026-09-22T10:00:00Z", "2026-09-22T10:25:00Z", None))
            .expect("next");
        let sessions = log.sessions().expect("sessions");
        assert_eq!(sessions, vec![good, next]);
        let raw = std::fs::read_to_string(log.path()).expect("raw");
        assert_eq!(raw.lines().count(), 3);
    }

    #[test]
    fn stats_read_from_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = FocusLog::new(dir.path()).expect("log");
        let today = Local::now().date_naive();
        let start = today
            .and_hms_opt(9, 0, 0)
            .expect("time")
            .and_local_timezone(Local)
            .single()
            .expect("unambiguous local time");
        let end = start + Duration::minutes(25);
        log.log_session(input(&start.to_rfc3339(), &end.to_rfc3339(), None))
            .expect("log");
        let stats = log.stats(7, today).expect("stats");
        assert_eq!(stats.today_minutes, 25);
        assert_eq!(stats.today_sessions, 1);
        assert_eq!(stats.streak_days, 1);
    }

    #[test]
    fn rejects_invalid_sessions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = FocusLog::new(dir.path()).expect("log");
        let cases = [
            input("yesterday", "2026-09-22T09:25:00Z", None),
            input("2026-09-22T09:25:00Z", "2026-09-22T09:00:00Z", None),
            input("2026-09-22T09:00:00Z", "2026-09-22T09:00:20Z", None),
            input("2026-09-22T09:00:00Z", "2026-09-22T09:25:00Z", Some(0)),
            input("2026-09-22T09:00:00Z", "2026-09-22T09:25:00Z", Some(40)),
            input("2026-09-20T09:00:00Z", "2026-09-22T09:00:00Z", None),
            FocusSessionInput {
                note_path: Some("a\nb".to_owned()),
                ..input("2026-09-22T09:00:00Z", "2026-09-22T09:25:00Z", None)
            },
        ];
        for case in cases {
            let err = log.log_session(case).expect_err("must be rejected");
            assert!(err.to_string().starts_with("invalid input: "), "{err}");
        }
        assert!(log.sessions().expect("sessions").is_empty());
    }

    #[test]
    fn blank_note_path_is_dropped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = FocusLog::new(dir.path()).expect("log");
        let s = log
            .log_session(FocusSessionInput {
                note_path: Some("   ".to_owned()),
                ..input("2026-09-22T09:00:00Z", "2026-09-22T09:25:00Z", None)
            })
            .expect("log");
        assert_eq!(s.note_path, None);
    }

    #[test]
    fn serialises_kinds_in_snake_case() {
        let json = serde_json::to_string(&FocusKind::LongBreak).expect("json");
        assert_eq!(json, "\"long_break\"");
        let parsed: FocusSessionInput = serde_json::from_str(
            r#"{"started_at":"2026-09-22T09:00:00Z","ended_at":"2026-09-22T09:25:00Z","kind":"work"}"#,
        )
        .expect("input");
        assert_eq!(parsed.kind, FocusKind::Work);
        assert_eq!(parsed.minutes, None);
    }
}
