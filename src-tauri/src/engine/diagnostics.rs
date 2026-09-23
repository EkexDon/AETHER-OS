//! Local crash reporting and diagnostics.
//!
//! Everything stays on the user's machine — nothing is uploaded:
//!
//! - `crash-reports/<timestamp>.log` — one file per Rust panic or fatal
//!   frontend render error (message, location, thread, app version, OS,
//!   backtrace / component stack). The timestamp is RFC 3339 in UTC with
//!   `:` replaced by `-` so the name is valid on every filesystem
//!   (e.g. `2026-09-22T20-17-03.512Z.log`); the file stem is the report id.
//! - `logs/aether.log` — append-only application log (panics, frontend
//!   errors, lifecycle lines). Rotated at 5 MB, keeping three old files
//!   (`aether.log.1` … `aether.log.3`).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

/// Rotate `aether.log` once it reaches this size.
pub const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
/// Number of rotated log files kept next to the live log.
const LOG_KEEP_ROTATED: u32 = 3;
const CRASH_DIR: &str = "crash-reports";
const LOG_DIR: &str = "logs";
const LOG_FILE: &str = "aether.log";
/// Upper bounds for untrusted frontend payload fields.
const MAX_MESSAGE_CHARS: usize = 4_000;
const MAX_STACK_CHARS: usize = 16_000;
const MAX_SHORT_FIELD_CHARS: usize = 300;

/// Summary row for the crash report list (newest first).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CrashReportSummary {
    /// File stem, used to read the full report.
    pub id: String,
    /// RFC 3339 timestamp (UTC) of the crash.
    pub created_at: String,
    /// `"panic"` for Rust panics, `"frontend"` for webview render crashes.
    pub kind: String,
    /// First line of the crash message.
    pub message: String,
    /// Report size in bytes.
    pub size: u64,
}

/// Full crash report content.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CrashReport {
    pub id: String,
    pub created_at: String,
    pub kind: String,
    pub content: String,
}

/// Error details reported by the webview (`cmd_log_frontend_error`).
///
/// All fields except `message` are optional; the payload is untrusted and
/// every field is truncated before it is written to disk.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FrontendErrorPayload {
    pub message: String,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub component_stack: Option<String>,
    /// Origin of the error: `boundary`, `window.onerror`,
    /// `unhandledrejection`, …
    #[serde(default)]
    pub source: Option<String>,
    /// View or component name the error happened in.
    #[serde(default)]
    pub view: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    /// `true` when the error took down a view (error boundary). Fatal
    /// errors additionally produce a crash report.
    #[serde(default)]
    pub fatal: bool,
}

/// Static facts about the running build, captured once at start-up.
#[derive(Debug, Clone)]
struct BuildFacts {
    app_version: String,
    os: String,
}

/// Serialises writes to the live log and performs size-based rotation.
#[derive(Debug)]
struct LogSink {
    path: PathBuf,
    lock: Mutex<()>,
    rotate_bytes: u64,
}

impl LogSink {
    fn append(&self, level: &str, target: &str, message: &str) -> Result<(), AetherError> {
        // A poisoned or contended lock must never stop a crash from being
        // logged, so the guard is best-effort.
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.append_unlocked(level, target, message)
    }

    /// Used from the panic hook, which may run while another thread holds
    /// the lock: never block there.
    fn append_from_hook(&self, level: &str, target: &str, message: &str) {
        let _guard = self.lock.try_lock();
        let _ = self.append_unlocked(level, target, message);
    }

    fn append_unlocked(&self, level: &str, target: &str, message: &str) -> Result<(), AetherError> {
        rotate_if_needed(&self.path, self.rotate_bytes, LOG_KEEP_ROTATED)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(format_log_line(level, target, message).as_bytes())?;
        Ok(())
    }
}

/// Local crash reporter and application log.
#[derive(Debug)]
pub struct Diagnostics {
    data_dir: PathBuf,
    crash_dir: PathBuf,
    sink: Arc<LogSink>,
    facts: BuildFacts,
}

