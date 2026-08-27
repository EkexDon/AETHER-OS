//! `git_repo` — read/write access to a single Git repository.
//!
//! This is the engine behind the IDE's Source Control panel. It wraps libgit2
//! (`git2`) and deliberately exposes only the operations a lightweight editor
//! needs: status, stage/unstage, discard, commit, branches and a recent-commit
//! log. Anything more exotic (rebase, cherry-pick, remotes) is out of scope on
//! purpose — the built-in terminal is right there for that.
//!
//! Paths are always repository-relative with forward slashes, which is what
//! both libgit2 and the frontend speak.

use std::path::Path;

use git2::{BranchType, Repository, Status};
use serde::{Deserialize, Serialize};

use super::error::AetherError;

/// Fallback identity when neither the repo nor the global config defines one.
/// Without this a fresh machine could not commit from the IDE at all.
const FALLBACK_NAME: &str = "AETHER-OS";
const FALLBACK_EMAIL: &str = "aether@local";

/// What happened to a file, from Git's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChange,
}

fn classify(status: Status) -> Option<ChangeKind> {
    if status.intersects(Status::INDEX_NEW | Status::WT_NEW) {
        Some(ChangeKind::Added)
    } else if status.intersects(Status::INDEX_MODIFIED | Status::WT_MODIFIED) {
        Some(ChangeKind::Modified)
    } else if status.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
        Some(ChangeKind::Deleted)
    } else if status.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
        Some(ChangeKind::Renamed)
    } else if status.intersects(Status::INDEX_TYPECHANGE | Status::WT_TYPECHANGE) {
        Some(ChangeKind::TypeChange)
    } else {
        None
    }
}

/// One changed file with its staged and unstaged state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusEntry {
    /// Repository-relative path with forward slashes (the "from" path in case
    /// of renames).
    pub path: String,
    pub staged: Option<ChangeKind>,
    pub unstaged: Option<ChangeKind>,
}

/// Snapshot of the working tree plus HEAD position.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoStatus {
    /// Current branch name, or `(no branch)` while rebasing/detached.
    pub branch: String,
    pub ahead: usize,
    pub behind: usize,
    /// True when HEAD points at no commit yet (fresh `git init`).
    pub unborn: bool,
    pub entries: Vec<StatusEntry>,
}

/// A local branch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
}

/// One entry of the recent-commit log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitInfo {
    pub id: String,
    pub summary: String,
    pub author: String,
    /// Unix timestamp (seconds).
    pub time: i64,
}

/// Old/new text content of a file, ready to be fed into a diff view.
/// `None` means the side does not exist (new/deleted file).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub is_binary: bool,
}

/// An open repository. All operations are infallible w.r.t. shared state:
/// every call re-derives what it needs, so concurrent edits from the terminal
/// can never leave this struct holding stale handles.
pub struct GitRepo {
    repo: Repository,
}

impl GitRepo {
    /// Open the repository containing `path`. Like `git`, we discover upwards
    /// so pointing the IDE at any subdirectory still finds the repo root.
    pub fn open(path: &Path) -> Result<Self, AetherError> {
        let repo = Repository::discover(path).map_err(|_| {
            AetherError::InvalidInput(format!(
                "not a git repository (or any parent): {}",
                path.display()
            ))
        })?;
        Ok(Self { repo })
    }

    /// Absolute path of the work tree root.
    pub fn workdir(&self) -> Result<&Path, AetherError> {
        self.repo
            .workdir()
            .ok_or_else(|| AetherError::InvalidInput("repository has no work tree".into()))
    }

    fn normalize(rel: &str) -> Result<std::path::PathBuf, AetherError> {
        let p = std::path::Path::new(rel);
        if p.is_absolute() || rel.contains('\\') {
            return Err(AetherError::InvalidInput(format!(
                "expected a repository-relative path with forward slashes: {rel}"
            )));
        }
        if p.components().any(|c| {
            c == std::path::Component::ParentDir || c == std::path::Component::RootDir
        }) {
            return Err(AetherError::InvalidInput(format!(
                "path traversal is not allowed inside a repository: {rel}"
            )));
        }
        Ok(p.to_path_buf())
    }

