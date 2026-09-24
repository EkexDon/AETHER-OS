//! Path guards shared by the command layer and the engines.
//!
//! Every path that arrives from the webview — and every path taken from a
//! synced index, a restored backup or a model-proposed action — is
//! untrusted. The helpers here implement the one rule all of them follow:
//! resolve symlinks with [`std::fs::canonicalize`] (for paths that do not
//! exist yet: the deepest existing ancestor) and require the result to stay
//! inside a canonical root. Directories are only created *after* that check,
//! so a symlinked folder can never be used to create anything outside the
//! root.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use super::error::AetherError;

fn invalid(msg: impl Into<String>) -> AetherError {
    AetherError::InvalidInput(msg.into())
}

/// Canonicalize a path that may not exist yet: the deepest existing
/// ancestor is canonicalized and the missing tail is re-appended. `.` and
/// `..` in the missing tail are rejected (they would be resolved lexically
/// after the symlink-resolving part and could step out of a root).
pub fn canonicalize_lenient(path: &Path) -> Result<PathBuf, AetherError> {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while std::fs::symlink_metadata(&existing).is_err() {
        let name = existing
            .file_name()
            .ok_or_else(|| invalid(format!("invalid path: {}", path.display())))?
            .to_owned();
        tail.push(name);
        if !existing.pop() || existing.as_os_str().is_empty() {
            return Err(invalid(format!("invalid path: {}", path.display())));
        }
    }
    let mut out = std::fs::canonicalize(&existing)
        .map_err(|_| invalid(format!("path cannot be resolved: {}", path.display())))?;
    for part in tail.iter().rev() {
        if part == OsStr::new("..") || part == OsStr::new(".") {
            return Err(invalid(format!(
                "path must not contain '.' or '..': {}",
                path.display()
            )));
        }
        out.push(part);
    }
    Ok(out)
}

/// Resolve `path` (existing or not) and require it to lie inside `root`,
/// which must already be canonical. Returns the resolved path.
pub fn resolve_within(root: &Path, path: &Path) -> Result<PathBuf, AetherError> {
    let resolved = canonicalize_lenient(path)?;
    if !resolved.starts_with(root) {
        return Err(invalid(format!(
            "path is outside the allowed folder: {}",
            path.display()
        )));
    }
    Ok(resolved)
}

/// Create `dir` and its missing parents, but only after the deepest
/// existing ancestor was verified to be inside `root` (canonical); the
/// created directory is verified again afterwards. Returns the canonical
/// directory.
pub fn create_dir_all_within(root: &Path, dir: &Path) -> Result<PathBuf, AetherError> {
    resolve_within(root, dir)?;
    std::fs::create_dir_all(dir)?;
    let canonical = std::fs::canonicalize(dir)?;
    if !canonical.starts_with(root) {
        return Err(invalid(format!(
            "folder resolves outside the allowed folder: {}",
            dir.display()
        )));
    }
    Ok(canonical)
}

/// Ids that name a file inside an engine's storage folder (`<id>.json`):
/// 1–128 characters of ASCII letters, digits, `-` and `_`. Engines generate
/// UUIDs; anything with a dot, slash or other separator is refused, so an id
/// from the UI can never point outside the folder.
pub fn is_safe_file_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// [`is_safe_file_id`] as a `Result` with a readable error.
pub fn check_file_id(kind: &str, id: &str) -> Result<(), AetherError> {
    if is_safe_file_id(id) {
        Ok(())
    } else {
        Err(invalid(format!("invalid {kind} id: {id:?}")))
    }
}

/// True when any component of `path` is `.git` (case-insensitive, so the
/// rule also holds on case-insensitive file systems).
pub fn has_git_component(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(part) => part.to_string_lossy().eq_ignore_ascii_case(".git"),
        _ => false,
    })
}

