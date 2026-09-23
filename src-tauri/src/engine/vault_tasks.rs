//! Vault tasks — every Markdown checkbox in every note as one task list.
//!
//! The parser ([`parse_tasks`]) is pure and is the source of truth; the
//! TypeScript port in `src/lib/vaulttasks/parser.ts` (used by the mock
//! backend and for optimistic UI) must produce identical output, which both
//! test suites assert against the shared golden fixture
//! `src/lib/vaulttasks/__fixtures__/tasks.md` / `tasks.expected.json`.
//!
//! Recognised syntax:
//!
//! - bullets `-`, `*`, `+` and ordered markers `1.` / `1)`, nested lists and
//!   blockquotes (`> - [ ] …`);
//! - status characters: `[ ]` todo, `[x]`/`[X]` done, `[/]` in progress,
//!   `[-]` cancelled; any other character counts as todo and is preserved;
//! - Obsidian Tasks emoji fields — `📅`/`📆`/`🗓` due, `⏳` scheduled, `🛫`
//!   start, `✅` done, `➕` created, `❌` cancelled; priorities `🔺` urgent,
//!   `⏫` high, `🔼` medium, `🔽`/`⏬` low;
//! - text fields `due:2026-09-30`, `(due: 2026-09-30)`, `[due:: 2026-09-30]`,
//!   `@due(2026-09-30)` (same for `scheduled`, `start`, `done`), priorities
//!   `!urgent`, `!high`, `!medium`, `!low`, `#tags` and trailing `^block-ids`;
//! - YAML frontmatter and fenced code blocks are skipped; the nearest
//!   heading above a task is its section.
//!
//! [`VaultTasksEngine`] aggregates all notes with an mtime/size cache in
//! `<data_dir>/vaulttasks/cache.json`, so a rescan only re-parses changed
//! notes, and writes single-line edits back through [`VaultReader`]. Every
//! edit first checks that the line still holds the task text the UI saw and
//! otherwise fails with "note changed, rescan".

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::UNIX_EPOCH;

use chrono::{Duration, NaiveDate};
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;
use crate::engine::vault_reader::VaultReader;

const CACHE_FILE: &str = "cache.json";
const CACHE_VERSION: u32 = 1;
/// Longest task text accepted by [`VaultTasksEngine::append_task`].
const MAX_TASK_TEXT: usize = 2_000;
/// Start of the error message returned when a line no longer holds the task
/// the caller expected. The UI matches on it to trigger a rescan.
const STALE_TASK_ERROR: &str = "note changed, rescan";

// ── Public types ────────────────────────────────────────────────────────

/// Workflow state of a task, derived from its checkbox character.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultTaskStatus {
    /// `[ ]` and every unknown status character.
    Todo,
    /// `[/]`.
    InProgress,
    /// `[x]` / `[X]`.
    Done,
    /// `[-]`.
    Cancelled,
}

impl VaultTaskStatus {
    /// Status for a checkbox character.
    pub fn from_char(c: char) -> Self {
        match c {
            'x' | 'X' => Self::Done,
            '/' => Self::InProgress,
            '-' => Self::Cancelled,
            _ => Self::Todo,
        }
    }

    /// The checkbox character written for this status.
    pub fn marker(self) -> char {
        match self {
            Self::Todo => ' ',
            Self::InProgress => '/',
            Self::Done => 'x',
            Self::Cancelled => '-',
        }
    }

    /// Todo or in progress — the task still needs doing.
    pub fn is_open(self) -> bool {
        matches!(self, Self::Todo | Self::InProgress)
    }
}

/// Task priority (same scale as the project task board).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultTaskPriority {
    #[default]
    None,
    Low,
    Medium,
    High,
    Urgent,
}

impl VaultTaskPriority {
    /// Obsidian Tasks emoji for this priority.
    fn emoji(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Low => Some("🔽"),
            Self::Medium => Some("🔼"),
            Self::High => Some("⏫"),
            Self::Urgent => Some("🔺"),
        }
    }

    /// Word used by the `!priority` text syntax.
    fn word(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Low => Some("low"),
            Self::Medium => Some("medium"),
            Self::High => Some("high"),
            Self::Urgent => Some("urgent"),
        }
    }

    fn from_emoji(glyph: &str) -> Self {
        match glyph {
            "🔺" => Self::Urgent,
            "⏫" => Self::High,
            "🔼" => Self::Medium,
            _ => Self::Low, // 🔽 and ⏬
        }
    }

    fn from_word(word: &str) -> Self {
        match word.to_ascii_lowercase().as_str() {
            "urgent" | "highest" => Self::Urgent,
            "high" => Self::High,
            "medium" | "med" => Self::Medium,
            _ => Self::Low, // low, lowest
        }
    }
}

/// One checkbox task found in a note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultTaskItem {
    /// Stable id: FNV-1a 64 of `note_path`, `line` and `text_raw` (hex).
    pub id: String,
    /// Absolute note path as reported by the vault scan.
    pub note_path: String,
    /// File name without `.md`.
    pub note_name: String,
    /// 0-based line number inside the note.
    pub line: usize,
    /// Leading whitespace before the bullet in columns (tab = 4).
    pub indent: usize,
    /// Nesting level among list items (0 = top level).
    pub depth: usize,
    /// Everything after the checkbox, exactly as written (trailing blanks trimmed).
    pub text_raw: String,
    /// `text_raw` without date, priority and block-id markers; tags and
    /// wikilinks are kept so the UI can render them inline.
    pub text_clean: String,
    /// True for `[x]` / `[X]`.
    pub checked: bool,
    /// The character between the brackets.
    pub status_char: String,
    pub status: VaultTaskStatus,
    pub due: Option<NaiveDate>,
    pub scheduled: Option<NaiveDate>,
    pub start: Option<NaiveDate>,
    /// Completion date (`✅ YYYY-MM-DD` or `done:` fields).
    pub done_date: Option<NaiveDate>,
    pub priority: VaultTaskPriority,
    /// Inline `#tags` without the `#`, in order of appearance.
    pub tags: Vec<String>,
    /// Text of the nearest heading above the task.
    pub section: Option<String>,
}

/// Status filter for [`VaultTaskFilter`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultTaskStatusFilter {
    All,
    /// Todo or in progress.
    Open,
    Todo,
    InProgress,
    Done,
    Cancelled,
}

/// Server-side filter for [`VaultTasksEngine::list`]. All set fields must
/// match; date bounds are inclusive and exclude tasks without a due date.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultTaskFilter {
    #[serde(default)]
    pub status: Option<VaultTaskStatusFilter>,
    /// Due on or before this date.
    #[serde(default)]
    pub due_before: Option<NaiveDate>,
    /// Due on or after this date.
    #[serde(default)]
    pub due_after: Option<NaiveDate>,
    /// Tag without `#`; also matches nested tags (`work` matches `work/meeting`).
    #[serde(default)]
    pub tag: Option<String>,
    /// Only tasks of this note.
    #[serde(default)]
    pub note_path: Option<String>,
    /// Whitespace-separated terms, all of which must appear (case-insensitive)
    /// in the task text, note name, tags or section.
    #[serde(default)]
    pub query: Option<String>,
}

impl VaultTaskFilter {
    /// Does `task` pass every set criterion?
    pub fn matches(&self, task: &VaultTaskItem) -> bool {
        if let Some(status) = self.status {
            let ok = match status {
                VaultTaskStatusFilter::All => true,
                VaultTaskStatusFilter::Open => task.status.is_open(),
                VaultTaskStatusFilter::Todo => task.status == VaultTaskStatus::Todo,
                VaultTaskStatusFilter::InProgress => task.status == VaultTaskStatus::InProgress,
                VaultTaskStatusFilter::Done => task.status == VaultTaskStatus::Done,
                VaultTaskStatusFilter::Cancelled => task.status == VaultTaskStatus::Cancelled,
            };
            if !ok {
                return false;
            }
        }
        if self.due_before.is_some() || self.due_after.is_some() {
            let Some(due) = task.due else { return false };
            if self.due_before.is_some_and(|before| due > before) {
                return false;
            }
            if self.due_after.is_some_and(|after| due < after) {
                return false;
            }
        }
        if let Some(tag) = self.tag.as_deref() {
            let wanted = tag.trim().trim_start_matches('#').to_lowercase();
            if !wanted.is_empty() {
                let nested = format!("{wanted}/");
                let hit = task.tags.iter().any(|t| {
                    let t = t.to_lowercase();
                    t == wanted || t.starts_with(&nested)
                });
                if !hit {
                    return false;
                }
            }
        }
        if let Some(path) = self.note_path.as_deref() {
            if task.note_path != path {
                return false;
            }
        }
        if let Some(query) = self.query.as_deref() {
            let haystack = format!(
                "{} {} {} {}",
                task.text_clean,
                task.note_name,
                task.tags.join(" "),
                task.section.as_deref().unwrap_or_default()
            )
            .to_lowercase();
            if !query
                .split_whitespace()
                .all(|term| haystack.contains(&term.to_lowercase()))
            {
                return false;
            }
        }
        true
    }
}

/// Per-note counters in [`VaultTaskStats`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultTaskNoteStats {
    pub note_path: String,
    pub note_name: String,
    pub total: usize,
    pub open: usize,
    pub done: usize,
    pub overdue: usize,
}

/// Aggregate counters over all vault tasks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultTaskStats {
    pub total: usize,
    /// Todo + in progress.
    pub open: usize,
    pub in_progress: usize,
    pub done: usize,
    pub cancelled: usize,
    /// Open tasks due before today.
    pub overdue: usize,
    /// Open tasks due today.
    pub due_today: usize,
    /// Open tasks due today or within the next six days.
    pub due_this_week: usize,
    /// Notes with at least one task, most open tasks first.
    pub by_note: Vec<VaultTaskNoteStats>,
}

