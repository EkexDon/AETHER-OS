//! Approval-gated agent actions and their audit trail.
//!
//! Everything here runs only *after* the user approved an action in the
//! frontend's approval dialog (or an "always allow" rule matched). The
//! operations are deliberately conservative:
//!
//! - notes are never hard-deleted: `delete_note` moves them to
//!   `<vault>/.trash/<timestamp>-<name>.md` (hidden from the vault scan),
//! - moves never overwrite an existing note,
//! - every path from the UI/model is resolved inside the vault root and
//!   rejected when it escapes it or points into a hidden folder,
//! - `git_commit` refuses to create empty commits,
//! - the task toggle is a minimal one-line rewrite of the Markdown checkbox.
//!
//! Every executed (or denied) action is appended to `audit.jsonl`.

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::engine::agent_actions::{
    action_kind, action_risk, describe_action, ActionRisk, AgentAction,
};
use crate::engine::error::AetherError;
use crate::engine::git_repo::GitRepo;
use crate::engine::task_board::TaskProject;
use crate::engine::vault_reader::VaultNote;

/// Size after which the audit log is trimmed to its newer half.
pub const MAX_AUDIT_BYTES: u64 = 2 * 1024 * 1024;
/// Longest stored `detail`.
pub const MAX_DETAIL_CHARS: usize = 600;
/// Folder (inside the vault) that receives deleted notes.
pub const TRASH_DIR: &str = ".trash";
/// Project used for agent tasks when none is given.
pub const INBOX_PROJECT: &str = "Inbox";
/// Accepted task priorities (mirrors the task board).
pub const PRIORITIES: [&str; 5] = ["none", "low", "medium", "high", "urgent"];

/// Outcome recorded for an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditStatus {
    Ok,
    Error,
    Denied,
}

/// One line of `audit.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    /// RFC 3339 local time.
    pub timestamp: String,
    /// The action discriminator (`run_command`, `create_note`, …).
    pub action: String,
    pub risk: ActionRisk,
    /// One-line human description.
    pub summary: String,
    pub status: AuditStatus,
    /// Result or error message, clipped to [`MAX_DETAIL_CHARS`].
    pub detail: Option<String>,
    pub duration_ms: Option<u64>,
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_owned()
    } else {
        let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Append-only JSON-lines log of agent actions.
pub struct AuditLog {
    path: PathBuf,
    lock: Mutex<()>,
}

impl AuditLog {
    /// A log stored at `path` (created on first write).
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    /// Build and append an entry for `action`.
    pub fn record(
        &self,
        action: &AgentAction,
        status: AuditStatus,
        detail: Option<&str>,
        duration: Option<Duration>,
    ) -> Result<AuditEntry, AetherError> {
        let entry = AuditEntry {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Local::now().to_rfc3339(),
            action: action_kind(action).to_owned(),
            risk: action_risk(action),
            summary: clip(&describe_action(action), 200),
            status,
            detail: detail
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(|d| clip(d, MAX_DETAIL_CHARS)),
            duration_ms: duration.map(|d| d.as_millis() as u64),
        };
        self.append(&entry)?;
        Ok(entry)
    }

    /// Append one entry, trimming the file when it grows past
    /// [`MAX_AUDIT_BYTES`].
    pub fn append(&self, entry: &AuditEntry) -> Result<(), AetherError> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let line = serde_json::to_string(entry)
            .map_err(|e| AetherError::InvalidInput(format!("audit serialize: {e}")))?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(file, "{line}")?;
        drop(file);
        if std::fs::metadata(&self.path)?.len() > MAX_AUDIT_BYTES {
            self.trim_locked()?;
        }
        Ok(())
    }

    fn trim_locked(&self) -> Result<(), AetherError> {
        let content = std::fs::read_to_string(&self.path)?;
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        let keep = &lines[lines.len() / 2..];
        let tmp = self.path.with_extension("jsonl.tmp");
        std::fs::write(&tmp, format!("{}\n", keep.join("\n")))?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// Newest entries first; malformed lines are skipped.
    pub fn list(&self, limit: usize) -> Result<Vec<AuditEntry>, AetherError> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let content = match std::fs::read_to_string(&self.path) {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        Ok(content
            .lines()
            .rev()
            .filter_map(|line| serde_json::from_str::<AuditEntry>(line).ok())
            .take(limit)
            .collect())
    }

    /// Remove every entry.
    pub fn clear(&self) -> Result<(), AetherError> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

// ── Vault paths ────────────────────────────────────────────────────────

fn outside(path: &Path) -> AetherError {
    AetherError::InvalidInput(format!("path is outside the vault: {}", path.display()))
}

/// True when any component of `path` below `root` starts with a dot
/// (`.trash`, `.git`, `.obsidian`, `.nopes`).
fn has_hidden_component(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).map_or(true, |rel| {
        rel.components().any(|c| match c {
            Component::Normal(part) => part.to_string_lossy().starts_with('.'),
            _ => true,
        })
    })
}

fn ensure_note_inside(root: &Path, canonical: &Path) -> Result<(), AetherError> {
    if !canonical.starts_with(root) || canonical == root {
        return Err(outside(canonical));
    }
    if has_hidden_component(root, canonical) {
        return Err(AetherError::InvalidInput(format!(
            "refusing to touch files in hidden folders: {}",
            canonical.display()
        )));
    }
    let is_md = canonical
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
    if !is_md {
        return Err(AetherError::InvalidInput(format!(
            "only Markdown notes (.md) can be changed: {}",
            canonical.display()
        )));
    }
    Ok(())
}

fn with_md(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".md");
    PathBuf::from(s)
}