/// Filesystem roots and operating-system folders that a user-chosen
/// location (project folder, vault, export destination) must never be or
/// lie in. `canonical` must already be canonical.
pub fn is_system_location(canonical: &Path) -> bool {
    if canonical.parent().is_none() {
        return true;
    }
    const SYSTEM: &[&str] = &[
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/private/etc",
        "/private/var/db",
        "/dev",
        "/proc",
        "/sys",
        "/Library",
        "/Applications",
        "C:\\Windows",
        "C:\\Program Files",
    ];
    SYSTEM.iter().any(|s| canonical.starts_with(s))
}

/// Validate a file destination the user picked (save dialog or typed
/// path): absolute, free of `.`/`..`, its parent folder exists, it is not a
/// directory, not a symbolic link, not inside a `.git` folder and not a
/// system location. Returns the path with a canonical parent.
pub fn user_destination_file(input: &str) -> Result<PathBuf, AetherError> {
    let trimmed = input.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty() || trimmed.contains('\0') || !path.is_absolute() {
        return Err(invalid(format!(
            "choose an absolute destination path (got \"{trimmed}\")"
        )));
    }
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid(format!(
            "the destination must not contain '.' or '..': {trimmed}"
        )));
    }
    let name = path
        .file_name()
        .ok_or_else(|| invalid(format!("the destination has no file name: {trimmed}")))?;
    let parent = path
        .parent()
        .ok_or_else(|| invalid(format!("invalid destination: {trimmed}")))?;
    let parent = std::fs::canonicalize(parent).map_err(|_| {
        invalid(format!(
            "destination folder does not exist: {}",
            parent.display()
        ))
    })?;
    let resolved = parent.join(name);
    if is_system_location(&parent) || has_git_component(&resolved) {
        return Err(invalid(format!(
            "refusing to write into a system or repository folder: {}",
            resolved.display()
        )));
    }
    if let Ok(meta) = std::fs::symlink_metadata(&resolved) {
        if meta.file_type().is_symlink() {
            return Err(invalid(format!(
                "the destination is a symbolic link: {}",
                resolved.display()
            )));
        }
        if meta.is_dir() {
            return Err(invalid(format!(
                "the destination is a folder: {}",
                resolved.display()
            )));
        }
    }
    Ok(resolved)
}