impl Diagnostics {
    /// Create the diagnostics directories under `data_dir` and install the
    /// process-wide panic hook. Call once, as early as possible in `setup`.
    pub fn new(data_dir: &Path) -> Result<Self, AetherError> {
        let diagnostics = Self::open(data_dir)?;
        diagnostics.install_panic_hook();
        diagnostics.log_info(
            "app",
            &format!(
                "AETHER-OS {} starting on {}",
                diagnostics.facts.app_version, diagnostics.facts.os
            ),
        )?;
        Ok(diagnostics)
    }

    /// Like [`Diagnostics::new`] but without touching the global panic
    /// hook (used by tests and tools).
    pub fn open(data_dir: &Path) -> Result<Self, AetherError> {
        Self::open_with_rotation(data_dir, LOG_ROTATE_BYTES)
    }

    fn open_with_rotation(data_dir: &Path, rotate_bytes: u64) -> Result<Self, AetherError> {
        let crash_dir = data_dir.join(CRASH_DIR);
        let log_dir = data_dir.join(LOG_DIR);
        std::fs::create_dir_all(&crash_dir)?;
        std::fs::create_dir_all(&log_dir)?;
        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            crash_dir,
            sink: Arc::new(LogSink {
                path: log_dir.join(LOG_FILE),
                lock: Mutex::new(()),
                rotate_bytes,
            }),
            facts: BuildFacts {
                app_version: env!("CARGO_PKG_VERSION").to_owned(),
                os: describe_os(),
            },
        })
    }

    /// The app data directory this instance writes into.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Path of the live log file.
    pub fn log_path(&self) -> &Path {
        &self.sink.path
    }

    /// Install a panic hook that writes a crash report and a log line, then
    /// delegates to the previously installed hook (so panics still print to
    /// stderr during development).
    pub fn install_panic_hook(&self) {
        let crash_dir = self.crash_dir.clone();
        let sink = Arc::clone(&self.sink);
        let facts = self.facts.clone();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let message = panic_message(info.payload());
            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "<unknown>".to_owned());
            let thread = std::thread::current()
                .name()
                .unwrap_or("<unnamed>")
                .to_owned();
            let backtrace = std::backtrace::Backtrace::force_capture().to_string();
            let body = render_panic_report(&facts, &message, &location, &thread, &backtrace);
            let id = write_crash_report(&crash_dir, &body).ok();
            sink.append_from_hook(
                "PANIC",
                "rust",
                &format!(
                    "thread '{thread}' panicked at {location}: {message}{}",
                    id.map(|id| format!(" (crash report {id})"))
                        .unwrap_or_default()
                ),
            );
            previous(info);
        }));
    }

    /// Append an informational line to the application log.
    pub fn log_info(&self, target: &str, message: &str) -> Result<(), AetherError> {
        self.sink.append("INFO", target, message)
    }

    /// Record an error reported by the webview. Always logged; fatal errors
    /// (error boundary) also produce a crash report whose id is returned.
    pub fn log_frontend_error(
        &self,
        payload: &FrontendErrorPayload,
    ) -> Result<Option<String>, AetherError> {
        let message = clip(payload.message.trim(), MAX_MESSAGE_CHARS);
        if message.is_empty() {
            return Err(AetherError::InvalidInput(
                "frontend error message is empty".to_owned(),
            ));
        }
        let source = clip_opt(&payload.source, MAX_SHORT_FIELD_CHARS);
        let view = clip_opt(&payload.view, MAX_SHORT_FIELD_CHARS);
        let url = clip_opt(&payload.url, MAX_SHORT_FIELD_CHARS);
        let stack = clip_opt(&payload.stack, MAX_STACK_CHARS);
        let component_stack = clip_opt(&payload.component_stack, MAX_STACK_CHARS);

        let mut line = message.clone();
        let mut context = Vec::new();
        if let Some(source) = &source {
            context.push(format!("source={source}"));
        }
        if let Some(view) = &view {
            context.push(format!("view={view}"));
        }
        if !context.is_empty() {
            line.push_str(&format!(" [{}]", context.join(" ")));
        }
        if let Some(stack) = &stack {
            line.push('\n');
            line.push_str(&indent(stack));
        }
        self.sink.append("ERROR", "frontend", &line)?;

        if !payload.fatal {
            return Ok(None);
        }
        let mut body = report_header(&self.facts, "frontend");
        push_field(&mut body, "source", source.as_deref().unwrap_or("unknown"));
        push_field(&mut body, "view", view.as_deref().unwrap_or("unknown"));
        push_field(&mut body, "url", url.as_deref().unwrap_or(""));
        push_field(&mut body, "message", &first_line(&message));
        body.push_str("\nfull message:\n");
        body.push_str(&indent(&message));
        body.push('\n');
        if let Some(stack) = &stack {
            body.push_str("\nstack:\n");
            body.push_str(&indent(stack));
            body.push('\n');
        }
        if let Some(component_stack) = &component_stack {
            body.push_str("\ncomponent stack:\n");
            body.push_str(&indent(component_stack));
            body.push('\n');
        }
        write_crash_report(&self.crash_dir, &body).map(Some)
    }

    /// All crash reports, newest first.
    pub fn list_crash_reports(&self) -> Result<Vec<CrashReportSummary>, AetherError> {
        let mut reports = Vec::new();
        for entry in std::fs::read_dir(&self.crash_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("log") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
                continue;
            };
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let header = parse_header(&content);
            reports.push(CrashReportSummary {
                created_at: header.created_at.unwrap_or_else(|| id.clone()),
                kind: header.kind.unwrap_or_else(|| "unknown".to_owned()),
                message: header.message.unwrap_or_default(),
                size,
                id,
            });
        }
        reports.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(reports)
    }

    /// Read one crash report by id. Ids are validated so the webview cannot
    /// read arbitrary files.
    pub fn read_crash_report(&self, id: &str) -> Result<CrashReport, AetherError> {
        validate_report_id(id)?;
        let path = self.crash_dir.join(format!("{id}.log"));
        if !path.is_file() {
            return Err(AetherError::InvalidInput(format!(
                "crash report not found: {id}"
            )));
        }
        let content = std::fs::read_to_string(&path)?;
        let header = parse_header(&content);
        Ok(CrashReport {
            id: id.to_owned(),
            created_at: header.created_at.unwrap_or_else(|| id.to_owned()),
            kind: header.kind.unwrap_or_else(|| "unknown".to_owned()),
            content,
        })
    }

    /// Delete every crash report. Returns how many were removed.
    pub fn clear_crash_reports(&self) -> Result<usize, AetherError> {
        let mut removed = 0;
        for entry in std::fs::read_dir(&self.crash_dir)? {
            let path = entry?.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("log") {
                std::fs::remove_file(&path)?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}

/// Open `path` in the platform file manager (Finder, Explorer, or the
/// desktop's default handler via `xdg-open`). Does not wait for the
/// file manager to exit.
pub fn open_in_file_manager(path: &Path) -> Result<(), AetherError> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";

    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map_err(|e| {
            AetherError::Io(std::io::Error::other(format!(
                "failed to run {program}: {e}"
            )))
        })?;
    Ok(())
}

fn describe_os() -> String {
    let base = format!("{} ({})", std::env::consts::OS, std::env::consts::ARCH);
    match sysinfo::System::long_os_version() {
        Some(version) if !version.trim().is_empty() => format!("{} — {base}", version.trim()),
        _ => base,
    }
}

/// Extract the human-readable message from a panic payload.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_owned()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_owned()
    }
}