/// Resolve an existing note from an absolute path, a vault-relative path
/// (with or without `.md`) or a bare note name (unique, case-insensitive).
/// `root` must be the canonical vault root; `notes` is the vault scan used
/// for name lookups.
pub fn resolve_existing_note(
    root: &Path,
    input: &str,
    notes: &[VaultNote],
) -> Result<PathBuf, AetherError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AetherError::InvalidInput(
            "note path must not be empty".to_owned(),
        ));
    }
    let requested = Path::new(trimmed);
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    for attempt in [candidate.clone(), with_md(&candidate)] {
        if attempt.is_file() {
            let canonical = std::fs::canonicalize(&attempt)?;
            ensure_note_inside(root, &canonical)?;
            return Ok(canonical);
        }
    }
    if !trimmed.contains('/') && !trimmed.contains('\\') {
        let wanted = trimmed
            .strip_suffix(".md")
            .unwrap_or(trimmed)
            .to_lowercase();
        let matches: Vec<&VaultNote> = notes
            .iter()
            .filter(|n| n.name.to_lowercase() == wanted)
            .collect();
        match matches.as_slice() {
            [one] => {
                let canonical = std::fs::canonicalize(&one.path)?;
                ensure_note_inside(root, &canonical)?;
                return Ok(canonical);
            }
            [] => {}
            many => {
                let list: Vec<&str> = many.iter().map(|n| n.path.as_str()).take(5).collect();
                return Err(AetherError::InvalidInput(format!(
                    "\"{trimmed}\" matches {} notes, use a path: {}",
                    many.len(),
                    list.join(", ")
                )));
            }
        }
    }
    Err(AetherError::InvalidInput(format!(
        "note not found: {trimmed}"
    )))
}

/// Canonicalize a path that may not exist yet: the deepest existing
/// ancestor is canonicalized and the remaining (plain) components are
/// appended. `..` in the non-existing part is rejected.
fn canonicalize_lenient(path: &Path) -> Result<PathBuf, AetherError> {
    let mut existing = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .ok_or_else(|| AetherError::InvalidInput(format!("invalid path: {}", path.display())))?
            .to_owned();
        rest.push(name);
        if !existing.pop() {
            return Err(AetherError::InvalidInput(format!(
                "invalid path: {}",
                path.display()
            )));
        }
    }
    let mut out = std::fs::canonicalize(&existing)?;
    for part in rest.iter().rev() {
        if part == ".." || part == "." {
            return Err(AetherError::InvalidInput(format!(
                "path must not contain '..': {}",
                path.display()
            )));
        }
        out.push(part);
    }
    Ok(out)
}