/// Validate an existing file the user picked for reading: absolute, a
/// regular file (symlinks resolved) and at most `max_bytes` large. Returns
/// the canonical path.
pub fn user_source_file(input: &str, max_bytes: u64) -> Result<PathBuf, AetherError> {
    let trimmed = input.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty() || trimmed.contains('\0') || !path.is_absolute() {
        return Err(invalid(format!(
            "choose an absolute file path (got \"{trimmed}\")"
        )));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| invalid(format!("file does not exist: {trimmed}")))?;
    let meta = std::fs::metadata(&canonical)?;
    if !meta.is_file() {
        return Err(invalid(format!("not a file: {trimmed}")));
    }
    if meta.len() > max_bytes {
        return Err(invalid(format!(
            "file is too large ({} bytes, limit {max_bytes})",
            meta.len()
        )));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical(dir: &tempfile::TempDir) -> PathBuf {
        std::fs::canonicalize(dir.path()).expect("canonicalize")
    }

    #[test]
    fn resolve_within_table() {
        let root_dir = tempfile::tempdir().expect("root");
        #[cfg(unix)]
        let outside = tempfile::tempdir().expect("outside");
        let root = canonical(&root_dir);
        std::fs::create_dir(root.join("sub")).expect("mkdir");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).expect("symlink");

        let cases: Vec<(PathBuf, bool)> = vec![
            (root.join("sub/new.md"), true),
            (root.join("sub/a/b/new.md"), true),
            (root.join("sub/../../etc/passwd"), false),
            (root.join("sub/missing/../x.md"), false),
            (PathBuf::from("/etc/passwd"), false),
            #[cfg(unix)]
            (root.join("escape/new.md"), false),
        ];
        for (path, ok) in cases {
            assert_eq!(
                resolve_within(&root, &path).is_ok(),
                ok,
                "{}",
                path.display()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn create_dir_all_within_never_creates_through_a_symlink() {
        let root_dir = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let root = canonical(&root_dir);
        std::os::unix::fs::symlink(outside.path(), root.join("link")).expect("symlink");

        let made = create_dir_all_within(&root, &root.join("a/b")).expect("inside");
        assert!(made.is_dir() && made.starts_with(&root));

        assert!(create_dir_all_within(&root, &root.join("link/new")).is_err());
        assert!(
            !outside.path().join("new").exists(),
            "nothing may be created outside the root"
        );
    }

    #[test]
    fn file_ids_cannot_leave_their_folder() {
        assert!(is_safe_file_id("0b9c7f5e-4a8e-4e0e-9a51-0c2d1b7c9f10"));
        assert!(is_safe_file_id("legacy_id-42"));
        for bad in [
            "",
            "../../config",
            "a/b",
            "a\\b",
            "x.json",
            "..",
            "a\0b",
            &"x".repeat(129),
        ] {
            assert!(!is_safe_file_id(bad), "{bad:?}");
        }
        assert!(check_file_id("task", "../x").is_err());
    }

    #[test]
    fn git_components_are_detected_case_insensitively() {
        assert!(has_git_component(Path::new("/v/.git/config")));
        assert!(has_git_component(Path::new("/v/.GIT/hooks/x")));
        assert!(!has_git_component(Path::new("/v/.github/workflows")));
        assert!(!has_git_component(Path::new("/v/notes/git.md")));
    }

    #[test]
    fn system_locations_are_refused() {
        assert!(is_system_location(Path::new("/")));
        assert!(is_system_location(Path::new("/usr/local/bin")));
        assert!(is_system_location(Path::new("/System/Library")));
        assert!(!is_system_location(Path::new("/Users/me/Desktop")));
    }

    #[test]
    fn user_destination_file_table() {
        let dir = tempfile::tempdir().expect("dir");
        let root = canonical(&dir);
        std::fs::create_dir(root.join("folder")).expect("mkdir");
        std::fs::create_dir(root.join(".git")).expect("mkdir");
        std::fs::write(root.join("existing.ics"), "x").expect("write");

        let ok = |p: &str| user_destination_file(p).is_ok();
        assert!(ok(&root.join("cal.ics").to_string_lossy()));
        assert!(ok(&root.join("existing.ics").to_string_lossy()));
        assert!(!ok("relative/cal.ics"));
        assert!(!ok(""));
        assert!(!ok(&format!("{}/folder/../cal.ics", root.display())));
        assert!(!ok(&root.join("folder").to_string_lossy()));
        assert!(!ok(&root.join("missing/cal.ics").to_string_lossy()));
        assert!(!ok(&root.join(".git/cal.ics").to_string_lossy()));
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().expect("outside");
            let target = outside.path().join("target.ics");
            std::fs::write(&target, "x").expect("write");
            std::os::unix::fs::symlink(&target, root.join("link.ics")).expect("symlink");
            assert!(!ok(&root.join("link.ics").to_string_lossy()));
        }
    }

    #[test]
    fn user_source_file_checks_kind_and_size() {
        let dir = tempfile::tempdir().expect("dir");
        let root = canonical(&dir);
        std::fs::write(root.join("small.ics"), "abc").expect("write");
        std::fs::write(root.join("big.ics"), vec![b'x'; 64]).expect("write");
        assert!(user_source_file(&root.join("small.ics").to_string_lossy(), 16).is_ok());
        assert!(user_source_file(&root.join("big.ics").to_string_lossy(), 16).is_err());
        assert!(user_source_file(&root.to_string_lossy(), 16).is_err());
        assert!(user_source_file("small.ics", 16).is_err());
    }
}
