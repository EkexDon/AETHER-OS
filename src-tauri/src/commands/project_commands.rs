use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::commands::ide_commands::workspace;
use crate::engine::fs_guard;
use crate::engine::workspace::Workspace;
use crate::AppState;
use tauri::State;

/// Folder bundles that `open` would launch or install instead of showing.
const BUNDLE_EXTENSIONS: &[&str] = &[
    "app",
    "appex",
    "action",
    "bundle",
    "framework",
    "kext",
    "mdimporter",
    "mpkg",
    "pkg",
    "plugin",
    "prefpane",
    "qlgenerator",
    "saver",
    "service",
    "workflow",
    "xpc",
];

/// Known editor keys: (key, macOS application name, CLI shim).
const KNOWN_EDITORS: &[(&str, &str, &str)] = &[
    ("devin", "Devin", "devin"),
    ("windsurf", "Windsurf", "windsurf"),
    ("cursor", "Cursor", "cursor"),
    ("code", "Visual Studio Code", "code"),
    ("vscode", "Visual Studio Code", "code"),
    ("visual studio code", "Visual Studio Code", "code"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    pub path: String,
    pub git_branch: Option<String>,
    pub git_status: Option<String>,
    pub last_commit_msg: Option<String>,
    pub last_commit_date: Option<i64>,
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDirsConfig {
    pub directories: Vec<String>,
}

fn is_project_dir(path: &Path) -> bool {
    path.join(".git").exists()
        || path.join("package.json").exists()
        || path.join("Cargo.toml").exists()
}

fn detect_language(path: &Path) -> String {
    if path.join("Cargo.toml").exists() {
        return "rust".to_owned();
    }
    if path.join("package.json").exists() {
        if path.join("tsconfig.json").exists() {
            return "typescript".to_owned();
        }
        return "javascript".to_owned();
    }
    if path.join("pyproject.toml").exists() || path.join("requirements.txt").exists() {
        return "python".to_owned();
    }
    if path.join("go.mod").exists() {
        return "go".to_owned();
    }
    "unknown".to_owned()
}

fn run_git(path: &Path, args: &[&str]) -> Option<String> {
    // Read-only queries: no fsmonitor hook from the repository's config, no
    // index refresh lock.
    let output = Command::new("git")
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(path)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn git_info(path: &Path) -> (Option<String>, Option<String>, Option<String>, Option<i64>) {
    let branch = run_git(path, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| !b.is_empty());

    let status = run_git(path, &["status", "--porcelain"]).map(|porcelain| {
        let lines: Vec<&str> = porcelain.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.is_empty() {
            "clean".to_owned()
        } else {
            let modified = lines.iter().filter(|l| !l.starts_with("??")).count();
            let untracked = lines.iter().filter(|l| l.starts_with("??")).count();
            let mut parts = Vec::new();
            if modified > 0 {
                parts.push(format!("{modified} modified"));
            }
            if untracked > 0 {
                parts.push(format!("{untracked} untracked"));
            }
            parts.join(", ")
        }
    });

    let last_commit = run_git(path, &["log", "-1", "--format=%s|%ct"]);
    let (msg, date) = match last_commit {
        Some(line) => {
            let mut split = line.rsplitn(2, '|');
            let ts = split.next().and_then(|s| s.parse::<i64>().ok());
            let m = split.next().map(|s| s.to_owned());
            (m, ts)
        }
        None => (None, None),
    };

    (branch, status, msg, date)
}

fn scan_directory(dir: &Path, depth: u32) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if depth > 3 {
        return found;
    }
    if is_project_dir(dir) {
        found.push(dir.to_path_buf());
        return found;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return found,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
            continue;
        }
        found.extend(scan_directory(&path, depth + 1));
    }
    found
}

/// Folders a project path from the UI may live in: the configured project
/// folders, the vault and the file-search folders (canonical).
fn allowed_roots(state: &State<'_, AppState>) -> Vec<PathBuf> {
    let mut roots = workspace(state).roots().to_vec();
    roots.extend(
        state
            .search
            .settings()
            .file_roots
            .iter()
            .filter_map(|r| std::fs::canonicalize(r).ok()),
    );
    roots
}

/// Resolve an existing path inside `roots` (symlinks resolved).
fn resolve_in_roots(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    Workspace::new(roots)
        .resolve_existing(path)
        .map_err(|e| e.to_string())
}

/// Resolve a folder to reveal: an existing directory inside `roots` that is
/// not an application or installer bundle (which `open` would launch).
fn resolve_folder_in_roots(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    let dir = resolve_in_roots(roots, path)?;
    if !dir.is_dir() {
        return Err(format!("not a folder: {}", dir.display()));
    }
    let is_bundle = dir
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| BUNDLE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    if is_bundle {
        return Err(format!(
            "refusing to open an application or installer bundle: {}",
            dir.display()
        ));
    }
    Ok(dir)
}

/// The editor to launch: a known key (`devin`, `cursor`, …) maps to its app
/// name and CLI shim; anything else must be a plain macOS application name
/// (no path separators, no leading `-` or `.`, no control characters) and is
/// only ever launched through `open -a`.
fn resolve_editor(requested: &str) -> Result<(String, Option<&'static str>), String> {
    let key = requested.trim();
    if let Some((_, app, cli)) = KNOWN_EDITORS
        .iter()
        .find(|(k, _, _)| k.eq_ignore_ascii_case(key))
    {
        return Ok(((*app).to_owned(), Some(*cli)));
    }
    let valid = !key.is_empty()
        && key.chars().count() <= 100
        && !key.starts_with(['-', '.'])
        && !key
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'));
    if !valid {
        return Err(format!("invalid editor application name: {requested:?}"));
    }
    Ok((key.to_owned(), None))
}

/// Validate a project folder before it is added: an absolute path to an
/// existing directory that is not a filesystem root, a system folder or
/// inside the app data folder (`config_dir`). Returns the trimmed path.
fn validate_project_dir(dir: &str, config_dir: &Path) -> Result<String, String> {
    let trimmed = dir.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty() || trimmed.contains('\0') || !path.is_absolute() {
        return Err(format!(
            "project folder must be an absolute path: {trimmed:?}"
        ));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| format!("project folder does not exist: {trimmed}"))?;
    if !canonical.is_dir() {
        return Err(format!("not a folder: {trimmed}"));
    }
    if fs_guard::is_system_location(&canonical) {
        return Err(format!(
            "a filesystem root or system folder cannot be a project folder: {trimmed}"
        ));
    }
    if let Ok(data) = std::fs::canonicalize(config_dir) {
        if canonical.starts_with(&data) {
            return Err("the AETHER-OS data folder cannot be a project folder".to_owned());
        }
    }
    Ok(trimmed.to_owned())
}

/// Find code projects below `directories`. Only folders inside the
/// configured project folders or the vault are scanned; others are skipped
/// like missing ones.
#[tauri::command]
pub async fn cmd_scan_projects(
    state: State<'_, AppState>,
    directories: Vec<String>,
) -> Result<Vec<Project>, String> {
    let roots = workspace(&state).roots().to_vec();
    let mut projects = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for dir_str in &directories {
        let Ok(dir) = resolve_in_roots(&roots, dir_str) else {
            continue;
        };
        for path in scan_directory(&dir, 0) {
            let path_str = path.to_string_lossy().to_string();
            if !seen.insert(path_str.clone()) {
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path_str.clone());
            let language = detect_language(&path);
            let (git_branch, git_status, last_commit_msg, last_commit_date) = git_info(&path);
            projects.push(Project {
                name,
                path: path_str,
                git_branch,
                git_status,
                last_commit_msg,
                last_commit_date,
                language,
            });
        }
    }

    projects.sort_by_key(|p| std::cmp::Reverse(p.last_commit_date.unwrap_or(0)));
    Ok(projects)
}

/// Open a project (or file) in an external editor (default: Devin). The
/// path must lie inside the project folders, the vault or the file-search
/// folders.
#[tauri::command]
pub async fn cmd_open_project(
    state: State<'_, AppState>,
    path: String,
    editor: Option<String>,
) -> Result<(), String> {
    let target = resolve_in_roots(&allowed_roots(&state), &path)?;
    let requested = editor.unwrap_or_else(|| "devin".to_owned());
    let (app_name, cli) = resolve_editor(&requested)?;

    // Launch via `open -a` so this works even when the editor's CLI shim
    // (e.g. `code`, `cursor`, `windsurf`, `devin`) has not been installed
    // into PATH. The canonical target is absolute, so it can never be
    // mistaken for an option.
    let open_status = Command::new("open")
        .arg("-a")
        .arg(&app_name)
        .arg(&target)
        .status();

    if let Ok(status) = open_status {
        if status.success() {
            return Ok(());
        }
    }

    // Fallback for known editors only: their CLI shim, if installed.
    let Some(cli) = cli else {
        return Err(format!("Failed to launch {app_name}"));
    };
    let status = Command::new(cli)
        .arg(&target)
        .status()
        .map_err(|e| format!("Failed to launch {app_name}: {e}"))?;
    if !status.success() {
        return Err(format!("{cli} exited with status {status}"));
    }
    Ok(())
}

/// Open a new Terminal window in a project folder.
#[tauri::command]
pub async fn cmd_open_in_terminal(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let dir = resolve_folder_in_roots(&allowed_roots(&state), &path)?;
    Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(&dir)
        .status()
        .map_err(|e| format!("Failed to open Terminal: {e}"))?;
    Ok(())
}

/// Show a project folder in Finder.
#[tauri::command]
pub async fn cmd_open_in_finder(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let dir = resolve_folder_in_roots(&allowed_roots(&state), &path)?;
    Command::new("open")
        .arg(&dir)
        .status()
        .map_err(|e| format!("Failed to open Finder: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_project_dirs(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let config_path = state.vault.config_dir().join("project_dirs.json");
    if !config_path.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let config: ProjectDirsConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(config.directories)
}

#[tauri::command]
pub async fn cmd_add_project_dir(
    state: State<'_, AppState>,
    dir: String,
) -> Result<Vec<String>, String> {
    let dir = validate_project_dir(&dir, state.vault.config_dir())?;
    let config_path = state.vault.config_dir().join("project_dirs.json");
    let mut directories = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        let config: ProjectDirsConfig =
            serde_json::from_str(&content).unwrap_or(ProjectDirsConfig {
                directories: vec![],
            });
        config.directories
    } else {
        vec![]
    };
    if !directories.contains(&dir) {
        directories.push(dir);
    }
    let config = ProjectDirsConfig {
        directories: directories.clone(),
    };
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, content).map_err(|e| e.to_string())?;
    Ok(directories)
}

#[tauri::command]
pub async fn cmd_remove_project_dir(
    state: State<'_, AppState>,
    dir: String,
) -> Result<Vec<String>, String> {
    let config_path = state.vault.config_dir().join("project_dirs.json");
    let mut directories = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        let config: ProjectDirsConfig =
            serde_json::from_str(&content).unwrap_or(ProjectDirsConfig {
                directories: vec![],
            });
        config.directories
    } else {
        vec![]
    };
    directories.retain(|d| d != &dir);
    let config = ProjectDirsConfig {
        directories: directories.clone(),
    };
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, content).map_err(|e| e.to_string())?;
    Ok(directories)
}