/// Resolve where a note moves to: `to` is vault-relative (or absolute inside
/// the vault); a trailing `/` or an existing folder keeps the file name;
/// `.md` is added when missing. The target must not exist yet.
pub fn resolve_move_target(root: &Path, from: &Path, to: &str) -> Result<PathBuf, AetherError> {
    let trimmed = to.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err(AetherError::InvalidInput(
            "move target must not be empty".to_owned(),
        ));
    }
    if Path::new(&trimmed)
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(AetherError::InvalidInput(format!(
            "move target must not contain '..': {trimmed}"
        )));
    }
    let raw = if Path::new(&trimmed).is_absolute() {
        PathBuf::from(&trimmed)
    } else {
        root.join(trimmed.trim_start_matches("./"))
    };
    let file_name = from
        .file_name()
        .ok_or_else(|| AetherError::InvalidInput("source note has no file name".to_owned()))?;
    let mut target = if trimmed.ends_with('/') || raw.is_dir() {
        raw.join(file_name)
    } else {
        raw
    };
    match target.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("md") => {}
        // A real file extension (`.txt`, `.png`): refuse to change the type.
        // Dots inside names ("Meeting v1.2", "Dr. Smith") just get `.md`.
        Some(ext)
            if (1..=4).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphabetic()) =>
        {
            return Err(AetherError::InvalidInput(format!(
                "notes must keep the .md extension (got .{ext})"
            )));
        }
        _ => target = with_md(&target),
    }
    let canonical = canonicalize_lenient(&target)?;
    ensure_note_inside(root, &canonical)?;
    if canonical.exists() {
        return Err(AetherError::InvalidInput(format!(
            "a note already exists at {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

/// A note moved to the vault trash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrashedNote {
    pub original_path: String,
    pub trash_path: String,
}

/// A moved/renamed note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MovedNote {
    pub from: String,
    pub to: String,
}

fn rename_or_copy(from: &Path, to: &Path) -> Result<(), AetherError> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Different filesystems (e.g. a symlinked subfolder): copy + remove.
            std::fs::copy(from, to)?;
            std::fs::remove_file(from)?;
            Ok(())
        }
    }
}

/// Move `note` (already resolved) to `<root>/.trash/<YYYYmmdd-HHMMSS>-<name>`.
pub fn trash_note(
    root: &Path,
    note: &Path,
    now: chrono::DateTime<chrono::Local>,
) -> Result<TrashedNote, AetherError> {
    ensure_note_inside(root, note)?;
    let trash = root.join(TRASH_DIR);
    std::fs::create_dir_all(&trash)?;
    let name = note
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| AetherError::InvalidInput("note has no file name".to_owned()))?;
    let stamp = now.format("%Y%m%d-%H%M%S").to_string();
    let mut target = trash.join(format!("{stamp}-{name}"));
    let mut counter = 2;
    while target.exists() {
        target = trash.join(format!("{stamp}-{counter}-{name}"));
        counter += 1;
    }
    rename_or_copy(note, &target)?;
    Ok(TrashedNote {
        original_path: note.to_string_lossy().into_owned(),
        trash_path: target.to_string_lossy().into_owned(),
    })
}

/// Move `from` to the already-resolved `to`, creating parent folders.
pub fn move_note(root: &Path, from: &Path, to: &Path) -> Result<MovedNote, AetherError> {
    ensure_note_inside(root, from)?;
    ensure_note_inside(root, to)?;
    if to.exists() {
        return Err(AetherError::InvalidInput(format!(
            "a note already exists at {}",
            to.display()
        )));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    rename_or_copy(from, to)?;
    Ok(MovedNote {
        from: from.to_string_lossy().into_owned(),
        to: to.to_string_lossy().into_owned(),
    })
}

/// A toggled Markdown checkbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToggledTask {
    pub path: String,
    /// 1-based line number.
    pub line: usize,
    /// New state.
    pub checked: bool,
    /// Task text after the checkbox.
    pub text: String,
}