/// Counters for `tasks` relative to `today`.
pub fn compute_stats(tasks: &[VaultTaskItem], today: NaiveDate) -> VaultTaskStats {
    let week_end = today + Duration::days(6);
    let mut stats = VaultTaskStats {
        total: tasks.len(),
        open: 0,
        in_progress: 0,
        done: 0,
        cancelled: 0,
        overdue: 0,
        due_today: 0,
        due_this_week: 0,
        by_note: Vec::new(),
    };
    let mut by_note: Vec<VaultTaskNoteStats> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();
    for task in tasks {
        let slot = *index.entry(task.note_path.as_str()).or_insert_with(|| {
            by_note.push(VaultTaskNoteStats {
                note_path: task.note_path.clone(),
                note_name: task.note_name.clone(),
                total: 0,
                open: 0,
                done: 0,
                overdue: 0,
            });
            by_note.len() - 1
        });
        let note = &mut by_note[slot];
        note.total += 1;
        match task.status {
            VaultTaskStatus::Done => {
                stats.done += 1;
                note.done += 1;
            }
            VaultTaskStatus::Cancelled => stats.cancelled += 1,
            VaultTaskStatus::InProgress | VaultTaskStatus::Todo => {
                if task.status == VaultTaskStatus::InProgress {
                    stats.in_progress += 1;
                }
                stats.open += 1;
                note.open += 1;
                if let Some(due) = task.due {
                    if due < today {
                        stats.overdue += 1;
                        note.overdue += 1;
                    } else if due == today {
                        stats.due_today += 1;
                    }
                    if due >= today && due <= week_end {
                        stats.due_this_week += 1;
                    }
                }
            }
        }
    }
    by_note.sort_by(|a, b| {
        b.open
            .cmp(&a.open)
            .then_with(|| a.note_name.to_lowercase().cmp(&b.note_name.to_lowercase()))
            .then_with(|| a.note_path.cmp(&b.note_path))
    });
    stats.by_note = by_note;
    stats
}

// ── Parser ──────────────────────────────────────────────────────────────

fn task_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^(?P<prefix>(?:[ \t]*>)*[ \t]*)(?:[-*+]|[0-9]{1,9}[.)])[ \t]+\[(?P<status>[^\]\r\n])\](?:[ \t]+(?P<text>.*?))?[ \t]*$",
        )
        .expect("task regex is valid")
    })
}

fn list_item_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?P<prefix>(?:[ \t]*>)*[ \t]*)(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]|$)")
            .expect("list item regex is valid")
    })
}

fn fence_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?:[ \t]*>)*[ \t]*(?P<fence>`{3,}|~{3,})(?P<rest>.*)$")
            .expect("fence regex is valid")
    })
}

fn heading_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^ {0,3}(?P<hashes>#{1,6})[ \t]+(?P<title>.+?)(?:[ \t]+#+)?[ \t]*$")
            .expect("heading regex is valid")
    })
}

fn tag_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:^|[ \t(])#(?P<tag>[\p{L}\p{N}][\p{L}\p{N}_/-]*)")
            .expect("tag regex is valid")
    })
}

fn inline_code_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"`[^`]*`").expect("inline code regex is valid"))
}

/// One alternation, scanned left to right, so the TypeScript port can use
/// the identical pattern (JS `\b` is ASCII-only, hence `(?-u:\b)` here).
fn marker_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            r"(?i)",
            r"(?P<emoji>(?P<glyph>📅|📆|🗓|⏳|🛫|✅|➕|❌)\x{FE0F}?[ \t]*(?P<edate>[0-9]{4}-[0-9]{2}-[0-9]{2}))(?-u:\b)",
            r"|(?P<bracket>[\[(](?P<bkey>due|scheduled|start|done|completion|created)::?[ \t]*(?P<bdate>[0-9]{4}-[0-9]{2}-[0-9]{2})[ \t]*[\])])",
            r"|(?P<at>@(?P<akey>due|scheduled|start|done)\((?P<adate>[0-9]{4}-[0-9]{2}-[0-9]{2})\))",
            r"|(?:^|[ \t])(?P<bare>(?P<key>due|scheduled|start|done)::?[ \t]*(?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2}))(?-u:\b)",
            r"|(?P<pemoji>🔺|⏫|🔼|🔽|⏬)\x{FE0F}?",
            r"|(?:^|[ \t])(?P<pword>!(?P<word>urgent|highest|high|medium|med|lowest|low))(?-u:\b)",
            r"|(?:^|[ \t])(?P<block>\^[a-z0-9-]+)[ \t]*$",
        ))
        .expect("marker regex is valid")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkerKind {
    Due,
    Scheduled,
    Start,
    Done,
    Created,
    Cancelled,
    Priority(VaultTaskPriority),
    BlockId,
}

impl MarkerKind {
    fn is_date(self) -> bool {
        !matches!(self, Self::Priority(_) | Self::BlockId)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkerSyntax {
    /// Obsidian Tasks emoji (`📅 …`, `⏫`).
    Emoji,
    /// Text fields (`due:…`, `(due: …)`, `!high`).
    Text,
    /// Block ids — no style signal.
    Neutral,
}

/// A metadata marker inside a task's text.
#[derive(Debug, Clone, Copy)]
struct Marker {
    kind: MarkerKind,
    syntax: MarkerSyntax,
    /// Byte range of the marker (without the separating whitespace).
    start: usize,
    end: usize,
    /// The parsed date and its byte range, for date markers.
    date: Option<(NaiveDate, usize, usize)>,
}

fn date_key_kind(key: &str) -> MarkerKind {
    match key.to_ascii_lowercase().as_str() {
        "due" => MarkerKind::Due,
        "scheduled" => MarkerKind::Scheduled,
        "start" => MarkerKind::Start,
        "created" => MarkerKind::Created,
        _ => MarkerKind::Done, // done, completion
    }
}

fn glyph_kind(glyph: &str) -> MarkerKind {
    match glyph {
        "⏳" => MarkerKind::Scheduled,
        "🛫" => MarkerKind::Start,
        "✅" => MarkerKind::Done,
        "➕" => MarkerKind::Created,
        "❌" => MarkerKind::Cancelled,
        _ => MarkerKind::Due, // 📅 📆 🗓
    }
}

fn parse_iso_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

fn date_marker(
    caps: &Captures<'_>,
    group: &str,
    date_group: &str,
    kind: MarkerKind,
    syntax: MarkerSyntax,
) -> Option<Marker> {
    let whole = caps.name(group)?;
    let date = caps.name(date_group)?;
    let parsed = parse_iso_date(date.as_str())?;
    Some(Marker {
        kind,
        syntax,
        start: whole.start(),
        end: whole.end(),
        date: Some((parsed, date.start(), date.end())),
    })
}

/// All markers of a task text, in order. Date markers with impossible dates
/// (`2026-02-30`) and markers inside inline code spans are ignored and stay
/// part of the text.
fn scan_markers(text: &str) -> Vec<Marker> {
    let code: Vec<(usize, usize)> = inline_code_regex()
        .find_iter(text)
        .map(|m| (m.start(), m.end()))
        .collect();
    let mut markers = Vec::new();
    for caps in marker_regex().captures_iter(text) {
        let marker = if caps.name("emoji").is_some() {
            let glyph = caps.name("glyph").map(|m| m.as_str()).unwrap_or_default();
            date_marker(
                &caps,
                "emoji",
                "edate",
                glyph_kind(glyph),
                MarkerSyntax::Emoji,
            )
        } else if caps.name("bracket").is_some() {
            let key = caps.name("bkey").map(|m| m.as_str()).unwrap_or_default();
            date_marker(
                &caps,
                "bracket",
                "bdate",
                date_key_kind(key),
                MarkerSyntax::Text,
            )
        } else if caps.name("at").is_some() {
            let key = caps.name("akey").map(|m| m.as_str()).unwrap_or_default();
            date_marker(&caps, "at", "adate", date_key_kind(key), MarkerSyntax::Text)
        } else if caps.name("bare").is_some() {
            let key = caps.name("key").map(|m| m.as_str()).unwrap_or_default();
            date_marker(
                &caps,
                "bare",
                "date",
                date_key_kind(key),
                MarkerSyntax::Text,
            )
        } else if let Some(m) = caps.name("pemoji") {
            Some(Marker {
                kind: MarkerKind::Priority(VaultTaskPriority::from_emoji(m.as_str())),
                syntax: MarkerSyntax::Emoji,
                start: m.start(),
                end: caps.get(0).map_or(m.end(), |all| all.end()),
                date: None,
            })
        } else if let Some(m) = caps.name("pword") {
            let word = caps.name("word").map(|w| w.as_str()).unwrap_or_default();
            Some(Marker {
                kind: MarkerKind::Priority(VaultTaskPriority::from_word(word)),
                syntax: MarkerSyntax::Text,
                start: m.start(),
                end: m.end(),
                date: None,
            })
        } else {
            caps.name("block").map(|m| Marker {
                kind: MarkerKind::BlockId,
                syntax: MarkerSyntax::Neutral,
                start: m.start(),
                end: m.end(),
                date: None,
            })
        };
        if let Some(marker) = marker {
            let in_code = code
                .iter()
                .any(|&(start, end)| marker.start < end && marker.end > start);
            if !in_code {
                markers.push(marker);
            }
        }
    }
    markers
}

fn trim_blanks(s: &str) -> &str {
    s.trim_matches([' ', '\t'])
}

/// Text without marker spans, blanks collapsed.
fn clean_text(text: &str, markers: &[Marker]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for m in markers {
        out.push_str(&text[cursor..m.start]);
        out.push(' ');
        cursor = m.end;
    }
    out.push_str(&text[cursor..]);
    let mut collapsed = String::with_capacity(out.len());
    let mut in_blank = false;
    for c in out.chars() {
        if c == ' ' || c == '\t' {
            if !in_blank {
                collapsed.push(' ');
            }
            in_blank = true;
        } else {
            collapsed.push(c);
            in_blank = false;
        }
    }
    trim_blanks(&collapsed).to_owned()
}

/// Inline `#tags` (not inside code spans), de-duplicated, without `#`.
fn extract_tags(text: &str) -> Vec<String> {
    let prose = inline_code_regex().replace_all(text, " ");
    let mut seen = HashSet::new();
    let mut tags = Vec::new();
    for caps in tag_regex().captures_iter(&prose) {
        let Some(tag) = caps.name("tag") else {
            continue;
        };
        let tag = tag.as_str();
        // Purely numeric "#42" is an issue reference, not a tag.
        if !tag.chars().any(char::is_alphabetic) {
            continue;
        }
        if seen.insert(tag.to_owned()) {
            tags.push(tag.to_owned());
        }
    }
    tags
}

/// FNV-1a 64-bit hash as 16 hex digits.
fn fnv1a64(input: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Stable task id from note path, 0-based line and raw text.
fn task_id(note_path: &str, line: usize, text_raw: &str) -> String {
    fnv1a64(&format!("{note_path}\u{0}{line}\u{0}{text_raw}"))
}

/// File name without a (case-insensitive) `.md` extension.
fn note_name_of(note_path: &str) -> String {
    let base = note_path.rsplit(['/', '\\']).next().unwrap_or(note_path);
    match base.len().checked_sub(3).and_then(|cut| base.get(cut..)) {
        Some(ext) if ext.eq_ignore_ascii_case(".md") => base[..base.len() - 3].to_owned(),
        _ => base.to_owned(),
    }
}

/// Columns of leading whitespace (tab = 4) after any blockquote markers
/// (the single space after the last `>` belongs to the quote).
fn indent_columns(prefix: &str) -> usize {
    let after_quote = match prefix.rfind('>') {
        Some(idx) => {
            let rest = &prefix[idx + 1..];
            rest.strip_prefix(' ').unwrap_or(rest)
        }
        None => prefix,
    };
    after_quote
        .chars()
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum()
}

/// A task line split into its parts (byte offsets into the line).
#[derive(Debug, Clone, Copy)]
struct TaskLine<'a> {
    indent: usize,
    status_at: usize,
    status_char: char,
    text_at: usize,
    text: &'a str,
}

fn parse_task_line(line: &str) -> Option<TaskLine<'_>> {
    let caps = task_regex().captures(line)?;
    let text = caps.name("text")?;
    if text.as_str().is_empty() {
        return None;
    }
    let status = caps.name("status")?;
    Some(TaskLine {
        indent: indent_columns(caps.name("prefix").map_or("", |m| m.as_str())),
        status_at: status.start(),
        status_char: status.as_str().chars().next()?,
        text_at: text.start(),
        text: text.as_str(),
    })
}

fn heading_title(line: &str) -> Option<(usize, String)> {
    let caps = heading_regex().captures(line)?;
    let level = caps.name("hashes")?.as_str().len();
    Some((level, caps.name("title")?.as_str().to_owned()))
}

/// `(fence char, run length)` when the line opens a fenced code block.
fn fence_open(line: &str) -> Option<(char, usize)> {
    let caps = fence_regex().captures(line)?;
    let fence = caps.name("fence")?.as_str();
    let ch = fence.chars().next()?;
    let rest = caps.name("rest").map_or("", |m| m.as_str());
    // A backtick info string cannot contain backticks (that is inline code).
    if ch == '`' && rest.contains('`') {
        return None;
    }
    Some((ch, fence.len()))
}

fn fence_closes(line: &str, ch: char, len: usize) -> bool {
    let Some(caps) = fence_regex().captures(line) else {
        return false;
    };
    let Some(fence) = caps.name("fence") else {
        return false;
    };
    let rest = caps.name("rest").map_or("", |m| m.as_str());
    fence.as_str().starts_with(ch) && fence.as_str().len() >= len && trim_blanks(rest).is_empty()
}

/// Index of the closing `---`/`...` line of a leading YAML frontmatter block.
fn frontmatter_end(lines: &[&str]) -> Option<usize> {
    if lines.first().map(|l| l.trim_end_matches([' ', '\t'])) != Some("---") {
        return None;
    }
    lines.iter().enumerate().skip(1).find_map(|(idx, line)| {
        let t = line.trim_end_matches([' ', '\t']);
        (t == "---" || t == "...").then_some(idx)
    })
}

fn strip_bom(content: &str) -> (&str, &str) {
    match content.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", content),
    }
}

