//! Indexers: turn vault notes, projects, project files, memory facts,
//! conversations, calendar events, tasks and applications into
//! [`IndexDoc`]s.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::apps::AppEntry;
use super::store::IndexDoc;
use super::text::{extract_tags, fnv1a64, markdown_to_plain, strip_sentinels, truncate_chars};
use super::SearchKind;
use crate::engine::calendar::CalendarEvent;
use crate::engine::memory_store::{Conversation, MemoryFact};
use crate::engine::task_board::{TaskItem, TaskProject};

/// Largest body stored per document (characters).
pub const MAX_BODY_CHARS: usize = 200_000;
/// Deepest directory level walked inside a file index root.
pub const MAX_FILE_DEPTH: usize = 8;
/// Upper bound of indexed project files across all roots.
pub const MAX_FILES: usize = 50_000;
/// Directories never descended into, even without a `.gitignore`.
pub const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
];

/// File names that hold credentials and are never indexed, even when they
/// are not hidden or git-ignored: `.env*`, private keys and certificates
/// (`*.pem`, `*.key`, `*.p12`, `*.pfx`, keystores), SSH keys (`id_rsa*`,
/// `id_dsa*`, `id_ecdsa*`, `id_ed25519*`) and credential dot-files.
pub fn is_sensitive_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    const EXACT: &[&str] = &[
        ".netrc",
        ".npmrc",
        ".pypirc",
        ".pgpass",
        ".git-credentials",
        "credentials",
        "credentials.json",
    ];
    const PREFIXES: &[&str] = &[".env", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
    const EXTENSIONS: &[&str] = &[
        "pem", "key", "p12", "pfx", "keystore", "jks", "ppk", "asc", "gpg", "kdbx",
    ];
    EXACT.contains(&lower.as_str())
        || PREFIXES.iter().any(|p| lower.starts_with(p))
        || lower
            .rsplit_once('.')
            .is_some_and(|(stem, ext)| !stem.is_empty() && EXTENSIONS.contains(&ext))
}

fn clamp_body(text: &str) -> String {
    let stripped = strip_sentinels(text);
    if stripped.chars().count() > MAX_BODY_CHARS {
        truncate_chars(&stripped, MAX_BODY_CHARS)
    } else {
        stripped
    }
}

fn clean(text: &str) -> String {
    strip_sentinels(text.trim())
}

/// Folder of `path` relative to `root` (`""` at the top level).
fn relative_folder(path: &Path, root: &Path) -> String {
    path.parent()
        .and_then(|p| p.strip_prefix(root).ok())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// A vault note. `mtime` is in Unix seconds, `sig` identifies the file
/// version (modification time in ms + size) for incremental indexing.
pub fn note_doc(
    path: &str,
    name: &str,
    mtime: i64,
    sig: String,
    content: &str,
    vault_root: &str,
) -> IndexDoc {
    let folder = relative_folder(Path::new(path), Path::new(vault_root));
    IndexDoc {
        id: format!("note:{path}"),
        kind: SearchKind::Note,
        title: clean(name),
        subtitle: if folder.is_empty() {
            "Vault".to_owned()
        } else {
            folder.clone()
        },
        path: path.to_owned(),
        body: clamp_body(&markdown_to_plain(content)),
        tags: extract_tags(content),
        updated_at: mtime,
        extra: json!({ "folder": folder }),
        sig,
    }
}

/// A code project found below a configured project directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectInfo {
    pub name: String,
    pub path: PathBuf,
    pub branch: Option<String>,
    pub language: String,
}

fn is_project_dir(path: &Path) -> bool {
    path.join(".git").exists()
        || path.join("package.json").exists()
        || path.join("Cargo.toml").exists()
}

fn detect_language(path: &Path) -> &'static str {
    if path.join("Cargo.toml").exists() {
        "rust"
    } else if path.join("package.json").exists() {
        if path.join("tsconfig.json").exists() {
            "typescript"
        } else {
            "javascript"
        }
    } else if path.join("pyproject.toml").exists() || path.join("requirements.txt").exists() {
        "python"
    } else if path.join("go.mod").exists() {
        "go"
    } else {
        "unknown"
    }
}