/// Parse a Markdown task line: returns (byte offset of the state char,
/// checked, text after the checkbox).
fn parse_task_line(line: &str) -> Option<(usize, bool, String)> {
    let indent = line.len() - line.trim_start().len();
    let rest = &line[indent..];
    let marker_len = if rest.starts_with("- ") || rest.starts_with("* ") || rest.starts_with("+ ") {
        2
    } else {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        let after = &rest[digits..];
        if digits > 0 && (after.starts_with(". ") || after.starts_with(") ")) {
            digits + 2
        } else {
            return None;
        }
    };
    let after_marker = &rest[marker_len..];
    let spaces = after_marker.len() - after_marker.trim_start().len();
    let checkbox = &after_marker[spaces..];
    let bytes = checkbox.as_bytes();
    if bytes.len() < 3 || bytes[0] != b'[' || bytes[2] != b']' {
        return None;
    }
    let checked = match bytes[1] {
        b' ' => false,
        b'x' | b'X' => true,
        _ => return None,
    };
    let offset = indent + marker_len + spaces + 1;
    Some((offset, checked, checkbox[3..].trim().to_owned()))
}

/// The text of a task line, if `line` (1-based) is one.
pub fn task_line_text(content: &str, line: usize) -> Option<(bool, String)> {
    let raw = content.split_inclusive('\n').nth(line.checked_sub(1)?)?;
    let text = raw.trim_end_matches(['\n', '\r']);
    parse_task_line(text).map(|(_, checked, text)| (checked, text))
}

/// Flip the checkbox on `line` (1-based). Only that one character changes.
pub fn toggle_task_line(content: &str, line: usize) -> Result<(String, bool, String), AetherError> {
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let index = line
        .checked_sub(1)
        .filter(|i| *i < lines.len())
        .ok_or_else(|| {
            AetherError::InvalidInput(format!(
                "line {line} does not exist (the note has {} lines)",
                lines.len()
            ))
        })?;
    let raw = lines[index];
    let body = raw.trim_end_matches(['\n', '\r']);
    let (offset, checked, text) = parse_task_line(body).ok_or_else(|| {
        AetherError::InvalidInput(format!(
            "line {line} is not a Markdown task: {}",
            clip(body.trim(), 80)
        ))
    })?;
    let mut updated = String::with_capacity(raw.len());
    updated.push_str(&raw[..offset]);
    updated.push(if checked { ' ' } else { 'x' });
    updated.push_str(&raw[offset + 1..]);
    let mut out = String::with_capacity(content.len());
    for (i, l) in lines.iter().enumerate() {
        if i == index {
            out.push_str(&updated);
        } else {
            out.push_str(l);
        }
    }
    Ok((out, !checked, text))
}

// ── Git ───────────────────────────────────────────────────────────────

/// Result of an agent commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCommitOutcome {
    pub commit_id: String,
    pub branch: String,
    pub files: Vec<String>,
    /// True when nothing was staged and every change was staged first.
    pub staged_all: bool,
}

/// Files a commit would include: the staged ones, or every changed file
/// when nothing is staged. Errors on a clean tree.
pub fn commit_candidates(repo: &GitRepo) -> Result<(Vec<String>, bool, String), AetherError> {
    let status = repo.status()?;
    if status.entries.is_empty() {
        return Err(AetherError::InvalidInput(
            "nothing to commit: the working tree is clean".to_owned(),
        ));
    }
    let staged: Vec<String> = status
        .entries
        .iter()
        .filter(|e| e.staged.is_some())
        .map(|e| e.path.clone())
        .collect();
    if staged.is_empty() {
        let all = status.entries.iter().map(|e| e.path.clone()).collect();
        Ok((all, true, status.branch))
    } else {
        Ok((staged, false, status.branch))
    }
}