/// Lines of `body` split on `\n` with a trailing `\r` removed.
fn split_lines(body: &str) -> Vec<&str> {
    body.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

fn build_item(
    note_path: &str,
    note_name: &str,
    line: usize,
    depth: usize,
    section: Option<&str>,
    task: &TaskLine<'_>,
) -> VaultTaskItem {
    let markers = scan_markers(task.text);
    let first_date = |kind: MarkerKind| {
        markers
            .iter()
            .find(|m| m.kind == kind)
            .and_then(|m| m.date.map(|(d, _, _)| d))
    };
    let priority = markers
        .iter()
        .find_map(|m| match m.kind {
            MarkerKind::Priority(p) => Some(p),
            _ => None,
        })
        .unwrap_or_default();
    let status = VaultTaskStatus::from_char(task.status_char);
    VaultTaskItem {
        id: task_id(note_path, line, task.text),
        note_path: note_path.to_owned(),
        note_name: note_name.to_owned(),
        line,
        indent: task.indent,
        depth,
        text_raw: task.text.to_owned(),
        text_clean: clean_text(task.text, &markers),
        checked: status == VaultTaskStatus::Done,
        status_char: task.status_char.to_string(),
        status,
        due: first_date(MarkerKind::Due),
        scheduled: first_date(MarkerKind::Scheduled),
        start: first_date(MarkerKind::Start),
        done_date: first_date(MarkerKind::Done),
        priority,
        tags: extract_tags(task.text),
        section: section.map(str::to_owned),
    }
}

/// Every checkbox task in `content`, in line order.
pub fn parse_tasks(note_path: &str, content: &str) -> Vec<VaultTaskItem> {
    let note_name = note_name_of(note_path);
    let (_, body) = strip_bom(content);
    let lines = split_lines(body);
    let skip_until = frontmatter_end(&lines);
    let mut fence: Option<(char, usize)> = None;
    let mut section: Option<String> = None;
    let mut stack: Vec<usize> = Vec::new();
    let mut tasks = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        if skip_until.is_some_and(|end| idx <= end) {
            continue;
        }
        if let Some((ch, len)) = fence {
            if fence_closes(line, ch, len) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = fence_open(line) {
            fence = Some(open);
            continue;
        }
        if trim_blanks(line).is_empty() {
            continue;
        }
        if let Some((_, title)) = heading_title(line) {
            section = Some(title);
            stack.clear();
            continue;
        }
        match list_item_regex().captures(line) {
            Some(caps) => {
                let indent = indent_columns(caps.name("prefix").map_or("", |m| m.as_str()));
                while stack.last().is_some_and(|&top| top >= indent) {
                    stack.pop();
                }
                let depth = stack.len();
                stack.push(indent);
                if let Some(task) = parse_task_line(line) {
                    tasks.push(build_item(
                        note_path,
                        &note_name,
                        idx,
                        depth,
                        section.as_deref(),
                        &task,
                    ));
                }
            }
            None => {
                if !line.starts_with([' ', '\t']) {
                    stack.clear();
                }
            }
        }
    }
    tasks
}

// ── Pure line edits ─────────────────────────────────────────────────────

/// Which marker syntax a note already uses on its task lines.
#[derive(Debug, Clone, Copy, Default)]
struct NoteStyle {
    emoji: bool,
    text: bool,
}

impl NoteStyle {
    fn of(tasks: &[VaultTaskItem]) -> Self {
        let mut style = Self::default();
        for task in tasks {
            for m in scan_markers(&task.text_raw) {
                match m.syntax {
                    MarkerSyntax::Emoji => style.emoji = true,
                    MarkerSyntax::Text => style.text = true,
                    MarkerSyntax::Neutral => {}
                }
            }
        }
        style
    }

    /// New markers use text syntax only in notes that use it exclusively.
    fn prefers_text(self) -> bool {
        self.text && !self.emoji
    }
}

fn stale_error(line: usize) -> AetherError {
    AetherError::Vault(format!(
        "{STALE_TASK_ERROR} (line {} no longer holds this task)",
        line + 1
    ))
}

/// Remove `text[start..end]` plus one adjacent blank.
fn remove_span(text: &str, start: usize, end: usize) -> String {
    let before = &text[..start];
    let after = &text[end..];
    let joined = if let Some(b) = before.strip_suffix([' ', '\t']) {
        format!("{b}{after}")
    } else if let Some(a) = after.strip_prefix([' ', '\t']) {
        format!("{before}{a}")
    } else {
        format!("{before}{after}")
    };
    joined.trim_end_matches([' ', '\t']).to_owned()
}

/// Insert `marker` at byte `at`, separated by single spaces.
fn insert_marker(text: &str, at: usize, marker: &str) -> String {
    let head = text[..at].trim_end_matches([' ', '\t']);
    let tail = text[at..].trim_start_matches([' ', '\t']);
    match (head.is_empty(), tail.is_empty()) {
        (true, true) => marker.to_owned(),
        (true, false) => format!("{marker} {tail}"),
        (false, true) => format!("{head} {marker}"),
        (false, false) => format!("{head} {marker} {tail}"),
    }
}

fn block_id_start(markers: &[Marker]) -> Option<usize> {
    markers
        .iter()
        .find(|m| m.kind == MarkerKind::BlockId)
        .map(|m| m.start)
}

/// Where a new `✅` goes: before a trailing block id, else at the end.
fn done_insert_point(text: &str, markers: &[Marker]) -> usize {
    block_id_start(markers).unwrap_or(text.len())
}

/// Where a new due date goes: before the done date or block id, else at the end.
fn due_insert_point(text: &str, markers: &[Marker]) -> usize {
    markers
        .iter()
        .find(|m| m.kind == MarkerKind::Done)
        .map(|m| m.start)
        .or_else(|| block_id_start(markers))
        .unwrap_or(text.len())
}

/// Where a new priority goes: before the first date (Tasks plugin order),
/// else before a block id, else at the end.
fn priority_insert_point(text: &str, markers: &[Marker]) -> usize {
    markers
        .iter()
        .find(|m| m.kind.is_date())
        .map(|m| m.start)
        .or_else(|| block_id_start(markers))
        .unwrap_or(text.len())
}

/// What an edit needs to know about the task line being changed.
struct LineEdit<'a> {
    line: &'a str,
    task: TaskLine<'a>,
    markers: Vec<Marker>,
    style: NoteStyle,
}