    fn signature(&self) -> Result<git2::Signature<'static>, AetherError> {
        if let Ok(sig) = self.repo.signature() {
            return Ok(sig);
        }
        // No user.name/email anywhere — fall back instead of failing.
        git2::Signature::now(FALLBACK_NAME, FALLBACK_EMAIL)
            .map_err(|e| AetherError::Vault(format!("cannot build commit signature: {e}")))
    }

    /// The commit HEAD points at, or `None` for an unborn branch.
    fn head_commit(&self) -> Result<Option<git2::Commit<'_>>, AetherError> {
        match self.repo.head() {
            Ok(head) => {
                let oid = head.target().ok_or_else(|| {
                    AetherError::Vault("HEAD does not point at a commit".into())
                })?;
                Ok(Some(
                    self.repo
                        .find_commit(oid)
                        .map_err(|e| AetherError::Vault(format!("broken HEAD: {e}")))?,
                ))
            }
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => Ok(None),
            Err(e) => Err(AetherError::Vault(format!("cannot resolve HEAD: {e}"))),
        }
    }

    fn current_branch_name(&self) -> Result<(String, bool), AetherError> {
        match self.repo.head() {
            Ok(head) => {
                let short = head.shorthand().unwrap_or("(detached)").to_string();
                Ok((short, false))
            }
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => {
                // The ref file still carries the intended branch name.
                let target = head_target_of_unborn(&self.repo);
                Ok((target.unwrap_or_else(|| "main".to_string()), true))
            }
            Err(e) => Err(AetherError::Vault(format!("cannot resolve HEAD: {e}"))),
        }
    }

    pub fn status(&self) -> Result<RepoStatus, AetherError> {
        let (branch, unborn) = self.current_branch_name()?;

        let mut ahead = 0;
        let mut behind = 0;
        if !unborn {
            if let Ok(local) = self.repo.find_branch(&branch, BranchType::Local) {
                if let Ok(upstream) = local.upstream() {
                    if let (Some(l), Some(u)) = (local.get().target(), upstream.get().target()) {
                        if let Ok((a, b)) = self.repo.graph_ahead_behind(l, u) {
                            ahead = a;
                            behind = b;
                        }
                    }
                }
            }
        }

        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        let statuses = self
            .repo
            .statuses(Some(&mut opts))
            .map_err(|e| AetherError::Vault(format!("status failed: {e}")))?;

        let mut entries = Vec::with_capacity(statuses.len());
        for entry in statuses.iter() {
            let raw_path = match entry.head_to_index().or_else(|| entry.index_to_workdir()) {
                Some(diff_delta) => diff_delta.new_file().path().or_else(|| diff_delta.old_file().path()),
                None => None,
            };
            let path = match raw_path {
                Some(p) => p.to_string_lossy().replace('\\', "/"),
                None => continue,
            };
            let s = entry.status();
            // Ignore files that are only marked as ignored or unreadable.
            if !s.intersects(
                Status::INDEX_NEW
                    | Status::INDEX_MODIFIED
                    | Status::INDEX_DELETED
                    | Status::INDEX_RENAMED
                    | Status::INDEX_TYPECHANGE
                    | Status::WT_NEW
                    | Status::WT_MODIFIED
                    | Status::WT_DELETED
                    | Status::WT_RENAMED
                    | Status::WT_TYPECHANGE,
            ) {
                continue;
            }
            let staged = classify(s & (Status::INDEX_NEW | Status::INDEX_MODIFIED | Status::INDEX_DELETED | Status::INDEX_RENAMED | Status::INDEX_TYPECHANGE));
            let unstaged = classify(s & (Status::WT_NEW | Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_RENAMED | Status::WT_TYPECHANGE));
            if staged.is_none() && unstaged.is_none() {
                continue;
            }
            entries.push(StatusEntry { path, staged, unstaged });
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));

        Ok(RepoStatus { branch, ahead, behind, unborn, entries })
    }

    /// Stage files (add new/modified content to the index).
    pub fn stage(&self, paths: &[String]) -> Result<(), AetherError> {
        let workdir = self.workdir()?;
        let mut index = self
            .repo
            .index()
            .map_err(|e| AetherError::Vault(format!("cannot open index: {e}")))?;
        for rel in paths {
            let path = Self::normalize(rel)?;
            let absolute = workdir.join(&path);
            if absolute.is_file() {
                index.add_path(&path).map_err(|e| {
                    AetherError::Vault(format!("cannot stage {rel}: {e}"))
                })?;
            } else {
                // File is gone from disk: staging it records the deletion.
                index.remove_path(&path).or_else(|e| {
                    // Untracked-and-deleted was never in the index; fine.
                    if e.code() == git2::ErrorCode::NotFound {
                        Ok(())
                    } else {
                        Err(AetherError::Vault(format!("cannot stage deletion of {rel}: {e}")))
                    }
                })?;
            }
        }
        index.write().map_err(|e| {
            AetherError::Vault(format!("cannot write index: {e}"))
        })
    }

    /// Undo staging: move paths back to their HEAD state in the index.
    pub fn unstage(&self, paths: &[String]) -> Result<(), AetherError> {
        let specs: Vec<&str> = paths.iter().map(String::as_str).collect();
        let head = self.head_commit()?;
        match head {
            // `git restore --staged`: reset the matching index entries to the
            // HEAD state. libgit2 needs an explicit target here — a NULL
            // target *removes* the entries instead of restoring them.
            Some(commit) => {
                self.repo
                    .reset_default(Some(commit.as_object()), specs.iter().copied())
                    .map_err(|e| AetherError::Vault(format!("unstage failed: {e}")))?;
            }
            None => {
                // No commits yet: unstaging simply drops the entries.
                let mut index = self
                    .repo
                    .index()
                    .map_err(|e| AetherError::Vault(format!("cannot open index: {e}")))?;
                for spec in specs {
                    let _ = index.remove_path(std::path::Path::new(spec));
                }
                index.write().map_err(|e| {
                    AetherError::Vault(format!("cannot write index: {e}"))
                })?;
            }
        }
        Ok(())
    }

    /// Discard all *unstaged* changes of the given paths. This rewrites the
    /// working tree and cannot be undone — the UI must confirm first.
    pub fn discard(&self, paths: &[String]) -> Result<(), AetherError> {
        let workdir = self.workdir()?;
        for rel in paths {
            let path = Self::normalize(rel)?;
            let absolute = workdir.join(&path);

            let tracked_status = {
                let mut opts = git2::StatusOptions::new();
                opts.include_untracked(false).pathspec(rel);
                self.repo
                    .statuses(Some(&mut opts))
                    .map_err(|e| AetherError::Vault(format!("status failed: {e}")))?
                    .iter()
                    .next()
                    .map(|e| e.status())
                    .unwrap_or(Status::empty())
            };

            if tracked_status.is_wt_new() || tracked_status.is_empty() {
                // Untracked file: discarding means deleting it.
                if absolute.is_file() {
                    std::fs::remove_file(&absolute)?;
                }
                continue;
            }

            // Tracked: restore worktree content from the index.
            let index = self
                .repo
                .index()
                .map_err(|e| AetherError::Vault(format!("cannot open index: {e}")))?;
            match index.get_path(&path, 0) {
                Some(entry) => {
                    let blob = self
                        .repo
                        .find_blob(entry.id)
                        .map_err(|e| AetherError::Vault(format!("cannot find blob: {e}")))?;
                    if let Some(parent) = absolute.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::write(&absolute, blob.content())?;
                }
                None => {
                    // Not in the index anymore but deleted in the worktree:
                    // restoring means removing whatever is left on disk.
                    if absolute.exists() {
                        std::fs::remove_file(&absolute)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Commit everything currently staged. Returns the new commit id.
    pub fn commit(&self, message: &str) -> Result<String, AetherError> {
        let message = message.trim();
        if message.is_empty() {
            return Err(AetherError::InvalidInput(
                "commit message must not be empty".into(),
            ));
        }

        let mut index = self
            .repo
            .index()
            .map_err(|e| AetherError::Vault(format!("cannot open index: {e}")))?;
        index.write().map_err(|e| AetherError::Vault(format!("cannot write index: {e}")))?;
        let tree_oid = index
            .write_tree()
            .map_err(|e| AetherError::Vault(format!("cannot build tree: {e}")))?;
        let tree = self
            .repo
            .find_tree(tree_oid)
            .map_err(|e| AetherError::Vault(format!("cannot find tree: {e}")))?;

        let sig = self.signature()?;
        let parent = self.head_commit()?;
        let parents: Vec<&git2::Commit> = parent.iter().collect();

        let oid = self
            .repo
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .map_err(|e| AetherError::Vault(format!("commit failed: {e}")))?;
        Ok(oid.to_string())
    }

    /// Local branches, newest checkout last.
    pub fn branches(&self) -> Result<Vec<BranchInfo>, AetherError> {
        let current = self
            .repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().ok().map(String::from));
        let branches = self
            .repo
            .branches(Some(BranchType::Local))
            .map_err(|e| AetherError::Vault(format!("cannot list branches: {e}")))?;
        let mut infos: Vec<BranchInfo> = Vec::new();
        for branch in branches {
            let (branch, _) =
                branch.map_err(|e| AetherError::Vault(format!("corrupt branch list: {e}")))?;
            let name = branch
                .name()
                .map_err(|e| AetherError::Vault(format!("unnamed branch: {e}")))?
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            infos.push(BranchInfo {
                is_current: current.as_deref() == Some(name.as_str()),
                name,
            });
        }
        infos.sort_by(|a, b| b.is_current.cmp(&a.is_current).then_with(|| a.name.cmp(&b.name)));
        Ok(infos)
    }

    /// Check out an existing local branch and update the working tree.
    pub fn switch_branch(&self, name: &str) -> Result<(), AetherError> {
        let branch = self
            .repo
            .find_branch(name, BranchType::Local)
            .map_err(|_| AetherError::InvalidInput(format!("no such branch: {name}")))?;
        let refname = branch
            .get()
            .name()
            .ok()
            .map(str::to_string)
            .ok_or_else(|| {
                AetherError::InvalidInput(format!("branch has no reference: {name}"))
            })?;
        self.repo
            .set_head(&refname)
            .map_err(|e| AetherError::Vault(format!("cannot switch to {name}: {e}")))?;

        let mut opts = git2::build::CheckoutBuilder::new();
        opts.force();
        self.repo
            .checkout_head(Some(&mut opts))
            .map_err(|e| AetherError::Vault(format!("checkout failed: {e}")))
    }

    /// Create a branch at HEAD without switching to it.
    pub fn create_branch(&self, name: &str) -> Result<(), AetherError> {
        if name.trim().is_empty() {
            return Err(AetherError::InvalidInput("branch name must not be empty".into()));
        }
        let parent = self
            .head_commit()?
            .ok_or_else(|| AetherError::InvalidInput("cannot branch before the first commit".into()))?;
        self.repo
            .branch(name, &parent, false)
            .map(|_| ())
            .map_err(|e| AetherError::InvalidInput(format!("cannot create branch {name:?}: {e}")))
    }

    /// The most recent commits reachable from HEAD.
    pub fn log(&self, limit: usize) -> Result<Vec<CommitInfo>, AetherError> {
        let Some(commit) = self.head_commit()? else {
            return Ok(Vec::new());
        };
        let mut revwalk = self
            .repo
            .revwalk()
            .map_err(|e| AetherError::Vault(format!("cannot walk history: {e}")))?;
        revwalk
            .push(commit.id())
            .map_err(|e| AetherError::Vault(format!("cannot walk history: {e}")))?;

        let mut out = Vec::with_capacity(limit.min(64));
        for oid in revwalk.take(limit) {
            let commit = self
                .repo
                .find_commit(oid.map_err(|e| AetherError::Vault(format!("history error: {e}")))?)
                .map_err(|e| AetherError::Vault(format!("history error: {e}")))?;
            out.push(CommitInfo {
                id: commit.id().to_string()[..7].to_string(),
                summary: commit
                    .summary()
                    .ok()
                    .flatten()
                    .unwrap_or("")
                    .to_string(),
                author: commit.author().name().unwrap_or("").to_string(),
                time: commit.time().seconds(),
            });
        }
        Ok(out)
    }

    /// Old/new content of one file for the diff view. `staged` selects the
    /// HEAD↔index comparison; otherwise index↔worktree is shown.
    pub fn diff_file(&self, rel: &str, staged: bool) -> Result<FileDiff, AetherError> {
        let path = Self::normalize(rel)?;
        let workdir = self.workdir()?;

        let decode = |bytes: &[u8]| -> (Option<String>, bool) {
            if bytes.contains(&0) {
                (None, true)
            } else {
                (
                    Some(String::from_utf8_lossy(bytes).to_string()),
                    false,
                )
            }
        };

        let (old_content, new_content, is_binary) = if staged {
            let old = self.head_blob_content(&path)?;
            let new = self.index_blob_content(&path)?;
            let (o, ob) = match &old {
                Some(bytes) => decode(bytes),
                None => (None, false),
            };
            let (n, nb) = match &new {
                Some(bytes) => decode(bytes),
                None => (None, false),
            };
            (o, n, ob || nb)
        } else {
            let index_content = self.index_blob_content(&path)?;
            let disk_bytes = std::fs::read(workdir.join(&path)).ok();
            let (o, ob) = match &index_content {
                Some(bytes) => decode(bytes),
                // Untracked: nothing in HEAD or the index — show as
                // "everything added" so the diff reads naturally.
                None => (Some(String::new()), false),
            };
            let (n, nb) = match &disk_bytes {
                Some(bytes) => decode(bytes),
                None => (None, false), // deleted from disk
            };
            (o, n, ob || nb)
        };

        Ok(FileDiff {
            path: rel.to_string(),
            old_content,
            new_content,
            is_binary,
        })
    }

    fn head_blob_content(&self, path: &std::path::Path) -> Result<Option<Vec<u8>>, AetherError> {
        let Some(commit) = self.head_commit()? else {
            return Ok(None);
        };
        let tree = commit.tree().map_err(|e| AetherError::Vault(format!("broken commit: {e}")))?;
        match tree.get_path(path) {
            Ok(entry) => {
                let blob = self
                    .repo
                    .find_blob(entry.id())
                    .map_err(|e| AetherError::Vault(format!("broken tree entry: {e}")))?;
                Ok(Some(blob.content().to_vec()))
            }
            Err(_) => Ok(None),
        }
    }

    fn index_blob_content(&self, path: &std::path::Path) -> Result<Option<Vec<u8>>, AetherError> {
        let index = self
            .repo
            .index()
            .map_err(|e| AetherError::Vault(format!("cannot open index: {e}")))?;
        match index.get_path(path, 0) {
            Some(entry) => {
                let blob = self
                    .repo
                    .find_blob(entry.id)
                    .map_err(|e| AetherError::Vault(format!("broken index entry: {e}")))?;
                Ok(Some(blob.content().to_vec()))
            }
            None => Ok(None),
        }
    }
}

/// For an unborn HEAD the ref file contains something like
/// `ref: refs/heads/main`; extract the branch shorthand from it.
fn head_target_of_unborn(repo: &Repository) -> Option<String> {
    use std::io::Read;
    let path = repo.path().join("HEAD");
    let mut content = String::new();
    std::fs::File::open(path).ok()?.read_to_string(&mut content).ok()?;
    content
        .trim()
        .strip_prefix("ref: refs/heads/")
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
#[test]
fn debug_upstream_resolution() {
    use super::*;
    let t = TestRepo::new();
    t.write("a.txt", "v1");
    t.commit_all("base");

    let repo = GitRepo::open(t.path()).expect("open");
    let branch_name = t.status().branch;
    eprintln!("branch={branch_name}");
    let _ = repo.repo.remote("origin", "/tmp/fake.git").unwrap();
    let local = repo.repo.find_branch(&branch_name, BranchType::Local).unwrap();
    let oid = local.get().target().unwrap();
    repo.repo.reference(&format!("refs/remotes/origin/{branch_name}"), oid, true, "t").unwrap();
    let mut cfg = repo.repo.config().unwrap();
    cfg.set_str(&format!("branch.{branch_name}.remote"), "origin").unwrap();
    cfg.set_str(&format!("branch.{branch_name}.merge"), &format!("refs/heads/{branch_name}")).unwrap();

    t.write("a.txt", "v2");
    t.commit_all("second");

    let local = repo.repo.find_branch(&branch_name, BranchType::Local).unwrap();
    let l_oid = local.get().target().unwrap();
    let up = local.upstream().map(|u| u.get().target());
    match up {
        Ok(Some(u_oid)) => {
            eprintln!("l={l_oid:?} u={u_oid:?} ab={:?}", repo.repo.graph_ahead_behind(l_oid, u_oid));
        }
        Ok(None) => eprintln!("upstream has no target"),
        Err(e) => eprintln!("upstream error: {e}"),
    }
}

    use super::*;
    use std::path::Path;

    /// A tiny test-repo factory: init, configure identity, write + commit.
    struct TestRepo {
        dir: tempfile::TempDir,
    }

    impl TestRepo {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("temp dir");
            let repo = Repository::init(dir.path()).expect("init");
            repo.config()
                .expect("config")
                .set_str("user.name", "Test User")
                .expect("name");
            repo.config()
                .expect("config")
                .set_str("user.email", "test@example.com")
                .expect("email");
            Self { dir }
        }

        fn path(&self) -> &Path {
            self.dir.path()
        }

        fn write(&self, rel: &str, content: &str) {
            let file = self.dir.path().join(rel);
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent).expect("parent dirs");
            }
            std::fs::write(file, content).expect("write fixture");
        }

        fn remove(&self, rel: &str) {
            std::fs::remove_file(self.dir.path().join(rel)).expect("remove fixture");
        }

        fn commit_all(&self, msg: &str) {
            let repo = GitRepo::open(self.path()).expect("open");
            let mut index = repo.repo.index().expect("index");
            index.add_all(["*"], git2::IndexAddOption::DEFAULT, None).expect("add all");
            index.write().expect("index write");
            let tree_oid = index.write_tree().expect("tree");
            let tree = repo.repo.find_tree(tree_oid).expect("find tree");
            let sig = repo.signature().expect("signature");
            let parent = repo.head_commit().expect("head");
            let parents: Vec<&git2::Commit> = parent.iter().collect();
            repo.repo
                .commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
                .expect("commit");
        }

        fn entry(&self, rel: &str) -> StatusEntry {
            self.status()
                .entries
                .into_iter()
                .find(|e| e.path == rel)
                .unwrap_or_else(|| panic!("no status entry for {rel}"))
        }

        fn status(&self) -> RepoStatus {
            GitRepo::open(self.path()).expect("open").status().expect("status")
        }
    }

    #[test]
    fn rejects_paths_outside_the_repository() {
        assert!(GitRepo::normalize("../escape.txt").is_err());
        assert!(GitRepo::normalize("/abs/path.txt").is_err());
        assert!(GitRepo::normalize("sub\\win.txt").is_err());
        assert!(GitRepo::normalize("src/main.rs").is_ok());
    }

    #[test]
    fn fails_on_a_directory_without_git() {
        let dir = tempfile::tempdir().expect("temp dir");
        let error = match GitRepo::open(dir.path()) {
            Err(e) => e,
            Ok(_) => panic!("must fail outside a repo"),
        };
        assert!(error.to_string().contains("not a git repository"));
    }

    #[test]
    fn discovers_a_repo_from_a_subdirectory() {
        let t = TestRepo::new();
        t.commit_all("initial");

        let sub = t.path().join("src").join("deep");
        std::fs::create_dir_all(&sub).expect("mkdirs");
        let repo = GitRepo::open(&sub).expect("discovery must walk up");
        // macOS reports /var/... as /private/var/... through libgit2.
        assert_eq!(
            repo.workdir().expect("workdir"),
            std::fs::canonicalize(t.path()).expect("canonical temp dir")
        );
    }

    #[test]
    fn reports_an_unborn_repository_cleanly() {
        let t = TestRepo::new();
        t.write("new.txt", "hello");
        let status = t.status();
        assert!(status.unborn);
        assert_eq!(status.ahead + status.behind, 0);
        let entry = t.entry("new.txt");
        assert_eq!(entry.staged, None);
        assert_eq!(entry.unstaged, Some(ChangeKind::Added));
    }

    #[test]
    fn tracks_stage_and_unstage_round_trip() {
        let t = TestRepo::new();
        t.write("a.txt", "v1");
        t.commit_all("initial");
        t.write("a.txt", "v2");

        let entry = t.entry("a.txt");
        assert_eq!(entry.staged, None);
        assert_eq!(entry.unstaged, Some(ChangeKind::Modified));

        let repo = GitRepo::open(t.path()).expect("open");
        repo.stage(&["a.txt".to_string()]).expect("stage");
        let entry = t.entry("a.txt");
        assert_eq!(entry.staged, Some(ChangeKind::Modified));
        assert_eq!(entry.unstaged, None);

        repo.unstage(&["a.txt".to_string()]).expect("unstage");
        let entry = t.entry("a.txt");
        assert_eq!(entry.staged, None);
        assert_eq!(entry.unstaged, Some(ChangeKind::Modified));
    }

    #[test]
    fn stages_deletions_and_commits_them() {
        let t = TestRepo::new();
        t.write("gone.txt", "bye");
        t.commit_all("initial");
        t.remove("gone.txt");

        let repo = GitRepo::open(t.path()).expect("open");
        repo.stage(&["gone.txt".to_string()]).expect("stage deletion");
        assert_eq!(t.entry("gone.txt").staged, Some(ChangeKind::Deleted));

        let id = repo.commit("remove gone.txt").expect("commit");
        assert_eq!(id.len(), 40);
        let status = t.status();
        assert!(status.entries.iter().all(|e| e.path != "gone.txt"));
    }

    #[test]
    fn commits_staged_changes_and_clears_the_status() {
        let t = TestRepo::new();
        t.write("a.txt", "v1");
        t.commit_all("initial");
        t.write("a.txt", "v2");

        let repo = GitRepo::open(t.path()).expect("open");
        repo.stage(&["a.txt".to_string()]).expect("stage");
        let id = repo.commit("bump a.txt").expect("commit");
        assert_eq!(id.len(), 40);

        let status = t.status();
        assert!(status.entries.is_empty(), "{:?}", status.entries);
    }

    #[test]
    fn refuses_empty_commit_messages() {
        let t = TestRepo::new();
        t.write("a.txt", "v1");
        let repo = GitRepo::open(t.path()).expect("open");
        repo.stage(&["a.txt".to_string()]).expect("stage");
        assert!(repo.commit("   ").is_err());
    }

    #[test]
    fn commits_into_an_unborn_branch_and_names_it() {
        let t = TestRepo::new();
        t.write("first.txt", "1");
        let repo = GitRepo::open(t.path()).expect("open");
        repo.stage(&["first.txt".to_string()]).expect("stage");
        repo.commit("initial").expect("first commit ever");

        let status = t.status();
        assert!(!status.unborn);
        let branch = status.branch;
        assert!(["main", "master"].contains(&branch.as_str()), "got {branch}");
    }

    #[test]
    fn falls_back_to_identity_when_config_is_missing() {
        // Isolate libgit2 from the machine's global/system git config by
        // emptying its search paths. Other tests always set a repo-local
        // identity, so they are unaffected.
        unsafe {
            let _ = git2::opts::set_search_path(git2::ConfigLevel::Global, "");
            let _ = git2::opts::set_search_path(git2::ConfigLevel::System, "");
            let _ = git2::opts::set_search_path(git2::ConfigLevel::XDG, "");
        }

        let dir = tempfile::tempdir().expect("temp dir");
        Repository::init(dir.path()).expect("init");
        let repo = GitRepo::open(dir.path()).expect("open");
        let sig = repo.signature().expect("fallback signature");
        assert_eq!(sig.name(), Ok(FALLBACK_NAME));
        assert_eq!(sig.email(), Ok(FALLBACK_EMAIL));
    }

    #[test]
    fn lists_creates_and_switches_branches() {
        let t = TestRepo::new();
        t.write("a.txt", "v1");
        t.commit_all("initial");

        let repo = GitRepo::open(t.path()).expect("open");
        repo.create_branch("feature/x").expect("create branch");

        let branches = repo.branches().expect("branches");
        assert_eq!(branches.len(), 2);
        assert!(branches.iter().any(|b| b.name == "feature/x" && !b.is_current));
        assert!(branches.iter().any(|b| b.is_current));

        repo.switch_branch("feature/x").expect("switch");
        let branches = repo.branches().expect("branches after switch");
        assert!(
            branches[0].name == "feature/x" && branches[0].is_current,
            "current branch must sort first"
        );

        assert!(repo.create_branch("feature/x").is_err()); // duplicate
        assert!(repo.switch_branch("does-not-exist").is_err());
    }

    #[test]
    fn switching_branches_updates_the_worktree() {
        let t = TestRepo::new();
        t.write("only-on-main.txt", "hello");
        t.commit_all("initial");
        let initial_branch = t.status().branch;

        let repo = GitRepo::open(t.path()).expect("open");
        repo.create_branch("elsewhere").expect("branch");
        repo.switch_branch("elsewhere").expect("switch");
        assert!(t.path().join("only-on-main.txt").exists());

        // Remove the file on the new branch.
        t.remove("only-on-main.txt");
        repo.stage(&["only-on-main.txt".to_string()]).expect("stage");
        repo.commit("delete file").expect("commit");
        assert!(!t.path().join("only-on-main.txt").exists());

        repo.switch_branch(&initial_branch).expect("switch back");
        assert!(t.path().join("only-on-main.txt").exists());
    }

    #[test]
    fn returns_recent_commits_newest_first() {
        let t = TestRepo::new();
        t.write("a.txt", "1");
        t.commit_all("first");
        t.write("a.txt", "2");
        t.commit_all("second");

        let repo = GitRepo::open(t.path()).expect("open");
        let log = repo.log(10).expect("log");
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].summary, "second");
        assert_eq!(log[1].summary, "first");
        assert_eq!(log[0].id.len(), 7); // short hash
        assert_eq!(log[0].author, "Test User");
    }

    #[test]
    fn empty_log_for_unborn_repositories() {
        let t = TestRepo::new();
        let repo = GitRepo::open(t.path()).expect("open");
        assert!(repo.log(10).expect("log").is_empty());
    }

    #[test]
    fn diffs_modified_files_in_both_views() {
        let t = TestRepo::new();
        t.write("a.txt", "line1\nline2\n");
        t.commit_all("initial");
        t.write("a.txt", "line1\nchanged\n");

        let repo = GitRepo::open(t.path()).expect("open");
        repo.stage(&["a.txt".to_string()]).expect("stage v2");

        let staged = repo.diff_file("a.txt", true).expect("staged diff");
        assert!(staged.old_content.unwrap().contains("line2"));
        assert!(staged.new_content.unwrap().contains("changed"));

        // Worktree still matches the staged version → no unstaged delta.
        let unstaged = repo.diff_file("a.txt", false).expect("unstaged diff");
        assert_eq!(unstaged.old_content, unstaged.new_content);
    }

    #[test]
    fn shows_untracked_files_as_fully_added() {
        let t = TestRepo::new();
        t.write("brand-new.txt", "content\n");
        let repo = GitRepo::open(t.path()).expect("open");

        let diff = repo.diff_file("brand-new.txt", false).expect("diff");
        assert_eq!(diff.old_content.as_deref(), Some(""));
        assert_eq!(diff.new_content.as_deref(), Some("content\n"));
        assert!(!diff.is_binary);
    }

    #[test]
    fn shows_deleted_worktree_files_as_removed() {
        let t = TestRepo::new();
        t.write("a.txt", "data\n");
        t.commit_all("initial");
        t.remove("a.txt");

        let repo = GitRepo::open(t.path()).expect("open");
        let diff = repo.diff_file("a.txt", false).expect("diff");
        assert_eq!(diff.old_content.as_deref(), Some("data\n"));
        assert_eq!(diff.new_content, None);
    }

    #[test]
    fn flags_binary_files_in_diffs() {
        let t = TestRepo::new();
        t.write("a.txt", "text");
        t.commit_all("initial");
        std::fs::write(t.path().join("a.txt"), [0x00, 0x01, 0x02]).expect("binary");

        let repo = GitRepo::open(t.path()).expect("open");
        let diff = repo.diff_file("a.txt", false).expect("diff");
        assert!(diff.is_binary);
    }

    #[test]
    fn discards_unstaged_edits_but_keeps_the_committed_state() {
        let t = TestRepo::new();
        t.write("a.txt", "committed\n");
        t.commit_all("initial");
        t.write("a.txt", "dirty\n");

        let repo = GitRepo::open(t.path()).expect("open");
        repo.discard(&["a.txt".to_string()]).expect("discard");
        assert_eq!(
            std::fs::read_to_string(t.path().join("a.txt")).expect("read"),
            "committed\n"
        );
    }

    #[test]
    fn discarding_removes_untracked_files() {
        let t = TestRepo::new();
        t.write("scratch.txt", "junk");
        t.commit_all("initial");

        let repo = GitRepo::open(t.path()).expect("open");
        repo.discard(&["scratch.txt".to_string()]).expect("discard");
        assert!(!t.path().join("scratch.txt").exists());
    }

    #[test]
    fn discarding_restores_deleted_files() {
        let t = TestRepo::new();
        t.write("precious.txt", "keep me");
        t.commit_all("initial");
        t.remove("precious.txt");

        let repo = GitRepo::open(t.path()).expect("open");
        repo.discard(&["precious.txt".to_string()]).expect("discard");
        assert_eq!(
            std::fs::read_to_string(t.path().join("precious.txt")).expect("read"),
            "keep me"
        );
    }

    #[test]
    fn reports_ahead_and_behind_against_upstream() {
        let t = TestRepo::new();
        t.write("a.txt", "v1");
        t.commit_all("base");

        let repo = GitRepo::open(t.path()).expect("open");

        // Simulate a remote: a real (never-fetched) remote entry, a
        // remote-tracking ref, plus the standard branch.*.remote / .merge
        // config entries — exactly what `git push -u` would leave behind.
        let branch_name = t.status().branch;
        let set_upstream = |repo: &GitRepo, target: git2::Oid| {
            let _ = repo.repo.remote_delete("origin");
            repo.repo
                .remote("origin", "/tmp/aether-fake-origin.git")
                .expect("fake remote");
            repo.repo
                .reference(
                    &format!("refs/remotes/origin/{branch_name}"),
                    target,
                    true,
                    "test",
                )
                .expect("tracking ref");
            let mut cfg = repo.repo.config().expect("config");
            cfg.set_str(&format!("branch.{branch_name}.remote"), "origin")
                .expect("remote cfg");
            cfg.set_str(
                &format!("branch.{branch_name}.merge"),
                &format!("refs/heads/{branch_name}"),
            )
            .expect("merge cfg");
        };
        let head_oid = |repo: &GitRepo| {
            repo.repo.head().expect("head").target().expect("target")
        };

        let base = head_oid(&repo);
        set_upstream(&repo, base);
        let status = t.status();
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);

        // One extra local commit → ahead by one.
        t.write("a.txt", "v2");
        t.commit_all("second");
        let status = t.status();
        assert_eq!(status.ahead, 1);
        assert_eq!(status.behind, 0);

        // Rewind local branch to the base while the upstream keeps the newer
        // commit → purely behind by one.
        let second = head_oid(&repo);
        set_upstream(&repo, second);
        repo.repo
            .reference(&format!("refs/heads/{branch_name}"), base, true, "rewind")
            .expect("rewind main");
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.force();
        repo.repo.checkout_head(Some(&mut opts)).expect("checkout base");
        let status = t.status();
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 1);
    }
}