/// Current branch read from `.git/HEAD` (no git process). `None` for
/// detached heads, non-repositories and worktrees without a readable HEAD.
pub fn read_git_branch(project: &Path) -> Option<String> {
    let head = std::fs::read_to_string(project.join(".git").join("HEAD")).ok()?;
    head.trim()
        .strip_prefix("ref: refs/heads/")
        .map(|b| b.to_owned())
        .filter(|b| !b.is_empty())
}

fn scan_projects(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 3 {
        return;
    }
    if is_project_dir(dir) {
        out.push(dir.to_path_buf());
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    children.sort();
    for child in children {
        let name = child
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        scan_projects(&child, depth + 1, out);
    }
}

/// Projects below `dirs` with the same rules as the Projects view (a
/// `.git`, `package.json` or `Cargo.toml` marks a project; up to three
/// levels deep; nested projects are not reported separately).
pub fn discover_projects(dirs: &[PathBuf]) -> Vec<ProjectInfo> {
    let mut paths = Vec::new();
    for dir in dirs {
        scan_projects(dir, 0, &mut paths);
    }
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .map(|path| ProjectInfo {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            branch: read_git_branch(&path),
            language: detect_language(&path).to_owned(),
            path,
        })
        .collect()
}

/// Index document of a project.
pub fn project_doc(project: &ProjectInfo) -> IndexDoc {
    let path = project.path.to_string_lossy().to_string();
    let subtitle = match &project.branch {
        Some(branch) => format!("{} · {}", project.language, branch),
        None => project.language.clone(),
    };
    IndexDoc {
        id: format!("project:{path}"),
        kind: SearchKind::Project,
        title: clean(&project.name),
        subtitle,
        body: format!(
            "{} {} {}",
            project.name,
            project.language,
            project.branch.clone().unwrap_or_default()
        ),
        path,
        tags: vec![project.language.clone()],
        updated_at: 0,
        extra: json!({ "branch": project.branch, "language": project.language }),
        sig: String::new(),
    }
}

/// Outcome of walking the file index roots.
#[derive(Debug, Default)]
pub struct FileWalk {
    pub docs: Vec<IndexDoc>,
    /// The [`MAX_FILES`] cap was hit.
    pub truncated: bool,
}

/// Walk `roots` for project files: `.gitignore` / `.ignore` rules are
/// honoured (even outside a git repository), hidden entries,
/// [`SKIP_DIRS`] and credential files ([`is_sensitive_file_name`]) are
/// skipped, depth ≤ [`MAX_FILE_DEPTH`], at most `max` files in total. Only
/// paths and names are indexed, never contents.
pub fn walk_files(roots: &[PathBuf], max: usize) -> FileWalk {
    let mut walk = FileWalk::default();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    'roots: for root in roots {
        if !root.is_dir() {
            continue;
        }
        let root_name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let walker = ignore::WalkBuilder::new(root)
            .hidden(true)
            .git_ignore(true)
            .git_exclude(true)
            .git_global(false)
            .ignore(true)
            .parents(false)
            .require_git(false)
            .follow_links(false)
            .max_depth(Some(MAX_FILE_DEPTH))
            .filter_entry(|entry| {
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                !(is_dir && SKIP_DIRS.contains(&entry.file_name().to_string_lossy().as_ref()))
            })
            .build();
        for entry in walker.filter_map(Result::ok) {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            if is_sensitive_file_name(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let path = entry.path().to_path_buf();
            if !seen.insert(path.clone()) {
                continue;
            }
            if walk.docs.len() >= max {
                walk.truncated = true;
                break 'roots;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let folder = relative_folder(&path, root);
            let subtitle = if folder.is_empty() {
                root_name.clone()
            } else {
                format!("{root_name}/{folder}")
            };
            let abs = path.to_string_lossy().to_string();
            walk.docs.push(IndexDoc {
                id: format!("file:{abs}"),
                kind: SearchKind::File,
                title: clean(&name),
                subtitle,
                body: clean(&format!("{root_name}/{rel}")),
                path: abs,
                tags: Vec::new(),
                updated_at: 0,
                extra: json!({ "root": root.to_string_lossy(), "rel": rel }),
                sig: String::new(),
            });
        }
    }
    walk
}

/// Stable id of a memory fact (facts are identified by their text).
pub fn memory_fact_id(fact: &str) -> String {
    format!("memory:{:016x}", fnv1a64(fact))
}

/// Index document of a memory fact.
pub fn memory_doc(fact: &MemoryFact) -> IndexDoc {
    IndexDoc {
        id: memory_fact_id(&fact.fact),
        kind: SearchKind::Memory,
        title: truncate_chars(&clean(&fact.fact), 160),
        subtitle: format!("Memory · {}", fact.category),
        path: String::new(),
        body: clamp_body(&fact.fact),
        tags: vec![fact.category.to_lowercase()],
        updated_at: fact.created_at,
        extra: json!({ "category": fact.category, "fact": fact.fact }),
        sig: String::new(),
    }
}

/// Index document of a saved AI conversation.
pub fn conversation_doc(conv: &Conversation) -> IndexDoc {
    let first_user = conv
        .messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.content.as_str())
        .unwrap_or("");
    let title_source = if conv.summary.trim().is_empty() {
        first_user
    } else {
        conv.summary.as_str()
    };
    let title = truncate_chars(&clean(title_source), 120);
    let body: String = conv
        .messages
        .iter()
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let date = chrono::DateTime::from_timestamp(conv.timestamp, 0)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default();
    IndexDoc {
        id: format!("conversation:{}", conv.id),
        kind: SearchKind::Conversation,
        title: if title.is_empty() {
            "Conversation".to_owned()
        } else {
            title
        },
        subtitle: format!(
            "AI conversation · {date} · {} messages",
            conv.messages.len()
        ),
        path: String::new(),
        body: clamp_body(&markdown_to_plain(&body)),
        tags: Vec::new(),
        updated_at: conv.timestamp,
        extra: json!({ "conversation_id": conv.id, "context_notes": conv.context_notes }),
        sig: String::new(),
    }
}

/// `YYYY-MM-DD` of an event start (all-day dates or RFC 3339 timestamps).
pub fn event_date(start: &str) -> String {
    start.chars().take(10).collect()
}

fn event_time_label(event: &CalendarEvent) -> String {
    if event.all_day {
        return format!("{} · all day", event_date(&event.start));
    }
    match chrono::DateTime::parse_from_rfc3339(&event.start) {
        Ok(dt) => dt.format("%Y-%m-%d %H:%M").to_string(),
        Err(_) => event_date(&event.start),
    }
}

/// Index document of a calendar event.
pub fn event_doc(event: &CalendarEvent) -> IndexDoc {
    let mut subtitle = event_time_label(event);
    if let Some(location) = event.location.as_deref().filter(|l| !l.trim().is_empty()) {
        subtitle.push_str(" · ");
        subtitle.push_str(location.trim());
    }
    let body = [
        event.description.as_str(),
        event.location.as_deref().unwrap_or(""),
        &event.attendees.join(", "),
    ]
    .join("\n");
    let updated = chrono::DateTime::parse_from_rfc3339(&event.updated_at)
        .map(|d| d.timestamp())
        .unwrap_or(0);
    IndexDoc {
        id: format!("event:{}", event.id),
        kind: SearchKind::Event,
        title: clean(&event.title),
        subtitle,
        path: String::new(),
        body: clamp_body(&markdown_to_plain(&body)),
        tags: event.tags.iter().map(|t| t.to_lowercase()).collect(),
        updated_at: updated,
        extra: json!({
            "event_id": event.id,
            "date": event_date(&event.start),
            "start": event.start,
            "all_day": event.all_day,
            "color": event.color,
        }),
        sig: String::new(),
    }
}

/// Index document of a task-board item.
pub fn task_doc(task: &TaskItem, projects: &[TaskProject]) -> IndexDoc {
    let project_name = projects
        .iter()
        .find(|p| p.id == task.project_id)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "Tasks".to_owned());
    let updated = chrono::DateTime::parse_from_rfc3339(&task.updated_at)
        .map(|d| d.timestamp())
        .unwrap_or(0);
    let mut subtitle = format!(
        "{project_name} · {} · {}",
        task.status.replace('_', " "),
        task.priority
    );
    if let Some(due) = task.due_date.as_deref().filter(|d| !d.is_empty()) {
        subtitle.push_str(&format!(" · due {due}"));
    }
    IndexDoc {
        id: format!("task:{}", task.id),
        kind: SearchKind::Task,
        title: clean(&task.title),
        subtitle,
        path: String::new(),
        body: clamp_body(&format!(
            "{}\n{}",
            markdown_to_plain(&task.description),
            task.labels.join(" ")
        )),
        tags: task.labels.iter().map(|l| l.to_lowercase()).collect(),
        updated_at: updated,
        extra: json!({
            "task_id": task.id,
            "project_id": task.project_id,
            "project_name": project_name,
            "status": task.status,
            "priority": task.priority,
            "due_date": task.due_date,
        }),
        sig: String::new(),
    }
}