#[cfg(test)]
mod tests {
    use super::{
        detect_language, is_project_dir, resolve_editor, resolve_folder_in_roots, resolve_in_roots,
        scan_directory, validate_project_dir,
    };
    use std::path::Path;

    /// Table: good path, `..` path, symlink escape, absolute outside path.
    #[test]
    fn project_paths_must_stay_inside_the_roots() {
        let root_dir = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let root = std::fs::canonicalize(root_dir.path()).expect("canonicalize");
        std::fs::create_dir(root.join("app")).expect("mkdir");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).expect("symlink");
        let roots = vec![root.clone()];
        let dotdot = format!(
            "{}/../{}",
            root.display(),
            outside.path().file_name().unwrap().to_string_lossy()
        );
        let mut cases = vec![
            (root.join("app").display().to_string(), true),
            (dotdot, false),
            (outside.path().display().to_string(), false),
        ];
        #[cfg(unix)]
        cases.push((root.join("escape").display().to_string(), false));
        for (path, ok) in cases {
            assert_eq!(resolve_in_roots(&roots, &path).is_ok(), ok, "{path}");
        }
    }

    #[test]
    fn folders_to_reveal_are_directories_but_not_bundles() {
        let root_dir = tempfile::tempdir().expect("root");
        let root = std::fs::canonicalize(root_dir.path()).expect("canonicalize");
        std::fs::create_dir_all(root.join("project")).expect("mkdir");
        std::fs::create_dir_all(root.join("Tool.app/Contents")).expect("mkdir");
        touch(&root, "file.txt");
        let roots = vec![root.clone()];
        assert!(resolve_folder_in_roots(&roots, &root.join("project").to_string_lossy()).is_ok());
        assert!(resolve_folder_in_roots(&roots, &root.join("Tool.app").to_string_lossy()).is_err());
        assert!(resolve_folder_in_roots(&roots, &root.join("file.txt").to_string_lossy()).is_err());
    }

    #[test]
    fn editors_are_known_keys_or_plain_app_names() {
        assert_eq!(
            resolve_editor("code").unwrap(),
            ("Visual Studio Code".to_owned(), Some("code"))
        );
        assert_eq!(resolve_editor("Cursor").unwrap().1, Some("cursor"));
        assert_eq!(resolve_editor("Zed").unwrap(), ("Zed".to_owned(), None));
        for bad in [
            "",
            "/usr/bin/python3",
            "../evil",
            "-a",
            ".hidden",
            "a\nb",
            "C:x",
        ] {
            assert!(resolve_editor(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn project_dirs_are_validated_before_they_are_added() {
        let data = tempfile::tempdir().expect("data");
        let projects = tempfile::tempdir().expect("projects");
        let ok = |d: &str| validate_project_dir(d, data.path()).is_ok();
        assert!(ok(&projects.path().to_string_lossy()));
        assert!(!ok("relative/dir"));
        assert!(!ok("/"));
        assert!(!ok("/usr"));
        assert!(!ok(&data.path().to_string_lossy()));
        std::fs::create_dir(data.path().join("tasks")).expect("mkdir");
        assert!(!ok(&data.path().join("tasks").to_string_lossy()));
        assert!(!ok("/definitely/not/here/xyz"));
    }

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), "").expect("marker file must be written");
    }

    #[test]
    fn detects_a_git_repository_as_a_project() {
        let dir = tempfile::tempdir().expect("temp dir must be created");
        std::fs::create_dir(dir.path().join(".git")).expect(".git must be created");
        assert!(is_project_dir(dir.path()));
    }

    #[test]
    fn detects_manifest_files_as_projects() {
        for manifest in ["package.json", "Cargo.toml"] {
            let dir = tempfile::tempdir().expect("temp dir must be created");
            touch(dir.path(), manifest);
            assert!(is_project_dir(dir.path()), "{manifest} must mark a project");
        }
    }

    #[test]
    fn ignores_plain_directories() {
        let dir = tempfile::tempdir().expect("temp dir must be created");
        touch(dir.path(), "notes.md");
        assert!(!is_project_dir(dir.path()));
    }

    #[test]
    fn identifies_rust_projects() {
        let dir = tempfile::tempdir().expect("temp dir must be created");
        touch(dir.path(), "Cargo.toml");
        assert_eq!(detect_language(dir.path()), "rust");
    }

    #[test]
    fn distinguishes_typescript_from_javascript() {
        let js = tempfile::tempdir().expect("temp dir must be created");
        touch(js.path(), "package.json");
        assert_eq!(detect_language(js.path()), "javascript");

        let ts = tempfile::tempdir().expect("temp dir must be created");
        touch(ts.path(), "package.json");
        touch(ts.path(), "tsconfig.json");
        assert_eq!(detect_language(ts.path()), "typescript");
    }

    #[test]
    fn identifies_python_and_go_projects() {
        let py = tempfile::tempdir().expect("temp dir must be created");
        touch(py.path(), "requirements.txt");
        assert_eq!(detect_language(py.path()), "python");

        let go = tempfile::tempdir().expect("temp dir must be created");
        touch(go.path(), "go.mod");
        assert_eq!(detect_language(go.path()), "go");
    }

    #[test]
    fn falls_back_to_unknown_language() {
        let dir = tempfile::tempdir().expect("temp dir must be created");
        assert_eq!(detect_language(dir.path()), "unknown");
    }

    #[test]
    fn finds_nested_projects_without_descending_into_them() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let project = root.path().join("my-app");
        std::fs::create_dir(&project).expect("project dir must be created");
        touch(&project, "Cargo.toml");

        // A nested manifest inside the project must not be reported separately.
        let nested = project.join("sub-crate");
        std::fs::create_dir(&nested).expect("nested dir must be created");
        touch(&nested, "Cargo.toml");

        let found = scan_directory(root.path(), 0);
        assert_eq!(found, vec![project]);
    }

    #[test]
    fn skips_dependency_and_build_directories() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        for ignored in ["node_modules", "target", "dist", ".cache"] {
            let dir = root.path().join(ignored);
            std::fs::create_dir(&dir).expect("ignored dir must be created");
            touch(&dir, "package.json");
        }

        assert!(scan_directory(root.path(), 0).is_empty());
    }
}
