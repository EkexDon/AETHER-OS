use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::AppState;
use tauri::State;

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
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
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
            let modified = lines
                .iter()
                .filter(|l| !l.starts_with("??"))
                .count();
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

#[tauri::command]
pub async fn cmd_scan_projects(directories: Vec<String>) -> Result<Vec<Project>, String> {
    let mut projects = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for dir_str in &directories {
        let dir = Path::new(dir_str);
        if !dir.exists() {
            continue;
        }
        for path in scan_directory(dir, 0) {
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

    projects.sort_by(|a, b| b.last_commit_date.unwrap_or(0).cmp(&a.last_commit_date.unwrap_or(0)));
    Ok(projects)
}

#[tauri::command]
pub async fn cmd_open_project(path: String, editor: Option<String>) -> Result<(), String> {
    let editor_cmd = editor.unwrap_or_else(|| "cursor".to_owned());
    let status = Command::new(&editor_cmd)
        .arg(&path)
        .status()
        .map_err(|e| format!("Failed to launch {editor_cmd}: {e}"))?;
    if !status.success() {
        return Err(format!("{editor_cmd} exited with status {status}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_open_in_terminal(path: String) -> Result<(), String> {
    Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(&path)
        .status()
        .map_err(|e| format!("Failed to open Terminal: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_open_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .arg(&path)
        .status()
        .map_err(|e| format!("Failed to open Finder: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_project_dirs(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let config_path = state
        .vault
        .config_dir()
        .join("project_dirs.json");
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
    let config_path = state
        .vault
        .config_dir()
        .join("project_dirs.json");
    let mut directories = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        let config: ProjectDirsConfig =
            serde_json::from_str(&content).unwrap_or(ProjectDirsConfig { directories: vec![] });
        config.directories
    } else {
        vec![]
    };
    if !directories.contains(&dir) {
        directories.push(dir);
    }
    let config = ProjectDirsConfig { directories: directories.clone() };
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, content).map_err(|e| e.to_string())?;
    Ok(directories)
}

#[tauri::command]
pub async fn cmd_remove_project_dir(
    state: State<'_, AppState>,
    dir: String,
) -> Result<Vec<String>, String> {
    let config_path = state
        .vault
        .config_dir()
        .join("project_dirs.json");
    let mut directories = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        let config: ProjectDirsConfig =
            serde_json::from_str(&content).unwrap_or(ProjectDirsConfig { directories: vec![] });
        config.directories
    } else {
        vec![]
    };
    directories.retain(|d| d != &dir);
    let config = ProjectDirsConfig { directories: directories.clone() };
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, content).map_err(|e| e.to_string())?;
    Ok(directories)
}

#[cfg(test)]
mod tests {
    use super::{detect_language, is_project_dir, scan_directory};
    use std::path::Path;

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