/// Index document of an installed application.
pub fn app_doc(app: &AppEntry) -> IndexDoc {
    let stem = Path::new(&app.path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    IndexDoc {
        id: format!("app:{}", app.path),
        kind: SearchKind::App,
        title: clean(&app.name),
        subtitle: "Application".to_owned(),
        path: app.path.clone(),
        body: format!("{stem} {}", app.bundle_id.clone().unwrap_or_default()),
        tags: Vec::new(),
        updated_at: 0,
        extra: json!({ "bundle_id": app.bundle_id }),
        sig: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::memory_store::ChatMessageRecord;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent dirs");
        }
        std::fs::write(path, "x").expect("file");
    }

    #[test]
    fn walk_respects_gitignore_hidden_and_skip_dirs() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("app");
        std::fs::create_dir_all(&root).expect("root");
        std::fs::write(root.join(".gitignore"), "secret.txt\nlogs/\n*.tmp\n").expect("gitignore");
        for rel in [
            "src/main.rs",
            "README.md",
            "secret.txt",
            "logs/today.log",
            "cache.tmp",
            "node_modules/pkg/index.js",
            "target/debug/app",
            ".env",
            ".hidden/inner.rs",
            "a/b/c/d/e/f/g/h/i/too_deep.rs",
        ] {
            touch(&root.join(rel));
        }
        let walk = walk_files(std::slice::from_ref(&root), MAX_FILES);
        let mut names: Vec<&str> = walk.docs.iter().map(|d| d.title.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["README.md", "main.rs"]);
        assert!(!walk.truncated);
        let main = walk
            .docs
            .iter()
            .find(|d| d.title == "main.rs")
            .expect("main.rs");
        assert_eq!(main.subtitle, "app/src");
        assert_eq!(main.body, "app/src/main.rs");
        assert_eq!(main.extra["rel"], "src/main.rs");
    }

    #[test]
    fn credential_files_are_never_indexed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("app");
        for rel in [
            "src/lib.rs",
            "keys/server.pem",
            "keys/server.KEY",
            "keys/id_rsa",
            "keys/id_ed25519.pub",
            "deploy/cert.p12",
            "config/credentials.json",
            "notes/keyboard.md",
            "notes/monkey.txt",
        ] {
            touch(&root.join(rel));
        }
        let walk = walk_files(std::slice::from_ref(&root), MAX_FILES);
        let mut names: Vec<&str> = walk.docs.iter().map(|d| d.title.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["keyboard.md", "lib.rs", "monkey.txt"]);

        for secret in [
            ".env",
            ".env.local",
            "id_rsa",
            "ID_DSA.pub",
            "a.pem",
            "vault.kdbx",
        ] {
            assert!(is_sensitive_file_name(secret), "{secret}");
        }
        for plain in [
            "environment.md",
            "key.md",
            "keys.rs",
            ".pem",
            "pem",
            "Keynote.key.md",
        ] {
            assert!(!is_sensitive_file_name(plain), "{plain}");
        }
    }

    #[test]
    fn walk_stops_at_the_cap() {
        let dir = tempfile::tempdir().expect("temp dir");
        for i in 0..5 {
            touch(&dir.path().join(format!("f{i}.txt")));
        }
        let walk = walk_files(&[dir.path().to_path_buf(), dir.path().to_path_buf()], 3);
        assert_eq!(walk.docs.len(), 3);
        assert!(walk.truncated);
        let all = walk_files(&[dir.path().to_path_buf(), dir.path().to_path_buf()], 100);
        assert_eq!(all.docs.len(), 5, "overlapping roots are de-duplicated");
    }

    #[test]
    fn projects_are_discovered_with_branch_and_language() {
        let dir = tempfile::tempdir().expect("temp dir");
        let rust = dir.path().join("group/engine");
        touch(&rust.join("Cargo.toml"));
        std::fs::create_dir_all(rust.join(".git")).expect("git dir");
        std::fs::write(rust.join(".git/HEAD"), "ref: refs/heads/feature/search\n").expect("HEAD");
        touch(&rust.join("nested/package.json"));
        let web = dir.path().join("web");
        touch(&web.join("package.json"));
        touch(&web.join("tsconfig.json"));
        touch(&dir.path().join("node_modules/dep/package.json"));

        let projects = discover_projects(&[dir.path().to_path_buf()]);
        assert_eq!(projects.len(), 2);
        let engine = projects
            .iter()
            .find(|p| p.name == "engine")
            .expect("engine");
        assert_eq!(engine.branch.as_deref(), Some("feature/search"));
        assert_eq!(engine.language, "rust");
        let web_project = projects.iter().find(|p| p.name == "web").expect("web");
        assert_eq!(web_project.language, "typescript");
        assert_eq!(web_project.branch, None);
        let doc = project_doc(engine);
        assert_eq!(doc.subtitle, "rust · feature/search");
        assert!(doc.id.starts_with("project:"));
    }

    #[test]
    fn detached_heads_have_no_branch() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir_all(dir.path().join(".git")).expect("git");
        std::fs::write(dir.path().join(".git/HEAD"), "4f2a9c0\n").expect("HEAD");
        assert_eq!(read_git_branch(dir.path()), None);
    }

    #[test]
    fn notes_become_plain_text_with_tags_and_folder() {
        let doc = note_doc(
            "/v/Projects/Garden.md",
            "Garden",
            42,
            "1:2".into(),
            "---\ntags: [home]\n---\n# Garden\nPlant #tomatoes near [[Greenhouse]].",
            "/v",
        );
        assert_eq!(doc.id, "note:/v/Projects/Garden.md");
        assert_eq!(doc.subtitle, "Projects");
        assert_eq!(doc.body, "Garden\nPlant #tomatoes near Greenhouse.");
        assert_eq!(doc.tags, vec!["home", "tomatoes"]);
        let root = note_doc("/v/Inbox.md", "Inbox", 0, String::new(), "", "/v");
        assert_eq!(root.subtitle, "Vault");
    }

    #[test]
    fn memory_ids_are_stable_and_distinct() {
        assert_eq!(memory_fact_id("likes tea"), memory_fact_id("likes tea"));
        assert_ne!(memory_fact_id("likes tea"), memory_fact_id("likes coffee"));
        let fact = MemoryFact {
            fact: "Anna is my sister".into(),
            category: "people".into(),
            created_at: 5,
        };
        let doc = memory_doc(&fact);
        assert_eq!(doc.subtitle, "Memory · people");
        assert_eq!(doc.tags, vec!["people"]);
    }

    #[test]
    fn conversations_use_summary_or_first_user_message() {
        let conv = Conversation {
            id: "c1".into(),
            timestamp: 1_700_000_000,
            messages: vec![
                ChatMessageRecord {
                    role: "user".into(),
                    content: "How do I index the vault?".into(),
                },
                ChatMessageRecord {
                    role: "assistant".into(),
                    content: "Open the status bar.".into(),
                },
            ],
            context_notes: vec![],
            summary: String::new(),
        };
        let doc = conversation_doc(&conv);
        assert_eq!(doc.title, "How do I index the vault?");
        assert!(doc.subtitle.contains("2023-11-14") && doc.subtitle.contains("2 messages"));
        assert!(doc.body.contains("status bar"));
    }

    #[test]
    fn apps_index_name_stem_and_bundle_id() {
        let doc = app_doc(&AppEntry {
            name: "Code".into(),
            path: "/Applications/Visual Studio Code.app".into(),
            bundle_id: Some("com.microsoft.VSCode".into()),
        });
        assert_eq!(doc.title, "Code");
        assert_eq!(doc.body, "Visual Studio Code com.microsoft.VSCode");
    }

    #[test]
    fn event_dates_are_extracted() {
        assert_eq!(event_date("2026-09-22"), "2026-09-22");
        assert_eq!(event_date("2026-09-22T10:00:00+02:00"), "2026-09-22");
    }
}