fn report_header(facts: &BuildFacts, kind: &str) -> String {
    let mut body = String::from("AETHER-OS crash report\n\n");
    push_field(&mut body, "kind", kind);
    push_field(&mut body, "time", &chrono::Utc::now().to_rfc3339());
    push_field(&mut body, "app_version", &facts.app_version);
    push_field(&mut body, "os", &facts.os);
    body
}

fn render_panic_report(
    facts: &BuildFacts,
    message: &str,
    location: &str,
    thread: &str,
    backtrace: &str,
) -> String {
    let mut body = report_header(facts, "panic");
    push_field(&mut body, "thread", thread);
    push_field(&mut body, "location", location);
    push_field(&mut body, "message", &first_line(message));
    body.push_str("\nfull message:\n");
    body.push_str(&indent(message));
    body.push_str("\n\nbacktrace:\n");
    body.push_str(&indent(backtrace));
    body.push('\n');
    body
}

fn push_field(body: &mut String, key: &str, value: &str) {
    body.push_str(key);
    body.push_str(": ");
    body.push_str(&first_line(value));
    body.push('\n');
}

#[derive(Default)]
struct ReportHeader {
    kind: Option<String>,
    created_at: Option<String>,
    message: Option<String>,
}

/// Read the `key: value` header lines written by [`report_header`].
fn parse_header(content: &str) -> ReportHeader {
    let mut header = ReportHeader::default();
    for line in content.lines().take(20) {
        if let Some(v) = line.strip_prefix("kind: ") {
            header.kind.get_or_insert_with(|| v.to_owned());
        } else if let Some(v) = line.strip_prefix("time: ") {
            header.created_at.get_or_insert_with(|| v.to_owned());
        } else if let Some(v) = line.strip_prefix("message: ") {
            header.message.get_or_insert_with(|| v.to_owned());
        }
    }
    header
}