impl LineEdit<'_> {
    /// The line with its text replaced (and status char, when given).
    fn rebuild(&self, status: Option<char>, text: &str) -> String {
        let old_char_len = self.task.status_char.len_utf8();
        let mut out = String::with_capacity(self.line.len() + 16);
        out.push_str(&self.line[..self.task.status_at]);
        out.push(status.unwrap_or(self.task.status_char));
        let status_end = self.task.status_at + old_char_len;
        if text == self.task.text {
            out.push_str(&self.line[status_end..]);
        } else {
            out.push_str(&self.line[status_end..self.task.text_at]);
            out.push_str(text);
        }
        out
    }
}

/// Apply `edit` to task line `line` of `content` after checking that it still
/// holds `expected_text`. Line endings, the BOM and every other line are kept.
fn edit_task_line(
    content: &str,
    note_path: &str,
    line: usize,
    expected_text: &str,
    edit: impl FnOnce(&LineEdit<'_>) -> String,
) -> Result<String, AetherError> {
    let tasks = parse_tasks(note_path, content);
    let expected = trim_blanks(expected_text);
    match tasks.iter().find(|t| t.line == line) {
        Some(task) if task.text_raw == expected => {}
        _ => return Err(stale_error(line)),
    }
    let style = NoteStyle::of(&tasks);
    let (bom, body) = strip_bom(content);
    let mut lines: Vec<String> = body.split('\n').map(str::to_owned).collect();
    let raw = lines.get(line).ok_or_else(|| stale_error(line))?;
    let (text_line, cr) = match raw.strip_suffix('\r') {
        Some(stripped) => (stripped, "\r"),
        None => (raw.as_str(), ""),
    };
    let task = parse_task_line(text_line).ok_or_else(|| stale_error(line))?;
    let ctx = LineEdit {
        line: text_line,
        task,
        markers: scan_markers(task.text),
        style,
    };
    let replaced = format!("{}{cr}", edit(&ctx));
    lines[line] = replaced;
    Ok(format!("{bom}{}", lines.join("\n")))
}

/// Set a task's status. Checking it appends `✅ today` when the note already
/// uses Tasks-plugin emoji; any other status removes the done date.
fn apply_status(
    content: &str,
    note_path: &str,
    line: usize,
    expected_text: &str,
    status: VaultTaskStatus,
    today: NaiveDate,
) -> Result<String, AetherError> {
    edit_task_line(content, note_path, line, expected_text, |ctx| {
        let current = VaultTaskStatus::from_char(ctx.task.status_char);
        let status_char = (current != status).then(|| status.marker());
        let done = ctx.markers.iter().find(|m| m.kind == MarkerKind::Done);
        let text = match (status, done) {
            (VaultTaskStatus::Done, None) if ctx.style.emoji => insert_marker(
                ctx.task.text,
                done_insert_point(ctx.task.text, &ctx.markers),
                &format!("✅ {}", today.format("%Y-%m-%d")),
            ),
            (VaultTaskStatus::Done, _) => ctx.task.text.to_owned(),
            (_, Some(m)) => remove_span(ctx.task.text, m.start, m.end),
            (_, None) => ctx.task.text.to_owned(),
        };
        ctx.rebuild(status_char, &text)
    })
}

/// Set or clear the due date, keeping the syntax of an existing marker.
fn apply_due(
    content: &str,
    note_path: &str,
    line: usize,
    expected_text: &str,
    due: Option<NaiveDate>,
) -> Result<String, AetherError> {
    edit_task_line(content, note_path, line, expected_text, |ctx| {
        let text = ctx.task.text;
        let existing = ctx.markers.iter().find(|m| m.kind == MarkerKind::Due);
        let next = match (existing, due) {
            (Some(m), Some(date)) => match m.date {
                Some((_, ds, de)) => {
                    format!("{}{}{}", &text[..ds], date.format("%Y-%m-%d"), &text[de..])
                }
                None => text.to_owned(),
            },
            (Some(m), None) => remove_span(text, m.start, m.end),
            (None, Some(date)) => {
                let marker = if ctx.style.prefers_text() {
                    format!("due:{}", date.format("%Y-%m-%d"))
                } else {
                    format!("📅 {}", date.format("%Y-%m-%d"))
                };
                insert_marker(text, due_insert_point(text, &ctx.markers), &marker)
            }
            (None, None) => text.to_owned(),
        };
        ctx.rebuild(None, &next)
    })
}

/// Set or clear the priority, keeping the syntax of an existing marker.
fn apply_priority(
    content: &str,
    note_path: &str,
    line: usize,
    expected_text: &str,
    priority: VaultTaskPriority,
) -> Result<String, AetherError> {
    edit_task_line(content, note_path, line, expected_text, |ctx| {
        let text = ctx.task.text;
        let existing = ctx
            .markers
            .iter()
            .find(|m| matches!(m.kind, MarkerKind::Priority(_)));
        let emoji = priority.emoji();
        let word = priority.word().map(|w| format!("!{w}"));
        let next = match (existing, emoji, word) {
            (Some(m), Some(glyph), Some(word)) => {
                let replacement = if m.syntax == MarkerSyntax::Emoji {
                    glyph.to_owned()
                } else {
                    word
                };
                format!("{}{}{}", &text[..m.start], replacement, &text[m.end..])
            }
            (Some(m), _, _) => remove_span(text, m.start, m.end),
            (None, Some(glyph), Some(word)) => {
                let marker = if ctx.style.prefers_text() {
                    word
                } else {
                    glyph.to_owned()
                };
                insert_marker(text, priority_insert_point(text, &ctx.markers), &marker)
            }
            (None, _, _) => text.to_owned(),
        };
        ctx.rebuild(None, &next)
    })
}

/// Validate and normalise the text of a new task (single line, trimmed).
fn sanitize_task_text(text: &str) -> Result<String, AetherError> {
    let single: String = text
        .chars()
        .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        .collect();
    let trimmed = single.trim();
    if trimmed.is_empty() {
        return Err(AetherError::InvalidInput("task text is required".into()));
    }
    if trimmed.chars().count() > MAX_TASK_TEXT {
        return Err(AetherError::InvalidInput(format!(
            "task text is longer than {MAX_TASK_TEXT} characters"
        )));
    }
    Ok(trimmed.to_owned())
}

/// Add `- [ ] text` at the end of a `Tasks` section (any heading level) or,
/// without one, at the end of the note. Returns the new content and the
/// 0-based line of the task.
fn append_task_to_content(content: &str, text: &str) -> Result<(String, usize), AetherError> {
    let text = sanitize_task_text(text)?;
    let (bom, body) = strip_bom(content);
    let cr = if body.contains("\r\n") { "\r" } else { "" };
    let mut lines: Vec<String> = body.split('\n').map(str::to_owned).collect();
    let plain: Vec<&str> = split_lines(body);

    // Locate a "Tasks" heading outside frontmatter and code fences.
    let skip_until = frontmatter_end(&plain);
    let mut fence: Option<(char, usize)> = None;
    let mut headings: Vec<(usize, usize, String)> = Vec::new();
    for (idx, line) in plain.iter().enumerate() {
        if skip_until.is_some_and(|end| idx <= end) {
            continue;
        }
        if let Some((ch, len)) = fence {
            if fence_closes(line, ch, len) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = fence_open(line) {
            fence = Some(open);
            continue;
        }
        if let Some((level, title)) = heading_title(line) {
            headings.push((idx, level, title));
        }
    }

    let target = headings
        .iter()
        .position(|(_, _, title)| trim_blanks(title).eq_ignore_ascii_case("tasks"));
    let mut insert_at = match target {
        Some(pos) => {
            let (start, level, _) = headings[pos];
            let end = headings[pos + 1..]
                .iter()
                .find(|(_, l, _)| *l <= level)
                .map_or(plain.len(), |(idx, _, _)| *idx);
            let last_content = (start + 1..end)
                .rev()
                .find(|&idx| !trim_blanks(plain[idx]).is_empty())
                .unwrap_or(start);
            last_content + 1
        }
        // Before the empty element that follows a final newline.
        None if lines.last().is_some_and(|l| l.is_empty()) => lines.len() - 1,
        None => lines.len(),
    };
    if insert_at == lines.len() {
        // Inserting after an unterminated last line: terminate it (`\r`
        // keeps CRLF files consistent) and keep a final newline.
        if let Some(last) = lines.last_mut() {
            if !cr.is_empty() && !last.ends_with('\r') {
                last.push('\r');
            }
        }
        lines.push(String::new());
        insert_at = lines.len() - 1;
    }
    lines.insert(insert_at, format!("- [ ] {text}{cr}"));
    Ok((format!("{bom}{}", lines.join("\n")), insert_at))
}

// ── Engine ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedNote {
    mtime_ns: u64,
    size: u64,
    tasks: Vec<VaultTaskItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TaskCache {
    version: u32,
    vault_root: Option<String>,
    notes: HashMap<String, CachedNote>,
}

/// Aggregates checkbox tasks across the vault and writes edits back.
pub struct VaultTasksEngine {
    cache_path: PathBuf,
    /// Also serialises read-modify-write edits of notes.
    cache: Mutex<TaskCache>,
}

/// `(mtime in ns since the epoch, size)` of a file.
fn file_signature(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX));
    Some((mtime, meta.len()))
}