/// Commit the staged changes; when nothing is staged, stage everything
/// first (like `git add -A && git commit`).
pub fn git_commit_all(repo: &GitRepo, message: &str) -> Result<GitCommitOutcome, AetherError> {
    if message.trim().is_empty() {
        return Err(AetherError::InvalidInput(
            "commit message must not be empty".to_owned(),
        ));
    }
    let (files, staged_all, branch) = commit_candidates(repo)?;
    if staged_all {
        repo.stage(&files)?;
    }
    let commit_id = repo.commit(message)?;
    Ok(GitCommitOutcome {
        commit_id,
        branch,
        files,
        staged_all,
    })
}

// ── Tasks ─────────────────────────────────────────────────────────────

/// Which task project an agent task goes to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectChoice {
    Existing(String),
    /// No project given and no "Inbox" exists yet: create it.
    CreateInbox,
}

/// Resolve `requested` (a project id or name, case-insensitive) or fall
/// back to the "Inbox" project.
pub fn choose_task_project(
    projects: &[TaskProject],
    requested: Option<&str>,
) -> Result<ProjectChoice, AetherError> {
    match requested.map(str::trim).filter(|r| !r.is_empty()) {
        Some(wanted) => projects
            .iter()
            .find(|p| p.id == wanted)
            .or_else(|| {
                projects
                    .iter()
                    .find(|p| p.name.eq_ignore_ascii_case(wanted))
            })
            .or_else(|| {
                projects
                    .iter()
                    .find(|p| p.name.to_lowercase() == wanted.to_lowercase())
            })
            .map(|p| ProjectChoice::Existing(p.id.clone()))
            .ok_or_else(|| {
                let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
                AetherError::InvalidInput(format!(
                    "no task project \"{wanted}\"{}",
                    if names.is_empty() {
                        String::new()
                    } else {
                        format!(" — available: {}", names.join(", "))
                    }
                ))
            }),
        None => Ok(projects
            .iter()
            .find(|p| p.name.eq_ignore_ascii_case(INBOX_PROJECT))
            .map(|p| ProjectChoice::Existing(p.id.clone()))
            .unwrap_or(ProjectChoice::CreateInbox)),
    }
}

/// Validate a priority (default `none`).
pub fn normalize_priority(priority: Option<&str>) -> Result<String, AetherError> {
    let p = priority
        .map(|p| p.trim().to_lowercase())
        .unwrap_or_default();
    if p.is_empty() {
        return Ok("none".to_owned());
    }
    let p = if p == "normal" {
        "medium".to_owned()
    } else {
        p
    };
    if PRIORITIES.contains(&p.as_str()) {
        Ok(p)
    } else {
        Err(AetherError::InvalidInput(format!(
            "invalid priority \"{p}\" (use {})",
            PRIORITIES.join(", ")
        )))
    }
}

