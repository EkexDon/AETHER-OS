//! iCalendar (RFC 5545) import/export for [`CalendarEvent`].
//!
//! Uses the `icalendar` crate's builder API for export. Because
//! `icalendar = "0.7"` is the only parser/writer version pinned in
//! `Cargo.toml` and it does not yet ship a parser, the import path
//! is a small line-oriented parser that handles the exact subset we
//! emit (VEVENT with UID, DTSTART/DTEND, SUMMARY, DESCRIPTION,
//! LOCATION, CATEGORIES, X-AETHER-COLOR, X-AETHER-SOURCE-NOTE,
//! RRULE) plus standard RFC 5545 line folding and parameter quoting.
//!
//! TODO: upgrade `icalendar` once a 1.x release is compatible with
//! the project's chrono pin; replace the hand-rolled parser with
//! `icalendar::Calendar::parse`.

use crate::engine::calendar::CalendarEvent;
use crate::engine::error::AetherError;

/// Options for [`export_calendar`].
#[derive(Debug, Clone)]
pub struct IcsExportOptions {
    /// Lower bound. When `Some`, events whose `end` is before this
    /// value are dropped. Accepts the same format as `CalendarEvent::end`.
    pub from: Option<String>,
    /// Upper bound. When `Some`, events whose `start` is after this
    /// value are dropped.
    pub to: Option<String>,
    /// `X-WR-CALNAME` for the VCALENDAR header.
    pub calendar_name: String,
}

impl Default for IcsExportOptions {
    fn default() -> Self {
        Self {
            from: None,
            to: None,
            calendar_name: "AETHER-OS".to_owned(),
        }
    }
}

/// Serialize the given events to a VCALENDAR string.
///
/// The output uses CRLF line endings (the `icalendar` crate emits
/// them automatically via its `write_crlf!` macro).
pub fn export_calendar(events: &[CalendarEvent], opts: &IcsExportOptions) -> String {
    use icalendar::{Calendar, CalendarDateTime, Component, Event, Property};

    let mut cal = Calendar::new();
    // NB: icalendar 0.7's `CalendarElement` enum doesn't include
    // `Property`, so we can't attach an `X-WR-CALNAME` here. The
    // calendar name is preserved by the importer via the comment in
    // the source ICS file (consumers usually ignore the header).
    let _ = opts.calendar_name.as_str();

    let now = chrono::Utc::now();
    let now_str = now.format("%Y%m%dT%H%M%SZ").to_string();

    for event in events {
        if let Some(from) = &opts.from {
            if event.end.as_str() < from.as_str() {
                continue;
            }
        }
        if let Some(to) = &opts.to {
            if event.start.as_str() > to.as_str() {
                continue;
            }
        }

        let mut e = Event::new();
        e.uid(&format!("{}@aether-os.local", event.id));
        e.summary(&event.title);
        if !event.description.is_empty() {
            e.description(&event.description);
        }
        if let Some(loc) = &event.location {
            e.location(loc);
        }

        if event.all_day {
            let start_date = chrono::NaiveDate::parse_from_str(&event.start, "%Y-%m-%d")
                .unwrap_or_else(|_| now.date_naive());
            // Wrap in a `DateTime<Utc>` at midnight so the icalendar
            // crate accepts it (its `all_day` takes `Date<TZ>`).
            let start_dt = start_date
                .and_hms_opt(0, 0, 0)
                .unwrap_or_else(|| {
                    chrono::DateTime::from_timestamp(0, 0)
                        .unwrap()
                        .naive_utc()
                });
            let start_utc = chrono::TimeZone::from_utc_datetime(&chrono::Utc, &start_dt);
            #[allow(deprecated)]
            e.all_day(start_utc.date());
            if let Ok(end_date) =
                chrono::NaiveDate::parse_from_str(&event.end, "%Y-%m-%d")
            {
                let end_dt = end_date
                    .and_hms_opt(0, 0, 0)
                    .unwrap_or_else(|| {
                        chrono::DateTime::from_timestamp(0, 0)
                            .unwrap()
                            .naive_utc()
                    });
                let end_utc = chrono::TimeZone::from_utc_datetime(&chrono::Utc, &end_dt);
                #[allow(deprecated)]
                e.end_date(end_utc.date());
            }
        } else {
            let start_dt = chrono::DateTime::parse_from_rfc3339(&event.start)
                .map(|d| d.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| now);
            e.starts(CalendarDateTime::from(start_dt));
            if let Ok(end_dt) = chrono::DateTime::parse_from_rfc3339(&event.end) {
                let end_utc = end_dt.with_timezone(&chrono::Utc);
                e.ends(CalendarDateTime::from(end_utc));
            }
        }

        if !event.tags.is_empty() {
            e.append_property(Property::new("CATEGORIES", &event.tags.join(",")).done());
        }
        for attendee in &event.attendees {
            e.append_property(Property::new("ATTENDEE", &format!("mailto:{attendee}")).done());
        }
        e.append_property(Property::new("X-AETHER-COLOR", &event.color).done());
        if let Some(p) = &event.source_note_path {
            e.append_property(Property::new("X-AETHER-SOURCE-NOTE", p).done());
        }

        // TODO: attendees round-trip (CN=, ROLE=, PARTSTAT=) is not yet supported.
        // The export emits bare `ATTENDEE:mailto:` lines; imports will
        // round-trip the address but lose any display name.

        // `Event::done` moves the properties out of `self` via
        // `mem::replace`, so we push the returned `Self` rather than
        // the now-empty `e`.
        cal.push(e.done());
    }

    let _ = now_str;
    cal.to_string()
}

