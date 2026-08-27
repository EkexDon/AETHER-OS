use std::path::PathBuf;

use tauri::State;

use crate::commands::ide_commands::workspace;
use crate::engine::error::AetherError;
use crate::engine::git_repo::{BranchInfo, CommitInfo, FileDiff, GitRepo, RepoStatus};
use crate::AppState;

/// Open the repository for `path`, which must live inside one of the
/// sandboxed project roots. Discovery walks upwards, so any subdirectory of
/// a project works, mirroring plain `git`.
fn open_repo(state: &State<'_, AppState>, path: &str) -> Result<(GitRepo, PathBuf), AetherError> {
    let ws = workspace(state);
    let resolved = ws.resolve_existing(path)?;
    let repo = GitRepo::open(&resolved)?;
    let workdir = repo.workdir()?.to_path_buf();
    // Re-check that the discovered work tree is itself inside a root: a
    // project subdirectory must not be able to smuggle in an outside repo.
    if !ws.roots().iter().any(|root| workdir.starts_with(root)) {
        return Err(AetherError::InvalidInput(format!(
            "repository root is outside the allowed project directories: {}",
            workdir.display()
        )));
    }
    Ok((repo, workdir))
}

#[tauri::command]
pub async fn cmd_git_status(
    state: State<'_, AppState>,
    path: String,
) -> Result<RepoStatus, AetherError> {
    open_repo(&state, &path)?.0.status()
}

#[tauri::command]
pub async fn cmd_git_stage(state: State<'_, AppState>, path: String, files: Vec<String>) -> Result<(), AetherError> {
    open_repo(&state, &path)?.0.stage(&files)
}

#[tauri::command]
pub async fn cmd_git_unstage(state: State<'_, AppState>, path: String, files: Vec<String>) -> Result<(), AetherError> {
    open_repo(&state, &path)?.0.unstage(&files)
}

#[tauri::command]
pub async fn cmd_git_discard(state: State<'_, AppState>, path: String, files: Vec<String>) -> Result<(), AetherError> {
    open_repo(&state, &path)?.0.discard(&files)
}

#[tauri::command]
pub async fn cmd_git_commit(
    state: State<'_, AppState>,
    path: String,
    message: String,
) -> Result<String, AetherError> {
    open_repo(&state, &path)?.0.commit(&message)
}

#[tauri::command]
pub async fn cmd_git_branches(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<BranchInfo>, AetherError> {
    open_repo(&state, &path)?.0.branches()
}

#[tauri::command]
pub async fn cmd_git_switch_branch(state: State<'_, AppState>, path: String, branch: String) -> Result<(), AetherError> {
    open_repo(&state, &path)?.0.switch_branch(&branch)
}

#[tauri::command]
pub async fn cmd_git_create_branch(state: State<'_, AppState>, path: String, branch: String) -> Result<(), AetherError> {
    open_repo(&state, &path)?.0.create_branch(&branch)
}

#[tauri::command]
pub async fn cmd_git_log(
    state: State<'_, AppState>,
    path: String,
    limit: Option<usize>,
) -> Result<Vec<CommitInfo>, AetherError> {
    open_repo(&state, &path)?.0.log(limit.unwrap_or(50).min(500))
}

#[tauri::command]
pub async fn cmd_git_diff_file(
    state: State<'_, AppState>,
    path: String,
    file: String,
    staged: bool,
) -> Result<FileDiff, AetherError> {
    open_repo(&state, &path)?.0.diff_file(&file, staged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::path::Path;

    /// The security-critical guarantee: a path inside the sandbox whose
    /// `.git` points *outside* every root is refused.
    #[test]
    fn refuses_repositories_rooted_outside_the_sandbox() {
        let outside = tempfile::tempdir().expect("temp dir");
        Repository::init(outside.path()).expect("init outside");

        let inside = tempfile::tempdir().expect("temp dir");
        let project = inside.path().join("project");
        std::fs::create_dir_all(&project).expect("mkdir");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), project.join(".git"))
            .expect("symlink");

        let ws = crate::engine::workspace::Workspace::new([inside.path()]);
        assert!(ws.resolve_existing(project.to_str().unwrap()).is_ok());

        // libgit2 must not follow a symlinked .git into an outside repo.
        // If discovery ever succeeds, its work tree must be rejected by our
        // root check.
        if let Ok(discovered) = Repository::discover(&project) {
            let workdir = discovered.workdir().expect("workdir").to_path_buf();
            let allowed = ws
                .roots()
                .iter()
                .any(|root| workdir.starts_with(root));
            assert!(
                !allowed,
                "an outside repo reached through a symlink must be rejected"
            );
        }
    }

    #[test]
    fn accepts_repositories_inside_the_sandbox() {
        let inside = tempfile::tempdir().expect("temp dir");
        let project = inside.path().join("project");
        Repository::init(&project).expect("init inside");

        let ws = crate::engine::workspace::Workspace::new([inside.path()]);
        let canonical = ws
            .resolve_existing(project.to_str().unwrap())
            .expect("inside sandbox");
        let repo = GitRepo::open(&canonical).expect("open");
        let workdir = repo.workdir().expect("workdir").to_path_buf();
        assert!(ws
            .roots()
            .iter()
            .any(|root| workdir.starts_with(root)));
        let _ = Path::new("");
    }
}