fn vault_root(vault: &VaultReader) -> Result<String, AetherError> {
    vault.detect_vault_path().ok_or_else(|| {
        AetherError::Vault("no vault path configured — choose one in Settings".into())
    })
}

/// Reject note paths outside the vault, hidden files and non-Markdown files.
fn ensure_note_in_vault(root: &str, note_path: &str) -> Result<(), AetherError> {
    let root = std::fs::canonicalize(root)
        .map_err(|e| AetherError::Vault(format!("vault canonicalize: {e}")))?;
    let canonical = std::fs::canonicalize(note_path)
        .map_err(|e| AetherError::Vault(format!("note not found: {note_path} ({e})")))?;
    let rel = canonical.strip_prefix(&root).map_err(|_| {
        AetherError::Vault(format!("refusing to edit outside the vault: {note_path}"))
    })?;
    if rel.components().any(|c| match c {
        Component::Normal(part) => part.to_string_lossy().starts_with('.'),
        _ => true,
    }) {
        return Err(AetherError::Vault(format!(
            "refusing to edit hidden files: {note_path}"
        )));
    }
    let is_markdown = canonical
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
    if !canonical.is_file() || !is_markdown {
        return Err(AetherError::Vault(format!(
            "only Markdown notes contain tasks: {note_path}"
        )));
    }
    Ok(())
}

impl VaultTasksEngine {
    /// Open the engine with its cache in `storage_dir` (created if missing).
    /// A missing, corrupt or outdated cache simply starts empty.
    pub fn new(storage_dir: &Path) -> Result<Self, AetherError> {
        std::fs::create_dir_all(storage_dir)?;
        let cache_path = storage_dir.join(CACHE_FILE);
        let cache = std::fs::read_to_string(&cache_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<TaskCache>(&raw).ok())
            .filter(|c| c.version == CACHE_VERSION)
            .unwrap_or_else(|| TaskCache {
                version: CACHE_VERSION,
                ..TaskCache::default()
            });
        Ok(Self {
            cache_path,
            cache: Mutex::new(cache),
        })
    }

    fn lock(&self) -> MutexGuard<'_, TaskCache> {
        self.cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Write the cache atomically (temp file + rename).
    fn persist(&self, cache: &TaskCache) -> Result<(), AetherError> {
        let json = serde_json::to_string(cache)
            .map_err(|e| AetherError::Vault(format!("task cache serialize: {e}")))?;
        let tmp = self.cache_path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.cache_path)?;
        Ok(())
    }

    /// Scan the vault, re-parsing only notes whose mtime or size changed.
    /// Returns all tasks (notes by name, tasks by line) and how many notes
    /// were parsed.
    fn scan_inner(
        &self,
        vault: &VaultReader,
        force: bool,
    ) -> Result<(Vec<VaultTaskItem>, usize), AetherError> {
        let root = vault_root(vault)?;
        let notes = vault.scan_vault(&root)?;
        let mut cache = self.lock();
        let mut changed = false;
        if force || cache.vault_root.as_deref() != Some(root.as_str()) {
            changed = !cache.notes.is_empty() || cache.vault_root.as_deref() != Some(&root);
            cache.notes.clear();
            cache.vault_root = Some(root.clone());
        }

        let mut tasks = Vec::new();
        let mut parsed = 0;
        let mut present = HashSet::with_capacity(notes.len());
        for note in &notes {
            present.insert(note.path.clone());
            let Some((mtime_ns, size)) = file_signature(Path::new(&note.path)) else {
                continue;
            };
            if let Some(hit) = cache.notes.get(&note.path) {
                if hit.mtime_ns == mtime_ns && hit.size == size {
                    tasks.extend(hit.tasks.iter().cloned());
                    continue;
                }
            }
            // Unreadable or non-UTF-8 files have no tasks.
            let note_tasks = match vault.read_note(&note.path) {
                Ok(content) => parse_tasks(&note.path, &content),
                Err(_) => Vec::new(),
            };
            parsed += 1;
            changed = true;
            tasks.extend(note_tasks.iter().cloned());
            cache.notes.insert(
                note.path.clone(),
                CachedNote {
                    mtime_ns,
                    size,
                    tasks: note_tasks,
                },
            );
        }
        let before = cache.notes.len();
        cache.notes.retain(|path, _| present.contains(path));
        changed |= cache.notes.len() != before;
        if changed {
            self.persist(&cache)?;
        }
        Ok((tasks, parsed))
    }

    /// All tasks in the vault (incremental, cache-backed).
    pub fn scan(&self, vault: &VaultReader) -> Result<Vec<VaultTaskItem>, AetherError> {
        self.scan_inner(vault, false).map(|(tasks, _)| tasks)
    }

    /// Drop the cache and re-parse every note.
    pub fn rescan(&self, vault: &VaultReader) -> Result<Vec<VaultTaskItem>, AetherError> {
        self.scan_inner(vault, true).map(|(tasks, _)| tasks)
    }

    /// Tasks matching `filter`.
    pub fn list(
        &self,
        vault: &VaultReader,
        filter: &VaultTaskFilter,
    ) -> Result<Vec<VaultTaskItem>, AetherError> {
        let mut tasks = self.scan(vault)?;
        tasks.retain(|t| filter.matches(t));
        Ok(tasks)
    }

    /// Counters relative to today (local time).
    pub fn stats(&self, vault: &VaultReader) -> Result<VaultTaskStats, AetherError> {
        let tasks = self.scan(vault)?;
        Ok(compute_stats(&tasks, chrono::Local::now().date_naive()))
    }

    /// Read a note, transform it, write it back when it changed, refresh its
    /// cache entry and return the task at the line `transform` reports.
    fn edit_note(
        &self,
        vault: &VaultReader,
        note_path: &str,
        transform: impl FnOnce(&str) -> Result<(String, usize), AetherError>,
    ) -> Result<VaultTaskItem, AetherError> {
        let root = vault_root(vault)?;
        ensure_note_in_vault(&root, note_path)?;
        let mut cache = self.lock();
        let content = vault.read_note(note_path)?;
        let (next, line) = transform(&content)?;
        if next != content {
            vault.write_note(note_path, &next)?;
        }
        let tasks = parse_tasks(note_path, &next);
        let item = tasks
            .iter()
            .find(|t| t.line == line)
            .cloned()
            .ok_or_else(|| stale_error(line))?;
        if cache.vault_root.as_deref() == Some(root.as_str()) {
            if let Some((mtime_ns, size)) = file_signature(Path::new(note_path)) {
                cache.notes.insert(
                    note_path.to_owned(),
                    CachedNote {
                        mtime_ns,
                        size,
                        tasks,
                    },
                );
                self.persist(&cache)?;
            }
        }
        Ok(item)
    }

    /// Check (`[x]`) or uncheck (`[ ]`) a task.
    pub fn toggle(
        &self,
        vault: &VaultReader,
        note_path: &str,
        line: usize,
        checked: bool,
        expected_text: &str,
    ) -> Result<VaultTaskItem, AetherError> {
        let status = if checked {
            VaultTaskStatus::Done
        } else {
            VaultTaskStatus::Todo
        };
        self.set_status(vault, note_path, line, status, expected_text)
    }

    /// Rewrite the checkbox character of a task.
    pub fn set_status(
        &self,
        vault: &VaultReader,
        note_path: &str,
        line: usize,
        status: VaultTaskStatus,
        expected_text: &str,
    ) -> Result<VaultTaskItem, AetherError> {
        let today = chrono::Local::now().date_naive();
        self.edit_note(vault, note_path, |content| {
            apply_status(content, note_path, line, expected_text, status, today).map(|c| (c, line))
        })
    }

    /// Set (`Some`) or remove (`None`) a task's due date.
    pub fn set_due(
        &self,
        vault: &VaultReader,
        note_path: &str,
        line: usize,
        due: Option<NaiveDate>,
        expected_text: &str,
    ) -> Result<VaultTaskItem, AetherError> {
        self.edit_note(vault, note_path, |content| {
            apply_due(content, note_path, line, expected_text, due).map(|c| (c, line))
        })
    }

    /// Set or remove (`None`) a task's priority.
    pub fn set_priority(
        &self,
        vault: &VaultReader,
        note_path: &str,
        line: usize,
        priority: VaultTaskPriority,
        expected_text: &str,
    ) -> Result<VaultTaskItem, AetherError> {
        self.edit_note(vault, note_path, |content| {
            apply_priority(content, note_path, line, expected_text, priority).map(|c| (c, line))
        })
    }

    /// Add `- [ ] text` under the note's `Tasks` heading (or at its end).
    pub fn append_task(
        &self,
        vault: &VaultReader,
        note_path: &str,
        text: &str,
    ) -> Result<VaultTaskItem, AetherError> {
        self.edit_note(vault, note_path, |content| {
            append_task_to_content(content, text)
        })
    }
}