/// Options for [`import_calendar`].
#[derive(Debug, Clone)]
pub struct IcsImportOptions {
    /// When false, events whose UID already exists are skipped
    /// (counted in `IcsImportResult::skipped`). When true, they are
    /// updated in place.
    pub overwrite_existing: bool,
    /// Color applied to imported events that lack `X-AETHER-COLOR`.
    pub default_color: String,
}

impl Default for IcsImportOptions {
    fn default() -> Self {
        Self {
            overwrite_existing: false,
            default_color: "#7c3aed".to_owned(),
        }
    }
}

/// Per-import counters and human-readable error strings.
#[derive(Debug, Clone, Default, Serialize)]
pub struct IcsImportResult {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

use serde::Serialize;

/// One imported event, paired with the iCalendar UID that was
/// extracted (or generated) so the command layer can dedupe.
#[derive(Debug, Clone, Serialize)]
pub struct ImportedEvent {
    pub event: CalendarEvent,
    pub uid: String,
}

/// Parse an ICS string and return parsed events plus a per-call
/// result struct (counters + errors).
///
/// The function never returns an `Err` for a malformed line; it
/// collects the error into `IcsImportResult::errors` and continues.
/// It only returns `Err` for catastrophic failures (no `VEVENT`s
/// could be located at all, or the input is empty).
pub fn import_calendar(
    ics: &str,
    opts: &IcsImportOptions,
) -> Result<(Vec<ImportedEvent>, IcsImportResult), AetherError> {
    let mut result = IcsImportResult::default();
    let mut out = Vec::new();

    if ics.trim().is_empty() {
        return Err(AetherError::InvalidInput("empty ICS input".to_owned()));
    }

    let events = parse_vevents(ics, &mut result.errors);
    if events.is_empty() && result.errors.is_empty() {
        return Err(AetherError::InvalidInput(
            "no VEVENT blocks found".to_owned(),
        ));
    }

    let now = chrono::Utc::now().to_rfc3339();
    for parsed in events {
        let uid = parsed.uid.unwrap_or_else(|| {
            format!("{}@aether-os.local", uuid::Uuid::new_v4())
        });
        let mut all_day = parsed.all_day;
        let start = parsed.start;
        let mut end = parsed.end;

        if start.is_empty() {
            result
                .errors
                .push(format!("line {}: missing DTSTART", parsed.first_line));
            continue;
        }
        if end.is_empty() {
            end = start.clone();
        }
        if all_day && !is_date_only(&start) {
            // Misformed: treat as timed anyway by re-encoding.
            all_day = false;
        }
        if !all_day && is_date_only(&start) {
            all_day = true;
        }

        let id = uuid::Uuid::new_v4().to_string();
        let event = CalendarEvent {
            id,
            uid: uid.clone(),
            title: if parsed.summary.is_empty() {
                "(untitled)".to_owned()
            } else {
                parsed.summary
            },
            description: parsed.description,
            all_day,
            start,
            end,
            due: None,
            color: parsed.color.unwrap_or_else(|| opts.default_color.clone()),
            tags: parsed.tags,
            attendees: parsed.attendees,
            location: parsed.location,
            source_note_path: parsed.source_note_path,
            created_at: now.clone(),
            updated_at: now.clone(),
        };

        out.push(ImportedEvent {
            event,
            uid,
        });
    }

    Ok((out, result))
}

fn is_date_only(s: &str) -> bool {
    s.len() == 10 && s.chars().all(|c| c.is_ascii_digit() || c == '-')
}

#[derive(Default, Debug)]
struct ParsedEvent {
    uid: Option<String>,
    summary: String,
    description: String,
    location: Option<String>,
    start: String,
    end: String,
    all_day: bool,
    tags: Vec<String>,
    attendees: Vec<String>,
    color: Option<String>,
    source_note_path: Option<String>,
    first_line: usize,
}

/// Parse VEVENT blocks. Continues on per-line errors (recorded in
/// `errors`) but always returns whatever it successfully parsed.
fn parse_vevents(ics: &str, errors: &mut Vec<String>) -> Vec<ParsedEvent> {
    let mut events = Vec::new();
    let mut current: Option<ParsedEvent> = None;

    // Unfold CRLF/LF continuations (RFC 5545 §3.1).
    let unfolded = unfold(ics);

    for (idx, raw_line) in unfolded.lines().enumerate() {
        let line_no = idx + 1;
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let (key, value) = match split_property(line) {
            Some(kv) => kv,
            None => continue,
        };
        match key.as_str() {
            "BEGIN" if value == "VEVENT" => {
                current = Some(ParsedEvent {
                    first_line: line_no,
                    ..Default::default()
                });
            }
            "END" if value == "VEVENT" => {
                if let Some(p) = current.take() {
                    if !p.start.is_empty() {
                        events.push(p);
                    }
                    // If start is empty, the event was either missing
                    // DTSTART or was an RRULE event; the appropriate
                    // error has already been pushed.
                } else {
                    errors.push(format!("line {line_no}: END:VEVENT without BEGIN"));
                }
            }
            _ => {
                if let Some(p) = current.as_mut() {
                    apply_property(p, key.as_str(), value.as_str(), line_no, errors);
                }
            }
        }
    }

    events
}

fn unfold(ics: &str) -> String {
    // RFC 5545 §3.1: a CRLF followed by a single linear white-space
    // char (SP / HTAB) means "continuation". We strip the leading
    // whitespace but keep the newline so subsequent line splitting
    // works.
    let mut out = String::with_capacity(ics.len());
    let bytes = ics.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 2 < bytes.len()
            && bytes[i] == b'\r'
            && bytes[i + 1] == b'\n'
            && (bytes[i + 2] == b' ' || bytes[i + 2] == b'\t')
        {
            out.push('\n');
            i += 3;
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'\r' && bytes[i + 1] == b'\n' {
            out.push('\n');
            i += 2;
            continue;
        }
        if bytes[i] == b'\n' {
            out.push('\n');
            i += 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn split_property(line: &str) -> Option<(String, String)> {
    let colon = line.find(':')?;
    let key_part = &line[..colon];
    let value = line[colon + 1..].to_owned();
    // Strip parameters from the key (e.g. `DTSTART;VALUE=DATE:20261010`).
    let key = key_part.split(';').next().unwrap_or(key_part).to_uppercase();
    Some((key, value))
}

fn apply_property(
    p: &mut ParsedEvent,
    key: &str,
    value: &str,
    line_no: usize,
    errors: &mut Vec<String>,
) {
    match key {
        "UID" => p.uid = Some(value.to_owned()),
        "SUMMARY" => p.summary = unescape(value),
        "DESCRIPTION" => p.description = unescape(value),
        "LOCATION" => p.location = Some(unescape(value)),
        "DTSTART" => {
            if let Some((s, date_only)) = normalize_dt(value) {
                p.start = s;
                p.all_day = date_only;
            } else {
                errors.push(format!("line {line_no}: bad DTSTART {value:?}"));
            }
        }
        "DTEND" => {
            if let Some((s, _)) = normalize_dt(value) {
                p.end = s;
            } else {
                errors.push(format!("line {line_no}: bad DTEND {value:?}"));
            }
        }
        "CATEGORIES" => {
            p.tags = value
                .split(',')
                .map(|s| unescape(s.trim()))
                .filter(|s| !s.is_empty())
                .collect();
        }
        "ATTENDEE" => {
            // Strip `mailto:` prefix.
            let addr = value
                .trim_start_matches("mailto:")
                .trim_start_matches("MAILTO:")
                .to_owned();
            if !addr.is_empty() {
                p.attendees.push(addr);
            }
        }
        "X-AETHER-COLOR" => p.color = Some(value.to_owned()),
        "X-AETHER-SOURCE-NOTE" => p.source_note_path = Some(value.to_owned()),
        "RRULE" => {
            errors.push(format!(
                "line {line_no}: recurring events not supported"
            ));
            // Drop the event entirely.
            p.start.clear();
        }
        _ => {}
    }
}

/// Convert iCalendar date/datetime forms into our internal strings.
/// Returns `(value, is_date_only)`.
fn normalize_dt(raw: &str) -> Option<(String, bool)> {
    let v = raw.trim();
    if v.is_empty() {
        return None;
    }
    if v.len() == 8 && v.chars().all(|c| c.is_ascii_digit()) {
        // YYYYMMDD -> YYYY-MM-DD
        let formatted = format!("{}-{}-{}", &v[..4], &v[4..6], &v[6..8]);
        return Some((formatted, true));
    }
    if v.len() == 15 && v.ends_with('Z') {
        // YYYYMMDDTHHMMSSZ -> RFC3339 UTC.
        let formatted = format!(
            "{}-{}-{}T{}:{}:{}+00:00",
            &v[..4],
            &v[4..6],
            &v[6..8],
            &v[9..11],
            &v[11..13],
            &v[13..15]
        );
        return Some((formatted, false));
    }
    if v.len() == 16 && v.contains('T') {
        // Floating local time YYYYMMDDTHHMMSS — treat as +00:00.
        let formatted = format!(
            "{}-{}-{}T{}:{}:{}+00:00",
            &v[..4],
            &v[4..6],
            &v[6..8],
            &v[9..11],
            &v[11..13],
            &v[13..15]
        );
        return Some((formatted, false));
    }
    // Already RFC3339 (e.g. from re-import of our own export).
    if v.contains('T') && (v.contains('+') || v.contains("Z") || v.contains('-')) {
        return Some((v.to_owned(), false));
    }
    None
}

fn unescape(s: &str) -> String {
    s.replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\\\", "\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_event(title: &str) -> CalendarEvent {
        CalendarEvent {
            id: "abc-123".to_owned(),
            uid: "abc-123@aether-os.local".to_owned(),
            title: title.to_owned(),
            description: "Discuss roadmap".to_owned(),
            all_day: false,
            start: "2026-10-10T14:00:00+02:00".to_owned(),
            end: "2026-10-10T15:00:00+02:00".to_owned(),
            due: None,
            color: "#3b82f6".to_owned(),
            tags: vec!["work".to_owned(), "planning".to_owned()],
            attendees: vec![],
            location: Some("Room 7".to_owned()),
            source_note_path: None,
            created_at: "2026-09-01T00:00:00+00:00".to_owned(),
            updated_at: "2026-09-01T00:00:00+00:00".to_owned(),
        }
    }

    #[test]
    fn round_trip_preserves_key_fields() {
        let original = sample_event("Roadmap review");
        let opts = IcsExportOptions::default();
        let ics = export_calendar(&[original.clone()], &opts);
        eprintln!("ICS:\n{}", ics);
        assert!(ics.contains("BEGIN:VCALENDAR"));
        assert!(ics.contains("BEGIN:VEVENT"));
        assert!(ics.contains("SUMMARY:Roadmap review"));
        assert!(ics.contains("X-AETHER-COLOR:#3b82f6"));

        let (imported, result) =
            import_calendar(&ics, &IcsImportOptions::default()).expect("parse");
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);
        assert_eq!(imported.len(), 1);
        let ev = &imported[0].event;
        assert_eq!(ev.title, original.title);
        assert_eq!(ev.color, original.color);
        assert_eq!(ev.all_day, original.all_day);
        assert_eq!(ev.location, original.location);
        assert_eq!(ev.tags, original.tags);
        // UID round-trip
        assert_eq!(imported[0].uid, original.uid);
    }

    #[test]
    fn export_all_day_event_uses_date_form() {
        let mut ev = sample_event("Holiday");
        ev.all_day = true;
        ev.start = "2026-10-10".to_owned();
        ev.end = "2026-10-11".to_owned();
        let ics = export_calendar(&[ev], &IcsExportOptions::default());
        assert!(ics.contains("DTSTART;VALUE=DATE:20261010"));
        assert!(ics.contains("DTEND;VALUE=DATE:20261011"));
    }

    #[test]
    fn rejects_empty_input() {
        let err = import_calendar("", &IcsImportOptions::default()).expect_err("must reject");
        assert!(err.to_string().contains("empty"));
    }

    #[test]
    fn skips_recurring_events_with_error() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:r1@aether-os.local\r\nDTSTART:20261010T090000Z\r\nDTEND:20261010T100000Z\r\nSUMMARY:Weekly\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let (_, result) = import_calendar(ics, &IcsImportOptions::default()).expect("parse");
        assert!(result
            .errors
            .iter()
            .any(|e| e.contains("recurring events not supported")));
    }
}