/// Write a new crash report and return its id (the file stem).
fn write_crash_report(dir: &Path, body: &str) -> Result<String, AetherError> {
    std::fs::create_dir_all(dir)?;
    let stamp = chrono::Utc::now()
        .format("%Y-%m-%dT%H-%M-%S%.3fZ")
        .to_string();
    for attempt in 0..100u32 {
        let id = if attempt == 0 {
            stamp.clone()
        } else {
            format!("{stamp}-{attempt}")
        };
        let path = dir.join(format!("{id}.log"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(body.as_bytes())?;
                return Ok(id);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(AetherError::Io(std::io::Error::other(
        "too many crash reports within one millisecond",
    )))
}

/// Report ids are generated by [`write_crash_report`]; anything that could
/// escape the crash directory is rejected.
fn validate_report_id(id: &str) -> Result<(), AetherError> {
    let valid = !id.is_empty()
        && id.len() <= 128
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if valid {
        Ok(())
    } else {
        Err(AetherError::InvalidInput(format!(
            "invalid crash report id: {id}"
        )))
    }
}

/// Rotate `path` when it is at least `max_bytes` large:
/// `log.2 → log.3`, `log.1 → log.2`, `log → log.1` (keeping `keep` files).
fn rotate_if_needed(path: &Path, max_bytes: u64, keep: u32) -> Result<(), AetherError> {
    let size = match std::fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    if size < max_bytes {
        return Ok(());
    }
    let rotated = |n: u32| {
        let mut name = path.as_os_str().to_owned();
        name.push(format!(".{n}"));
        PathBuf::from(name)
    };
    let oldest = rotated(keep);
    if oldest.exists() {
        std::fs::remove_file(&oldest)?;
    }
    for n in (1..keep).rev() {
        let from = rotated(n);
        if from.exists() {
            std::fs::rename(&from, rotated(n + 1))?;
        }
    }
    std::fs::rename(path, rotated(1))?;
    Ok(())
}

fn format_log_line(level: &str, target: &str, message: &str) -> String {
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
    format!("{stamp} {level:<5} [{target}] {}\n", message.trim_end())
}

fn first_line(value: &str) -> String {
    value.lines().next().unwrap_or("").trim().to_owned()
}

fn indent(text: &str) -> String {
    text.lines()
        .map(|l| format!("    {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn clip(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_owned()
    } else {
        let mut out: String = value.chars().take(max_chars).collect();
        out.push_str(" …[truncated]");
        out
    }
}

fn clip_opt(value: &Option<String>, max_chars: usize) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| clip(v, max_chars))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnostics() -> (tempfile::TempDir, Diagnostics) {
        let dir = tempfile::tempdir().expect("temp dir");
        let diagnostics = Diagnostics::open(dir.path()).expect("open diagnostics");
        (dir, diagnostics)
    }

    fn payload(message: &str, fatal: bool) -> FrontendErrorPayload {
        FrontendErrorPayload {
            message: message.to_owned(),
            stack: Some("Error: boom\n    at Editor (Editor.tsx:10:5)".to_owned()),
            component_stack: Some("    at Editor\n    at App".to_owned()),
            source: Some("boundary".to_owned()),
            view: Some("Editor".to_owned()),
            url: Some("http://127.0.0.1:1420/".to_owned()),
            fatal,
        }
    }

    #[test]
    fn open_creates_directories() {
        let (dir, _diagnostics) = diagnostics();
        assert!(dir.path().join("crash-reports").is_dir());
        assert!(dir.path().join("logs").is_dir());
    }

    #[test]
    fn non_fatal_frontend_errors_are_logged_without_a_report() {
        let (_dir, diagnostics) = diagnostics();
        let id = diagnostics
            .log_frontend_error(&payload("TypeError: x is undefined", false))
            .expect("log");
        assert!(id.is_none());
        assert!(diagnostics.list_crash_reports().expect("list").is_empty());
        let log = std::fs::read_to_string(diagnostics.log_path()).expect("log file");
        assert!(log
            .contains("ERROR [frontend] TypeError: x is undefined [source=boundary view=Editor]"));
        assert!(log.contains("    at Editor (Editor.tsx:10:5)"));
    }

    #[test]
    fn fatal_frontend_errors_produce_a_readable_crash_report() {
        let (_dir, diagnostics) = diagnostics();
        let id = diagnostics
            .log_frontend_error(&payload("Render failed\nsecond line", true))
            .expect("log")
            .expect("fatal errors write a report");

        let list = diagnostics.list_crash_reports().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].kind, "frontend");
        assert_eq!(list[0].message, "Render failed");

        let report = diagnostics.read_crash_report(&id).expect("read");
        assert!(report.content.contains("view: Editor"));
        assert!(report.content.contains("component stack:"));
        assert!(report.content.contains("app_version: "));
        assert!(report.content.contains("os: "));
    }

    #[test]
    fn empty_frontend_messages_are_rejected() {
        let (_dir, diagnostics) = diagnostics();
        assert!(diagnostics
            .log_frontend_error(&payload("   ", false))
            .is_err());
    }

    #[test]
    fn oversized_payloads_are_truncated() {
        let (_dir, diagnostics) = diagnostics();
        let huge = "x".repeat(MAX_MESSAGE_CHARS * 3);
        diagnostics
            .log_frontend_error(&payload(&huge, false))
            .expect("log");
        let log = std::fs::read_to_string(diagnostics.log_path()).expect("log file");
        assert!(log.contains("…[truncated]"));
        assert!(log.len() < MAX_MESSAGE_CHARS * 2 + MAX_STACK_CHARS);
    }

    #[test]
    fn crash_reports_are_listed_newest_first_and_cleared() {
        let (dir, diagnostics) = diagnostics();
        let crash_dir = dir.path().join("crash-reports");
        let first = write_crash_report(&crash_dir, "kind: panic\nmessage: one\n").expect("one");
        let second = write_crash_report(&crash_dir, "kind: panic\nmessage: two\n").expect("two");
        assert_ne!(first, second, "ids never collide");

        let list = diagnostics.list_crash_reports().expect("list");
        assert_eq!(list.len(), 2);
        assert!(list[0].id >= list[1].id, "newest first");

        assert_eq!(diagnostics.clear_crash_reports().expect("clear"), 2);
        assert!(diagnostics.list_crash_reports().expect("list").is_empty());
    }

    #[test]
    fn crash_report_ids_cannot_escape_the_directory() {
        let (_dir, diagnostics) = diagnostics();
        for bad in ["../secret", "a/b", "", "..", "x\\y", "report.log/../../etc"] {
            let err = diagnostics.read_crash_report(bad).expect_err(bad);
            assert!(
                err.to_string().contains("invalid crash report id"),
                "{bad}: {err}"
            );
        }
        let err = diagnostics
            .read_crash_report("2026-01-01T00-00-00.000Z")
            .expect_err("missing report");
        assert!(err.to_string().contains("not found"));
    }

    #[test]
    fn logs_rotate_at_the_size_limit_and_keep_three_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let diagnostics = Diagnostics::open_with_rotation(dir.path(), 64).expect("open");
        for i in 0..20 {
            diagnostics
                .log_info("test", &format!("line number {i} with some padding"))
                .expect("log");
        }
        let log = diagnostics.log_path().to_path_buf();
        let rotated = |n: u32| PathBuf::from(format!("{}.{n}", log.display()));
        assert!(log.exists());
        assert!(rotated(1).exists());
        assert!(rotated(2).exists());
        assert!(rotated(3).exists());
        assert!(!rotated(4).exists(), "only three rotated files are kept");
        let live = std::fs::metadata(&log).expect("meta").len();
        assert!(live < 64 * 2, "live log was rotated (size {live})");
    }

    #[test]
    fn panic_messages_are_extracted_from_both_payload_types() {
        let static_str: Box<dyn std::any::Any + Send> = Box::new("static message");
        let owned: Box<dyn std::any::Any + Send> = Box::new(String::from("owned message"));
        let other: Box<dyn std::any::Any + Send> = Box::new(42_u32);
        assert_eq!(panic_message(static_str.as_ref()), "static message");
        assert_eq!(panic_message(owned.as_ref()), "owned message");
        assert_eq!(panic_message(other.as_ref()), "<non-string panic payload>");
    }

    #[test]
    fn panic_report_contains_all_required_fields() {
        let facts = BuildFacts {
            app_version: "9.9.9".to_owned(),
            os: "testOS (x86_64)".to_owned(),
        };
        let body = render_panic_report(&facts, "boom", "src/lib.rs:1:1", "worker", "0: frame");
        let header = parse_header(&body);
        assert_eq!(header.kind.as_deref(), Some("panic"));
        assert_eq!(header.message.as_deref(), Some("boom"));
        assert!(header.created_at.is_some());
        for needle in [
            "app_version: 9.9.9",
            "os: testOS (x86_64)",
            "thread: worker",
            "location: src/lib.rs:1:1",
            "backtrace:",
        ] {
            assert!(body.contains(needle), "missing {needle}");
        }
    }

    /// Installs the real hook, panics on a named thread and checks that a
    /// crash report and a log line were written. The previous hook is
    /// restored afterwards so other tests keep their default output.
    #[test]
    fn panic_hook_writes_crash_report_and_log_line() {
        let (_dir, diagnostics) = diagnostics();
        diagnostics.install_panic_hook();

        let result = std::thread::Builder::new()
            .name("diagnostics-test".to_owned())
            .spawn(|| panic!("deliberate test panic"))
            .expect("spawn")
            .join();
        assert!(result.is_err());

        // Restore the default hook for the remaining tests.
        let _ = std::panic::take_hook();

        let reports = diagnostics.list_crash_reports().expect("list");
        let ours = reports
            .iter()
            .find(|r| r.message == "deliberate test panic")
            .expect("crash report for our panic");
        let report = diagnostics.read_crash_report(&ours.id).expect("read");
        assert!(report.content.contains("thread: diagnostics-test"));
        assert!(report.content.contains("diagnostics.rs"));

        let log = std::fs::read_to_string(diagnostics.log_path()).expect("log");
        assert!(log.contains("PANIC [rust] thread 'diagnostics-test' panicked at"));
    }
}