/// Validate a due date: `YYYY-MM-DD`, or an RFC 3339 timestamp reduced to
/// its date.
pub fn normalize_due_date(due: Option<&str>) -> Result<Option<String>, AetherError> {
    let Some(raw) = due.map(str::trim).filter(|d| !d.is_empty()) else {
        return Ok(None);
    };
    if let Ok(date) = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return Ok(Some(date.format("%Y-%m-%d").to_string()));
    }
    if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Ok(Some(ts.date_naive().format("%Y-%m-%d").to_string()));
    }
    Err(AetherError::InvalidInput(format!(
        "invalid due date \"{raw}\" (use YYYY-MM-DD)"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("vault");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        (dir, root)
    }

    fn note(root: &Path, rel: &str, content: &str) -> PathBuf {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, content).expect("write");
        path
    }

    fn scan(root: &Path) -> Vec<VaultNote> {
        walkdir::WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
            .map(|e| VaultNote {
                path: e.path().to_string_lossy().into_owned(),
                name: e
                    .path()
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                mtime: 0,
            })
            .collect()
    }

    fn at() -> chrono::DateTime<chrono::Local> {
        chrono::Local
            .with_ymd_and_hms(2026, 9, 22, 14, 5, 9)
            .single()
            .expect("valid time")
    }

    #[test]
    fn audit_log_appends_lists_newest_first_and_clears() {
        let dir = tempfile::tempdir().expect("dir");
        let log = AuditLog::new(dir.path().join("intel/audit.jsonl"));
        assert!(log.list(10).expect("empty").is_empty());
        let run = AgentAction::RunCommand {
            command: "ls".into(),
            cwd: None,
        };
        let first = log
            .record(
                &run,
                AuditStatus::Ok,
                Some("exit 0"),
                Some(Duration::from_millis(12)),
            )
            .expect("record");
        assert_eq!(first.action, "run_command");
        assert_eq!(first.risk, ActionRisk::Dangerous);
        assert_eq!(first.summary, "Run `ls` in the vault");
        assert_eq!(first.duration_ms, Some(12));
        let second = log
            .record(
                &AgentAction::AppendDaily {
                    content: "x".into(),
                },
                AuditStatus::Denied,
                Some("   "),
                None,
            )
            .expect("record");
        assert_eq!(second.detail, None);

        // A corrupt line never breaks the listing.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(dir.path().join("intel/audit.jsonl"))
            .expect("open");
        writeln!(file, "not json").expect("write");

        let entries = log.list(10).expect("list");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, second.id);
        assert_eq!(entries[1].id, first.id);
        assert_eq!(log.list(1).expect("list").len(), 1);

        log.clear().expect("clear");
        assert!(log.list(10).expect("list").is_empty());
        log.clear().expect("clearing twice is fine");
    }

    #[test]
    fn audit_log_trims_itself_when_it_grows_too_large() {
        let dir = tempfile::tempdir().expect("dir");
        let log = AuditLog::new(dir.path().join("audit.jsonl"));
        let action = AgentAction::AppendDaily {
            content: "x".into(),
        };
        let detail = "d".repeat(MAX_DETAIL_CHARS);
        let per_entry = 900u64;
        let count = (MAX_AUDIT_BYTES / per_entry) as usize + 50;
        for _ in 0..count {
            log.record(&action, AuditStatus::Ok, Some(&detail), None)
                .expect("record");
        }
        let size = std::fs::metadata(dir.path().join("audit.jsonl"))
            .expect("meta")
            .len();
        assert!(size <= MAX_AUDIT_BYTES, "size {size}");
        assert!(!log.list(5).expect("list").is_empty());
    }

    #[test]
    fn details_are_clipped() {
        let dir = tempfile::tempdir().expect("dir");
        let log = AuditLog::new(dir.path().join("audit.jsonl"));
        let entry = log
            .record(
                &AgentAction::AppendDaily {
                    content: "x".into(),
                },
                AuditStatus::Error,
                Some(&"e".repeat(2_000)),
                None,
            )
            .expect("record");
        assert_eq!(
            entry.detail.expect("detail").chars().count(),
            MAX_DETAIL_CHARS
        );
    }

    #[test]
    fn resolves_notes_by_absolute_relative_and_bare_name() {
        let (_dir, root) = vault();
        let ideas = note(&root, "projects/Ideas.md", "# Ideas");
        note(&root, "a/Dup.md", "1");
        note(&root, "b/Dup.md", "2");
        let notes = scan(&root);
        assert_eq!(
            resolve_existing_note(&root, ideas.to_str().unwrap(), &notes).expect("abs"),
            ideas
        );
        assert_eq!(
            resolve_existing_note(&root, "projects/Ideas", &notes).expect("rel"),
            ideas
        );
        assert_eq!(
            resolve_existing_note(&root, "ideas.md", &notes).expect("name"),
            ideas
        );
        let dup = resolve_existing_note(&root, "Dup", &notes).expect_err("ambiguous");
        assert!(dup.to_string().contains("matches 2 notes"));
        assert!(resolve_existing_note(&root, "Missing", &notes).is_err());
        assert!(resolve_existing_note(&root, " ", &notes).is_err());
    }

    #[test]
    fn rejects_notes_outside_the_vault_hidden_or_not_markdown() {
        let (_dir, root) = vault();
        let (_other, other_root) = vault();
        let outside_note = note(&other_root, "Secret.md", "x");
        note(&root, ".trash/Old.md", "x");
        note(&root, "image.png", "x");
        let notes = scan(&root);
        assert!(resolve_existing_note(&root, outside_note.to_str().unwrap(), &notes).is_err());
        assert!(resolve_existing_note(&root, "../Secret.md", &notes).is_err());
        assert!(resolve_existing_note(&root, ".trash/Old.md", &notes).is_err());
        assert!(resolve_existing_note(&root, "image.png", &notes).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_vault() {
        let (_dir, root) = vault();
        let (_other, other_root) = vault();
        let target = note(&other_root, "Target.md", "x");
        std::os::unix::fs::symlink(&target, root.join("Link.md")).expect("symlink");
        assert!(resolve_existing_note(&root, "Link.md", &[]).is_err());
    }

    #[test]
    fn trashes_notes_with_a_timestamp_and_never_overwrites() {
        let (_dir, root) = vault();
        let first = note(&root, "inbox/Old idea.md", "one");
        let trashed = trash_note(&root, &first, at()).expect("trash");
        assert!(!first.exists());
        assert_eq!(
            PathBuf::from(&trashed.trash_path),
            root.join(".trash/20260922-140509-Old idea.md")
        );
        assert_eq!(
            std::fs::read_to_string(&trashed.trash_path).expect("read"),
            "one"
        );

        let second = note(&root, "inbox/Old idea.md", "two");
        let again = trash_note(&root, &second, at()).expect("trash");
        assert_eq!(
            PathBuf::from(&again.trash_path),
            root.join(".trash/20260922-140509-2-Old idea.md")
        );
        // The trashed files are hidden from note resolution.
        assert!(resolve_existing_note(&root, ".trash/20260922-140509-Old idea.md", &[]).is_err());
    }

    #[test]
    fn move_targets_resolve_inside_the_vault() {
        let (_dir, root) = vault();
        let from = note(&root, "inbox/Idea.md", "x");
        std::fs::create_dir_all(root.join("archive")).expect("mkdir");
        assert_eq!(
            resolve_move_target(&root, &from, "archive").expect("dir"),
            root.join("archive/Idea.md")
        );
        assert_eq!(
            resolve_move_target(&root, &from, "new/").expect("slash"),
            root.join("new/Idea.md")
        );
        assert_eq!(
            resolve_move_target(&root, &from, "projects/Plan").expect("md"),
            root.join("projects/Plan.md")
        );
        assert_eq!(
            resolve_move_target(&root, &from, root.join("Top.md").to_str().unwrap()).expect("abs"),
            root.join("Top.md")
        );
        assert!(resolve_move_target(&root, &from, "../escape.md").is_err());
        assert!(resolve_move_target(&root, &from, "/tmp/elsewhere.md").is_err());
        assert!(resolve_move_target(&root, &from, ".hidden/x.md").is_err());
        assert!(resolve_move_target(&root, &from, "file.txt").is_err());
        assert_eq!(
            resolve_move_target(&root, &from, "Meeting v1.2").expect("dotted name"),
            root.join("Meeting v1.2.md")
        );
        assert!(
            resolve_move_target(&root, &from, "inbox/Idea.md").is_err(),
            "exists"
        );
        assert!(resolve_move_target(&root, &from, " ").is_err());
    }

    #[test]
    fn moves_notes_and_creates_folders() {
        let (_dir, root) = vault();
        let from = note(&root, "Idea.md", "content");
        let to = resolve_move_target(&root, &from, "deep/nested/Idea v2").expect("target");
        let moved = move_note(&root, &from, &to).expect("move");
        assert!(!from.exists());
        assert_eq!(std::fs::read_to_string(&to).expect("read"), "content");
        assert_eq!(moved.to, to.to_string_lossy());
    }

    #[test]
    fn toggles_exactly_one_checkbox() {
        let content =
            "# Todo\n- [ ] buy milk\n  * [x] nested done\n1. [ ] numbered\r\n- not a task\n";
        let (out, checked, text) = toggle_task_line(content, 2).expect("toggle");
        assert!(checked);
        assert_eq!(text, "buy milk");
        assert_eq!(
            out,
            "# Todo\n- [x] buy milk\n  * [x] nested done\n1. [ ] numbered\r\n- not a task\n"
        );
        let (out, checked, _) = toggle_task_line(&out, 3).expect("toggle");
        assert!(!checked);
        assert!(out.contains("  * [ ] nested done\n"));
        let (out, checked, _) = toggle_task_line(&out, 4).expect("toggle");
        assert!(checked);
        assert!(out.contains("1. [x] numbered\r\n"));
        assert!(toggle_task_line(content, 5).is_err());
        assert!(toggle_task_line(content, 1).is_err());
        assert!(toggle_task_line(content, 0).is_err());
        assert!(toggle_task_line(content, 99).is_err());
        assert_eq!(
            task_line_text(content, 3),
            Some((true, "nested done".to_owned()))
        );
        assert_eq!(task_line_text(content, 1), None);
    }

    #[test]
    fn commits_all_changes_when_nothing_is_staged() {
        let dir = tempfile::tempdir().expect("repo");
        git2::Repository::init(dir.path()).expect("init");
        std::fs::write(dir.path().join("a.txt"), "a").expect("write");
        std::fs::write(dir.path().join("b.txt"), "b").expect("write");
        let repo = GitRepo::open(dir.path()).expect("open");
        let outcome = git_commit_all(&repo, "feat: initial").expect("commit");
        assert!(outcome.staged_all);
        assert_eq!(outcome.files, vec!["a.txt", "b.txt"]);
        assert_eq!(outcome.commit_id.len(), 40);
        assert_eq!(repo.log(5).expect("log")[0].summary, "feat: initial");

        // Clean tree: no empty commits.
        assert!(git_commit_all(&repo, "again").is_err());
        assert!(git_commit_all(&repo, "  ").is_err());

        // Staged changes are committed alone.
        std::fs::write(dir.path().join("a.txt"), "a2").expect("write");
        std::fs::write(dir.path().join("c.txt"), "c").expect("write");
        repo.stage(&["a.txt".to_owned()]).expect("stage");
        let partial = git_commit_all(&repo, "fix: a").expect("commit");
        assert!(!partial.staged_all);
        assert_eq!(partial.files, vec!["a.txt"]);
        let remaining = repo.status().expect("status");
        assert_eq!(remaining.entries.len(), 1);
        assert_eq!(remaining.entries[0].path, "c.txt");
    }

    fn project(id: &str, name: &str) -> TaskProject {
        TaskProject {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            color: "#000000".into(),
            icon: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn chooses_task_projects_by_id_name_or_inbox() {
        let projects = vec![project("p1", "AETHER"), project("p2", "inbox")];
        assert_eq!(
            choose_task_project(&projects, Some("p1")).expect("id"),
            ProjectChoice::Existing("p1".into())
        );
        assert_eq!(
            choose_task_project(&projects, Some("aether")).expect("name"),
            ProjectChoice::Existing("p1".into())
        );
        assert_eq!(
            choose_task_project(&projects, None).expect("inbox"),
            ProjectChoice::Existing("p2".into())
        );
        assert_eq!(
            choose_task_project(&projects[..1], Some(" ")).expect("blank"),
            ProjectChoice::CreateInbox
        );
        let err = choose_task_project(&projects, Some("Nope")).expect_err("missing");
        assert!(err.to_string().contains("available: AETHER, inbox"));
    }

    #[test]
    fn validates_priorities_and_due_dates() {
        assert_eq!(normalize_priority(None).expect("default"), "none");
        assert_eq!(normalize_priority(Some("HIGH")).expect("upper"), "high");
        assert_eq!(normalize_priority(Some("normal")).expect("alias"), "medium");
        assert!(normalize_priority(Some("asap")).is_err());
        assert_eq!(normalize_due_date(None).expect("none"), None);
        assert_eq!(
            normalize_due_date(Some("2026-10-01")).expect("date"),
            Some("2026-10-01".to_owned())
        );
        assert_eq!(
            normalize_due_date(Some("2026-10-01T09:00:00+02:00")).expect("rfc3339"),
            Some("2026-10-01".to_owned())
        );
        assert!(normalize_due_date(Some("next friday")).is_err());
    }
}