/// Parse a `YYYY-MM-DD` date from the UI.
pub fn parse_due_arg(value: Option<&str>) -> Result<Option<NaiveDate>, AetherError> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(raw) => parse_iso_date(raw).map(Some).ok_or_else(|| {
            AetherError::InvalidInput(format!("invalid date \"{raw}\" — expected YYYY-MM-DD"))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::{tempdir, TempDir};

    const FIXTURE: &str = include_str!("../../../src/lib/vaulttasks/__fixtures__/tasks.md");
    const FIXTURE_EXPECTED: &str =
        include_str!("../../../src/lib/vaulttasks/__fixtures__/tasks.expected.json");
    const FIXTURE_PATH: &str = "/vault/Projects/Task Fixture.md";

    fn date(s: &str) -> NaiveDate {
        parse_iso_date(s).expect("valid test date")
    }

    fn one(content: &str) -> VaultTaskItem {
        let tasks = parse_tasks("/v/Note.md", content);
        assert_eq!(tasks.len(), 1, "expected exactly one task in {content:?}");
        tasks.into_iter().next().expect("one task")
    }

    // ── Parser ──

    #[test]
    fn golden_fixture_matches_the_shared_expectation() {
        let actual = serde_json::to_value(parse_tasks(FIXTURE_PATH, FIXTURE)).expect("serialize");
        // `UPDATE_VAULTTASKS_GOLDEN=1 cargo test golden` rewrites the expectation;
        // the TypeScript suite then proves its parser agrees.
        if std::env::var_os("UPDATE_VAULTTASKS_GOLDEN").is_some() {
            let golden = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../src/lib/vaulttasks/__fixtures__/tasks.expected.json");
            let json = serde_json::to_string_pretty(&actual).expect("pretty JSON");
            fs::write(golden, format!("{json}\n")).expect("write golden");
            return;
        }
        let expected: serde_json::Value =
            serde_json::from_str(FIXTURE_EXPECTED).expect("golden JSON parses");
        assert_eq!(
            actual,
            expected,
            "Rust parser drifted from tasks.expected.json:\n{}",
            serde_json::to_string_pretty(&actual).unwrap_or_default()
        );
    }

    #[test]
    fn recognises_bullets_numbers_and_status_chars() {
        let content =
            "- [ ] dash\n* [x] star\n+ [X] plus\n1. [/] one\n2) [-] two\n- [>] forwarded\n";
        let tasks = parse_tasks("/v/n.md", content);
        let statuses: Vec<_> = tasks
            .iter()
            .map(|t| (t.text_raw.as_str(), t.status))
            .collect();
        assert_eq!(
            statuses,
            vec![
                ("dash", VaultTaskStatus::Todo),
                ("star", VaultTaskStatus::Done),
                ("plus", VaultTaskStatus::Done),
                ("one", VaultTaskStatus::InProgress),
                ("two", VaultTaskStatus::Cancelled),
                ("forwarded", VaultTaskStatus::Todo),
            ]
        );
        assert!(tasks[1].checked && tasks[2].checked && !tasks[3].checked);
        assert_eq!(tasks[5].status_char, ">");
        assert_eq!(tasks[4].line, 4);
    }

    #[test]
    fn ignores_non_tasks() {
        let content =
            "- [ ]\n- [ ]   \n- [x]no space\n- [a](link)\n- [[Wiki]]\n-[ ] tight\n[ ] bare\n";
        assert!(parse_tasks("/v/n.md", content).is_empty());
    }

    #[test]
    fn skips_frontmatter_and_code_fences() {
        let content = "---\ntags: [a]\n- [ ] in frontmatter\n---\n```md\n- [ ] in code\n```\n~~~\n```\n- [ ] still code\n~~~\n````\n- [ ] four\n```\n- [ ] still four\n````\n- [ ] real\n";
        let tasks = parse_tasks("/v/n.md", content);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].text_raw, "real");
        assert_eq!(tasks[0].line, 16);
    }

    #[test]
    fn unclosed_frontmatter_is_not_frontmatter() {
        let tasks = parse_tasks("/v/n.md", "---\n- [ ] visible\n");
        assert_eq!(tasks.len(), 1);
    }

    #[test]
    fn inline_triple_backticks_do_not_open_a_fence() {
        let tasks = parse_tasks("/v/n.md", "```inline``` text\n- [ ] after\n");
        assert_eq!(tasks.len(), 1);
    }

    #[test]
    fn nested_lists_get_depth_and_indent() {
        let content = "- [ ] parent\n  - [ ] child\n    - [x] grandchild\n\t- [ ] tab child\n- plain\n  - [ ] under plain\nParagraph\n  - [ ] after paragraph\n";
        let tasks = parse_tasks("/v/n.md", content);
        let shape: Vec<_> = tasks.iter().map(|t| (t.indent, t.depth)).collect();
        // A tab is four columns, so "tab child" is a sibling of "grandchild".
        assert_eq!(shape, vec![(0, 0), (2, 1), (4, 2), (4, 2), (2, 1), (2, 0)]);
    }

    #[test]
    fn blockquote_tasks_are_parsed() {
        let tasks = parse_tasks("/v/n.md", "> - [ ] quoted\n>   - [x] nested quote\n");
        assert_eq!(tasks.len(), 2);
        assert_eq!((tasks[0].indent, tasks[0].depth), (0, 0));
        assert_eq!((tasks[1].indent, tasks[1].depth), (2, 1));
    }

    #[test]
    fn parses_emoji_dates_and_priorities() {
        let t =
            one("- [ ] Ship it ⏫ 🛫 2026-09-01 ⏳ 2026-09-20 📅 2026-09-30 ➕ 2026-08-01 #work");
        assert_eq!(t.priority, VaultTaskPriority::High);
        assert_eq!(t.start, Some(date("2026-09-01")));
        assert_eq!(t.scheduled, Some(date("2026-09-20")));
        assert_eq!(t.due, Some(date("2026-09-30")));
        assert_eq!(t.text_clean, "Ship it #work");
        assert_eq!(t.tags, vec!["work"]);
    }

    #[test]
    fn parses_text_due_syntaxes() {
        for (line, clean) in [
            ("- [ ] a due:2026-09-30", "a"),
            ("- [ ] a due: 2026-09-30 b", "a b"),
            ("- [ ] a (due: 2026-09-30)", "a"),
            ("- [ ] a [due:: 2026-09-30]", "a"),
            ("- [ ] a @due(2026-09-30)", "a"),
            ("- [ ] a DUE:2026-09-30", "a"),
            ("- [ ] a 📆 2026-09-30", "a"),
            ("- [ ] a 🗓️ 2026-09-30", "a"),
        ] {
            let t = one(line);
            assert_eq!(t.due, Some(date("2026-09-30")), "{line}");
            assert_eq!(t.text_clean, clean, "{line}");
        }
    }

    #[test]
    fn ignores_embedded_and_invalid_dates() {
        let t = one("- [ ] overdue:2026-09-30 and 📅 2026-02-30 and due:2026-09-30T10");
        assert_eq!(t.due, None);
        assert_eq!(
            t.text_clean,
            "overdue:2026-09-30 and 📅 2026-02-30 and due:2026-09-30T10"
        );
    }

    #[test]
    fn parses_priority_words_and_emoji() {
        let cases = [
            ("- [ ] a 🔺", VaultTaskPriority::Urgent),
            ("- [ ] a ⏫", VaultTaskPriority::High),
            ("- [ ] a 🔼", VaultTaskPriority::Medium),
            ("- [ ] a 🔽", VaultTaskPriority::Low),
            ("- [ ] a ⏬", VaultTaskPriority::Low),
            ("- [ ] a !urgent", VaultTaskPriority::Urgent),
            ("- [ ] a !HIGH", VaultTaskPriority::High),
            ("- [ ] a !med", VaultTaskPriority::Medium),
            ("- [ ] a !lowest", VaultTaskPriority::Low),
            ("- [ ] a!high", VaultTaskPriority::None),
            ("- [ ] a !higher", VaultTaskPriority::None),
            ("- [ ] a", VaultTaskPriority::None),
        ];
        for (line, expected) in cases {
            assert_eq!(one(line).priority, expected, "{line}");
        }
    }

    #[test]
    fn extracts_tags_and_ignores_code_and_numbers() {
        let t = one("- [ ] Fix #bug in `#notatag` (#area/sub) #42 #bug x#y");
        assert_eq!(t.tags, vec!["bug", "area/sub"]);
    }

    #[test]
    fn records_nearest_heading_as_section() {
        let content =
            "# Top\n- [ ] a\n## Sub ##\n- [ ] b\n### C# notes\n- [ ] c\n#notaheading\n- [ ] d\n";
        let sections: Vec<_> = parse_tasks("/v/n.md", content)
            .into_iter()
            .map(|t| t.section)
            .collect();
        assert_eq!(
            sections,
            vec![
                Some("Top".to_owned()),
                Some("Sub".to_owned()),
                Some("C# notes".to_owned()),
                Some("C# notes".to_owned()),
            ]
        );
    }

    #[test]
    fn block_ids_and_done_dates() {
        let t = one("- [x] Done thing ✅ 2026-09-21 ^abc-123");
        assert_eq!(t.done_date, Some(date("2026-09-21")));
        assert_eq!(t.text_clean, "Done thing");
    }

    #[test]
    fn handles_crlf_and_bom() {
        let tasks = parse_tasks("/v/n.md", "\u{feff}- [ ] first\r\n- [x] second \r\n");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].text_raw, "first");
        assert_eq!(tasks[1].text_raw, "second");
    }

    #[test]
    fn ids_are_stable_and_distinct() {
        let a = parse_tasks("/v/n.md", "- [ ] same\n- [ ] same\n");
        assert_ne!(a[0].id, a[1].id);
        let b = parse_tasks("/v/n.md", "- [x] same\n- [ ] same\n");
        assert_eq!(a[0].id, b[0].id, "status does not change the id");
        assert_eq!(a[0].id.len(), 16);
        assert_eq!(fnv1a64(""), "cbf29ce484222325");
        assert_eq!(fnv1a64("a"), "af63dc4c8601ec8c");
    }

    #[test]
    fn note_name_strips_markdown_extension() {
        assert_eq!(note_name_of("/v/dir/My Note.md"), "My Note");
        assert_eq!(note_name_of("C:\\v\\Upper.MD"), "Upper");
        assert_eq!(note_name_of("/v/日本"), "日本");
    }

    // ── Pure edits ──

    const TODAY: &str = "2026-09-22";

    fn status(content: &str, line: usize, text: &str, s: VaultTaskStatus) -> String {
        apply_status(content, "/v/n.md", line, text, s, date(TODAY)).expect("status edit")
    }

    #[test]
    fn toggle_rewrites_only_the_status_char() {
        let content = "# Head\r\n\t* [ ] Keep   spacing  #tag   \r\nother line\n";
        let checked = status(content, 1, "Keep   spacing  #tag", VaultTaskStatus::Done);
        assert_eq!(
            checked,
            "# Head\r\n\t* [x] Keep   spacing  #tag   \r\nother line\n"
        );
        let unchecked = status(&checked, 1, "Keep   spacing  #tag", VaultTaskStatus::Todo);
        assert_eq!(unchecked, content);
    }

    #[test]
    fn checking_in_emoji_notes_appends_done_date_before_block_id() {
        let content = "- [ ] Pay rent 📅 2026-09-30 ^rent\n- [ ] other\n";
        let done = status(
            content,
            0,
            "Pay rent 📅 2026-09-30 ^rent",
            VaultTaskStatus::Done,
        );
        assert_eq!(
            done,
            "- [x] Pay rent 📅 2026-09-30 ✅ 2026-09-22 ^rent\n- [ ] other\n"
        );
        let other = status(&done, 1, "other", VaultTaskStatus::Done);
        assert!(other.ends_with("- [x] other ✅ 2026-09-22\n"));
        let reopened = status(
            &done,
            0,
            "Pay rent 📅 2026-09-30 ✅ 2026-09-22 ^rent",
            VaultTaskStatus::Todo,
        );
        assert_eq!(reopened, content);
    }

    #[test]
    fn checking_in_plain_notes_does_not_add_dates() {
        let content = "- [ ] plain due:2026-09-30\n";
        assert_eq!(
            status(content, 0, "plain due:2026-09-30", VaultTaskStatus::Done),
            "- [x] plain due:2026-09-30\n"
        );
    }

    #[test]
    fn status_chars_for_progress_and_cancel() {
        let content = "1. [ ] step\n";
        assert_eq!(
            status(content, 0, "step", VaultTaskStatus::InProgress),
            "1. [/] step\n"
        );
        assert_eq!(
            status(content, 0, "step", VaultTaskStatus::Cancelled),
            "1. [-] step\n"
        );
        // Already done with an uppercase X stays untouched.
        assert_eq!(
            status("- [X] big\n", 0, "big", VaultTaskStatus::Done),
            "- [X] big\n"
        );
        // Multi-byte status chars are replaced cleanly.
        assert_eq!(
            status("- [✓] odd\n", 0, "odd", VaultTaskStatus::Done),
            "- [x] odd\n"
        );
    }

    #[test]
    fn stale_line_is_rejected() {
        let content = "- [ ] one\n- [ ] two\n";
        let err = apply_status(
            content,
            "/v/n.md",
            0,
            "two",
            VaultTaskStatus::Done,
            date(TODAY),
        )
        .expect_err("text mismatch");
        assert!(err.to_string().contains(STALE_TASK_ERROR), "{err}");
        assert!(apply_status(
            content,
            "/v/n.md",
            9,
            "one",
            VaultTaskStatus::Done,
            date(TODAY)
        )
        .is_err());
        // A task inside a code fence is not a task.
        assert!(apply_status(
            "```\n- [ ] code\n```\n",
            "/v/n.md",
            1,
            "code",
            VaultTaskStatus::Done,
            date(TODAY)
        )
        .is_err());
    }

    #[test]
    fn due_edits_keep_existing_syntax() {
        let d = Some(date("2026-10-01"));
        let edit = |c: &str, text: &str, due| apply_due(c, "/v/n.md", 0, text, due).expect("due");
        assert_eq!(
            edit("- [ ] a 📅 2026-09-30 #x\n", "a 📅 2026-09-30 #x", d),
            "- [ ] a 📅 2026-10-01 #x\n"
        );
        assert_eq!(
            edit("- [ ] a (due: 2026-09-30)\n", "a (due: 2026-09-30)", d),
            "- [ ] a (due: 2026-10-01)\n"
        );
        assert_eq!(
            edit("- [ ] a due:2026-09-30 b\n", "a due:2026-09-30 b", None),
            "- [ ] a b\n"
        );
        assert_eq!(
            edit("- [ ] a 📅 2026-09-30\n", "a 📅 2026-09-30", None),
            "- [ ] a\n"
        );
        // New markers: emoji by default, before ✅ / block ids.
        assert_eq!(edit("- [ ] a\n", "a", d), "- [ ] a 📅 2026-10-01\n");
        assert_eq!(
            edit("- [x] a ✅ 2026-09-20 ^id\n", "a ✅ 2026-09-20 ^id", d),
            "- [x] a 📅 2026-10-01 ✅ 2026-09-20 ^id\n"
        );
        // Text style in notes that only use text fields.
        let content = "- [ ] a\n- [ ] b due:2026-09-01\n";
        assert_eq!(
            apply_due(content, "/v/n.md", 0, "a", d).expect("due"),
            "- [ ] a due:2026-10-01\n- [ ] b due:2026-09-01\n"
        );
    }

    #[test]
    fn priority_edits_keep_existing_syntax() {
        let edit =
            |c: &str, text: &str, p| apply_priority(c, "/v/n.md", 0, text, p).expect("priority");
        assert_eq!(
            edit(
                "- [ ] a 🔼 📅 2026-09-30\n",
                "a 🔼 📅 2026-09-30",
                VaultTaskPriority::Urgent
            ),
            "- [ ] a 🔺 📅 2026-09-30\n"
        );
        assert_eq!(
            edit("- [ ] a !low\n", "a !low", VaultTaskPriority::High),
            "- [ ] a !high\n"
        );
        assert_eq!(
            edit("- [ ] a ⏫ b\n", "a ⏫ b", VaultTaskPriority::None),
            "- [ ] a b\n"
        );
        assert_eq!(
            edit(
                "- [ ] a 📅 2026-09-30\n",
                "a 📅 2026-09-30",
                VaultTaskPriority::High
            ),
            "- [ ] a ⏫ 📅 2026-09-30\n"
        );
        assert_eq!(
            edit(
                "- [ ] a due:2026-09-30\n",
                "a due:2026-09-30",
                VaultTaskPriority::Low
            ),
            "- [ ] a !low due:2026-09-30\n"
        );
        assert_eq!(edit("- [ ] a\n", "a", VaultTaskPriority::None), "- [ ] a\n");
    }

    #[test]
    fn append_goes_under_tasks_heading_or_to_the_end() {
        let (c, line) =
            append_task_to_content("# Day\n\n## Tasks\n- [ ] one\n\n## Notes\ntext\n", "two")
                .expect("append");
        assert_eq!(
            c,
            "# Day\n\n## Tasks\n- [ ] one\n- [ ] two\n\n## Notes\ntext\n"
        );
        assert_eq!(line, 4);

        let (c, line) =
            append_task_to_content("# Day\n## tasks\n\n## Next\n", "x").expect("append");
        assert_eq!(c, "# Day\n## tasks\n- [ ] x\n\n## Next\n");
        assert_eq!(line, 2);

        let (c, line) = append_task_to_content("# 2026-09-22\n\n", "new").expect("append");
        assert_eq!(c, "# 2026-09-22\n\n- [ ] new\n");
        assert_eq!(line, 2);

        let (c, line) = append_task_to_content("no newline", "new").expect("append");
        assert_eq!(c, "no newline\n- [ ] new\n");
        assert_eq!(line, 1);

        let (c, _) = append_task_to_content("", "first").expect("append");
        assert_eq!(c, "- [ ] first\n");

        let (c, _) = append_task_to_content("a\r\nb", "crlf").expect("append");
        assert_eq!(c, "a\r\nb\r\n- [ ] crlf\r\n");

        // A "## Tasks" inside a code fence does not count.
        let (c, _) = append_task_to_content("```\n## Tasks\n```\n", "outside").expect("append");
        assert_eq!(c, "```\n## Tasks\n```\n- [ ] outside\n");
    }

    #[test]
    fn append_validates_text() {
        assert!(append_task_to_content("", "   ").is_err());
        assert!(append_task_to_content("", &"x".repeat(MAX_TASK_TEXT + 1)).is_err());
        let (c, _) = append_task_to_content("", "multi\nline").expect("append");
        assert_eq!(c, "- [ ] multi line\n");
    }

    // ── Stats & filters ──

    #[test]
    fn stats_count_by_status_and_due() {
        let content = "- [ ] late 📅 2026-09-20\n- [/] today 📅 2026-09-22\n- [ ] week 📅 2026-09-28\n- [ ] later 📅 2026-10-30\n- [x] done 📅 2026-09-01\n- [-] cancelled 📅 2026-09-01\n";
        let mut tasks = parse_tasks("/v/a.md", content);
        tasks.extend(parse_tasks("/v/b.md", "- [x] b1\n"));
        let stats = compute_stats(&tasks, date(TODAY));
        assert_eq!(stats.total, 7);
        assert_eq!(stats.open, 4);
        assert_eq!(stats.in_progress, 1);
        assert_eq!(stats.done, 2);
        assert_eq!(stats.cancelled, 1);
        assert_eq!(stats.overdue, 1);
        assert_eq!(stats.due_today, 1);
        assert_eq!(stats.due_this_week, 2);
        assert_eq!(stats.by_note.len(), 2);
        assert_eq!(stats.by_note[0].note_name, "a");
        assert_eq!(
            (
                stats.by_note[0].open,
                stats.by_note[0].done,
                stats.by_note[0].overdue
            ),
            (4, 1, 1)
        );
        assert_eq!(stats.by_note[1].total, 1);
    }

    #[test]
    fn filters_combine() {
        let tasks = parse_tasks(
            "/v/Work.md",
            "## Sprint\n- [ ] Write spec 📅 2026-09-25 #work/docs\n- [x] Ship 📅 2026-09-20 #work\n- [ ] Groceries #home\n",
        );
        let run = |f: VaultTaskFilter| -> Vec<String> {
            tasks
                .iter()
                .filter(|t| f.matches(t))
                .map(|t| t.text_clean.clone())
                .collect()
        };
        assert_eq!(
            run(VaultTaskFilter {
                status: Some(VaultTaskStatusFilter::Open),
                ..Default::default()
            })
            .len(),
            2
        );
        assert_eq!(
            run(VaultTaskFilter {
                tag: Some("#Work".into()),
                ..Default::default()
            })
            .len(),
            2
        );
        assert_eq!(
            run(VaultTaskFilter {
                due_before: Some(date("2026-09-22")),
                ..Default::default()
            }),
            vec!["Ship #work"]
        );
        assert_eq!(
            run(VaultTaskFilter {
                due_after: Some(date("2026-09-21")),
                due_before: Some(date("2026-09-30")),
                ..Default::default()
            }),
            vec!["Write spec #work/docs"]
        );
        assert_eq!(
            run(VaultTaskFilter {
                query: Some("SPRINT write".into()),
                ..Default::default()
            }),
            vec!["Write spec #work/docs"]
        );
        assert!(run(VaultTaskFilter {
            note_path: Some("/v/Other.md".into()),
            ..Default::default()
        })
        .is_empty());
    }

    #[test]
    fn due_argument_parsing() {
        assert_eq!(parse_due_arg(None).expect("none"), None);
        assert_eq!(parse_due_arg(Some("  ")).expect("blank"), None);
        assert_eq!(
            parse_due_arg(Some("2026-09-30")).expect("date"),
            Some(date("2026-09-30"))
        );
        assert!(parse_due_arg(Some("30.09.2026")).is_err());
    }

    // ── Engine (filesystem) ──

    struct Fixture {
        vault: TempDir,
        _config: TempDir,
        data: TempDir,
        reader: VaultReader,
    }

    fn fixture() -> Fixture {
        let vault = tempdir().expect("vault dir");
        let config = tempdir().expect("config dir");
        let data = tempdir().expect("data dir");
        let reader = VaultReader::new(config.path()).expect("reader");
        reader
            .set_vault_path(vault.path().to_str().expect("utf-8 path"))
            .expect("set vault");
        Fixture {
            vault,
            _config: config,
            data,
            reader,
        }
    }

    impl Fixture {
        fn note(&self, rel: &str, content: &str) -> String {
            let path = self.vault.path().join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("mkdir");
            }
            fs::write(&path, content).expect("write note");
            path.to_string_lossy().to_string()
        }

        fn engine(&self) -> VaultTasksEngine {
            VaultTasksEngine::new(&self.data.path().join("vaulttasks")).expect("engine")
        }
    }

    #[test]
    fn scan_uses_the_cache_and_invalidates_changed_notes() {
        let fx = fixture();
        let a = fx.note("a.md", "- [ ] alpha\n");
        fx.note("dir/b.md", "- [ ] beta\n- [x] gamma\n");
        fx.note(".hidden/c.md", "- [ ] hidden\n");
        let engine = fx.engine();

        let (tasks, parsed) = engine.scan_inner(&fx.reader, false).expect("scan");
        assert_eq!(tasks.len(), 3);
        assert_eq!(parsed, 2);
        assert!(fx.data.path().join("vaulttasks/cache.json").exists());

        let (_, parsed) = engine.scan_inner(&fx.reader, false).expect("rescan");
        assert_eq!(parsed, 0, "unchanged notes come from the cache");

        fs::write(&a, "- [ ] alpha\n- [ ] alpha two\n").expect("edit");
        let (tasks, parsed) = engine.scan_inner(&fx.reader, false).expect("rescan");
        assert_eq!(parsed, 1);
        assert_eq!(tasks.len(), 4);

        // Same size, different mtime still invalidates.
        fs::write(&a, "- [ ] alphA\n- [ ] alpha two\n").expect("edit");
        let file = fs::File::options().write(true).open(&a).expect("open");
        file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))
            .expect("set mtime");
        let (tasks, parsed) = engine.scan_inner(&fx.reader, false).expect("rescan");
        assert_eq!(parsed, 1);
        assert!(tasks.iter().any(|t| t.text_raw == "alphA"));

        // A fresh engine reuses the persisted cache.
        let (_, parsed) = fx.engine().scan_inner(&fx.reader, false).expect("reload");
        assert_eq!(parsed, 0);

        // Deleted notes disappear; a forced rescan re-parses everything.
        fs::remove_file(&a).expect("delete");
        let (tasks, _) = engine.scan_inner(&fx.reader, false).expect("rescan");
        assert_eq!(tasks.len(), 2);
        let (_, parsed) = engine.scan_inner(&fx.reader, true).expect("force");
        assert_eq!(parsed, 1);
    }

    #[test]
    fn corrupt_cache_starts_empty() {
        let fx = fixture();
        fx.note("a.md", "- [ ] alpha\n");
        let dir = fx.data.path().join("vaulttasks");
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(dir.join("cache.json"), "{not json").expect("write");
        let engine = fx.engine();
        let (tasks, parsed) = engine.scan_inner(&fx.reader, false).expect("scan");
        assert_eq!((tasks.len(), parsed), (1, 1));
    }

    #[test]
    fn toggle_writes_back_and_refreshes_cache() {
        let fx = fixture();
        let path = fx.note(
            "todo.md",
            "# List\n- [ ] Buy milk 📅 2026-09-30\n- [ ] Other\n",
        );
        let engine = fx.engine();
        let tasks = engine.scan(&fx.reader).expect("scan");
        let milk = &tasks[0];

        let done = engine
            .toggle(&fx.reader, &path, milk.line, true, &milk.text_raw)
            .expect("toggle");
        assert!(done.checked);
        assert!(done.done_date.is_some());
        let written = fs::read_to_string(&path).expect("read");
        assert!(written.starts_with("# List\n- [x] Buy milk 📅 2026-09-30 ✅ "));
        assert!(written.ends_with("\n- [ ] Other\n"));

        let (tasks, parsed) = engine.scan_inner(&fx.reader, false).expect("scan");
        assert_eq!(parsed, 0, "the edit refreshed the cache entry");
        assert!(tasks[0].checked);

        // The old text no longer matches: stale.
        let err = engine
            .toggle(&fx.reader, &path, milk.line, false, &milk.text_raw)
            .expect_err("stale");
        assert!(err.to_string().contains(STALE_TASK_ERROR));

        let reopened = engine
            .toggle(&fx.reader, &path, done.line, false, &done.text_raw)
            .expect("untoggle");
        assert_eq!(reopened.text_raw, "Buy milk 📅 2026-09-30");
    }

    #[test]
    fn edits_set_status_due_priority_and_append() {
        let fx = fixture();
        let path = fx.note("p.md", "## Tasks\n- [ ] Plan\n\n## Log\n");
        let engine = fx.engine();
        let plan = engine
            .set_status(&fx.reader, &path, 1, VaultTaskStatus::InProgress, "Plan")
            .expect("status");
        assert_eq!(plan.status, VaultTaskStatus::InProgress);
        let plan = engine
            .set_due(&fx.reader, &path, 1, Some(date("2026-10-02")), "Plan")
            .expect("due");
        assert_eq!(plan.due, Some(date("2026-10-02")));
        let plan = engine
            .set_priority(
                &fx.reader,
                &path,
                1,
                VaultTaskPriority::Urgent,
                &plan.text_raw,
            )
            .expect("priority");
        assert_eq!(plan.priority, VaultTaskPriority::Urgent);
        assert_eq!(plan.text_raw, "Plan 🔺 📅 2026-10-02");

        let added = engine
            .append_task(&fx.reader, &path, "Review")
            .expect("append");
        assert_eq!(added.line, 2);
        assert_eq!(added.section.as_deref(), Some("Tasks"));
        assert_eq!(
            fs::read_to_string(&path).expect("read"),
            "## Tasks\n- [/] Plan 🔺 📅 2026-10-02\n- [ ] Review\n\n## Log\n"
        );
    }

    #[test]
    fn edits_reject_paths_outside_the_vault() {
        let fx = fixture();
        let engine = fx.engine();
        let outside = tempdir().expect("outside");
        let evil = outside.path().join("evil.md");
        fs::write(&evil, "- [ ] x\n").expect("write");
        let err = engine
            .toggle(&fx.reader, evil.to_str().expect("utf-8"), 0, true, "x")
            .expect_err("outside");
        assert!(err.to_string().contains("outside the vault"), "{err}");

        let traversal = format!("{}/../evil.md", fx.vault.path().display());
        assert!(engine.append_task(&fx.reader, &traversal, "x").is_err());

        let hidden = fx.note(".obsidian/x.md", "- [ ] x\n");
        assert!(engine.toggle(&fx.reader, &hidden, 0, true, "x").is_err());

        let txt = fx.note("notes.txt", "- [ ] x\n");
        assert!(engine.toggle(&fx.reader, &txt, 0, true, "x").is_err());
        assert_eq!(fs::read_to_string(&evil).expect("read"), "- [ ] x\n");
    }

    #[test]
    fn list_and_stats_go_through_the_scan() {
        let fx = fixture();
        let today = chrono::Local::now().date_naive();
        fx.note(
            "a.md",
            &format!(
                "- [ ] due today 📅 {today}\n- [x] done\n- [ ] tagged #focus\n",
                today = today.format("%Y-%m-%d")
            ),
        );
        let engine = fx.engine();
        let stats = engine.stats(&fx.reader).expect("stats");
        assert_eq!((stats.open, stats.done, stats.due_today), (2, 1, 1));
        let focus = engine
            .list(
                &fx.reader,
                &VaultTaskFilter {
                    tag: Some("focus".into()),
                    ..Default::default()
                },
            )
            .expect("list");
        assert_eq!(focus.len(), 1);
        assert_eq!(engine.rescan(&fx.reader).expect("rescan").len(), 3);
    }

    #[test]
    fn switching_vaults_resets_the_cache() {
        let fx = fixture();
        fx.note("a.md", "- [ ] first vault\n");
        let engine = fx.engine();
        assert_eq!(engine.scan(&fx.reader).expect("scan").len(), 1);

        let other = tempdir().expect("other vault");
        fs::write(other.path().join("b.md"), "- [ ] second\n- [ ] vault\n").expect("write");
        fx.reader
            .set_vault_path(other.path().to_str().expect("utf-8"))
            .expect("switch");
        let tasks = engine.scan(&fx.reader).expect("scan");
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().all(|t| t.note_name == "b"));
    }
}
