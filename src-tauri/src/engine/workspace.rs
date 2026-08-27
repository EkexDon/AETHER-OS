use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::error::AetherError;

/// Files above this size are never sent to the editor: Monaco chokes on
/// multi-megabyte documents and a stray binary would otherwise be turned
/// into a lossy UTF-8 string and could be written back, corrupting it.
pub const MAX_EDITABLE_BYTES: u64 = 2 * 1024 * 1024;

/// Directories that are pure build/dependency noise. Hiding them keeps the
/// tree usable in real projects (a single `node_modules` can hold >100k files).
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".git",
    ".next",
    ".venv",
    "__pycache__",
    ".turbo",
    ".cache",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// A path-sandboxed view of the filesystem.
///
/// Every operation resolves its argument against a set of allowed roots and
/// refuses anything that escapes them. Resolution goes through
/// [`std::fs::canonicalize`], so `..` traversal and symlinks that point
/// outside a root are both rejected rather than merely discouraged.
#[derive(Debug, Default)]
pub struct Workspace {
    roots: Vec<PathBuf>,
}

impl Workspace {
    /// Build a workspace from candidate roots. Roots that do not exist (or
    /// cannot be canonicalized) are dropped rather than failing the whole
    /// workspace, so one stale entry in the config cannot lock the user out.
    pub fn new<I, P>(roots: I) -> Self
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let roots = roots
            .into_iter()
            .filter_map(|r| std::fs::canonicalize(r.as_ref()).ok())
            .collect();
        Self { roots }
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    fn deny(path: &Path) -> AetherError {
        AetherError::InvalidInput(format!(
            "path is outside the allowed project directories: {}",
            path.display()
        ))
    }

    /// Resolve a path that must already exist.
    pub fn resolve_existing(&self, path: &str) -> Result<PathBuf, AetherError> {
        let requested = Path::new(path);
        let canonical = std::fs::canonicalize(requested)
            .map_err(|_| AetherError::InvalidInput(format!("no such path: {path}")))?;
        if !self.contains(&canonical) {
            return Err(Self::deny(requested));
        }
        Ok(canonical)
    }

    /// Resolve a path that may not exist yet (file creation). The *parent*
    /// must exist and live inside a root, which is what actually prevents
    /// writes from escaping the sandbox.
    pub fn resolve_new(&self, path: &str) -> Result<PathBuf, AetherError> {
        let requested = Path::new(path);
        let parent = requested.parent().ok_or_else(|| {
            AetherError::InvalidInput(format!("path has no parent directory: {path}"))
        })?;
        let file_name = requested.file_name().ok_or_else(|| {
            AetherError::InvalidInput(format!("path has no file name: {path}"))
        })?;
        // Reject names that would re-introduce traversal after the parent
        // has been canonicalized (e.g. a trailing "..").
        if file_name == std::ffi::OsStr::new("..") || file_name == std::ffi::OsStr::new(".") {
            return Err(Self::deny(requested));
        }
        let canonical_parent = std::fs::canonicalize(parent).map_err(|_| {
            AetherError::InvalidInput(format!("parent directory does not exist: {}", parent.display()))
        })?;
        if !self.contains(&canonical_parent) {
            return Err(Self::deny(requested));
        }
        Ok(canonical_parent.join(file_name))
    }

    fn contains(&self, canonical: &Path) -> bool {
        self.roots.iter().any(|root| canonical.starts_with(root))
    }

    /// List one directory level, directories first then files, each group
    /// sorted case-insensitively. Build/dependency directories are omitted.
    pub fn list_dir(&self, path: &str) -> Result<Vec<FsEntry>, AetherError> {
        let dir = self.resolve_existing(path)?;
        if !dir.is_dir() {
            return Err(AetherError::InvalidInput(format!(
                "not a directory: {}",
                dir.display()
            )));
        }

        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue, // broken symlink or a race with a delete
            };
            let is_dir = metadata.is_dir();
            if is_dir && IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            entries.push(FsEntry {
                name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
                size: if is_dir { 0 } else { metadata.len() },
            });
        }

        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub fn read_file(&self, path: &str) -> Result<String, AetherError> {
        let file = self.resolve_existing(path)?;
        let metadata = std::fs::metadata(&file)?;
        if metadata.is_dir() {
            return Err(AetherError::InvalidInput(format!(
                "cannot read a directory as text: {}",
                file.display()
            )));
        }
        if metadata.len() > MAX_EDITABLE_BYTES {
            return Err(AetherError::InvalidInput(format!(
                "file is too large to edit ({} bytes, limit {MAX_EDITABLE_BYTES})",
                metadata.len()
            )));
        }
        let bytes = std::fs::read(&file)?;
        // Refuse binaries outright instead of lossily decoding them: a
        // subsequent save would otherwise silently destroy the file.
        if bytes.contains(&0) {
            return Err(AetherError::InvalidInput(format!(
                "file appears to be binary: {}",
                file.display()
            )));
        }
        String::from_utf8(bytes).map_err(|_| {
            AetherError::InvalidInput(format!("file is not valid UTF-8: {}", file.display()))
        })
    }

    pub fn write_file(&self, path: &str, content: &str) -> Result<(), AetherError> {
        let file = self.resolve_existing(path)?;
        if file.is_dir() {
            return Err(AetherError::InvalidInput(format!(
                "cannot write over a directory: {}",
                file.display()
            )));
        }
        std::fs::write(&file, content)?;
        Ok(())
    }

    pub fn create_file(&self, path: &str, content: &str) -> Result<String, AetherError> {
        let file = self.resolve_new(path)?;
        if file.exists() {
            return Err(AetherError::InvalidInput(format!(
                "file already exists: {}",
                file.display()
            )));
        }
        std::fs::write(&file, content)?;
        Ok(file.to_string_lossy().to_string())
    }

    pub fn create_dir(&self, path: &str) -> Result<String, AetherError> {
        let dir = self.resolve_new(path)?;
        if dir.exists() {
            return Err(AetherError::InvalidInput(format!(
                "directory already exists: {}",
                dir.display()
            )));
        }
        std::fs::create_dir(&dir)?;
        Ok(dir.to_string_lossy().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{FsEntry, Workspace, MAX_EDITABLE_BYTES};
    use std::path::Path;

    fn write(path: &Path, content: &str) {
        std::fs::write(path, content).expect("fixture file must be written");
    }

    #[test]
    fn lists_directories_before_files_and_sorts_case_insensitively() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        std::fs::create_dir(root.path().join("src")).expect("dir must be created");
        std::fs::create_dir(root.path().join("Assets")).expect("dir must be created");
        write(&root.path().join("readme.md"), "hi");
        write(&root.path().join("Cargo.toml"), "[package]");

        let ws = Workspace::new([root.path()]);
        let entries = ws
            .list_dir(&root.path().to_string_lossy())
            .expect("listing must succeed");

        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Assets", "src", "Cargo.toml", "readme.md"]);
        assert!(entries[0].is_dir);
        assert!(!entries[2].is_dir);
    }

    #[test]
    fn hides_dependency_and_build_directories() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        for ignored in ["node_modules", "target", "dist", ".git"] {
            std::fs::create_dir(root.path().join(ignored)).expect("dir must be created");
        }
        std::fs::create_dir(root.path().join("src")).expect("dir must be created");

        let ws = Workspace::new([root.path()]);
        let entries = ws
            .list_dir(&root.path().to_string_lossy())
            .expect("listing must succeed");

        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["src"]
        );
    }

    #[test]
    fn reports_file_sizes_and_zero_for_directories() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        std::fs::create_dir(root.path().join("sub")).expect("dir must be created");
        write(&root.path().join("a.txt"), "12345");

        let ws = Workspace::new([root.path()]);
        let entries = ws
            .list_dir(&root.path().to_string_lossy())
            .expect("listing must succeed");

        let dir: &FsEntry = &entries[0];
        let file: &FsEntry = &entries[1];
        assert_eq!(dir.size, 0);
        assert_eq!(file.size, 5);
    }

    #[test]
    fn reads_and_writes_files_inside_a_root() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let file = root.path().join("main.rs");
        write(&file, "fn main() {}");

        let ws = Workspace::new([root.path()]);
        let path = file.to_string_lossy().to_string();
        assert_eq!(ws.read_file(&path).expect("read must succeed"), "fn main() {}");

        ws.write_file(&path, "fn main() { println!(); }")
            .expect("write must succeed");
        assert_eq!(
            std::fs::read_to_string(&file).expect("file must be readable"),
            "fn main() { println!(); }"
        );
    }

    #[test]
    fn rejects_reads_outside_every_root() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let outside = tempfile::tempdir().expect("temp dir must be created");
        let secret = outside.path().join("secret.txt");
        write(&secret, "classified");

        let ws = Workspace::new([root.path()]);
        let error = ws
            .read_file(&secret.to_string_lossy())
            .expect_err("reading outside the sandbox must fail");
        assert!(error.to_string().contains("outside the allowed"));
    }

    #[test]
    fn rejects_parent_directory_traversal() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let outside = tempfile::tempdir().expect("temp dir must be created");
        write(&outside.path().join("secret.txt"), "classified");

        let ws = Workspace::new([root.path()]);
        // Reach out of the root and back into a sibling directory.
        let traversal = format!(
            "{}/../{}/secret.txt",
            root.path().to_string_lossy(),
            outside
                .path()
                .file_name()
                .expect("temp dir has a name")
                .to_string_lossy()
        );
        assert!(ws.read_file(&traversal).is_err());
    }

    #[test]
    fn rejects_writes_outside_every_root() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let outside = tempfile::tempdir().expect("temp dir must be created");
        let target = outside.path().join("victim.txt");
        write(&target, "original");

        let ws = Workspace::new([root.path()]);
        assert!(ws.write_file(&target.to_string_lossy(), "overwritten").is_err());
        assert_eq!(
            std::fs::read_to_string(&target).expect("file must be readable"),
            "original"
        );
    }

    #[test]
    fn creates_files_only_inside_a_root() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let outside = tempfile::tempdir().expect("temp dir must be created");

        let ws = Workspace::new([root.path()]);

        let inside = root.path().join("new.txt");
        ws.create_file(&inside.to_string_lossy(), "hello")
            .expect("creating inside the sandbox must succeed");
        assert_eq!(
            std::fs::read_to_string(&inside).expect("file must be readable"),
            "hello"
        );

        let blocked = outside.path().join("new.txt");
        assert!(ws.create_file(&blocked.to_string_lossy(), "hello").is_err());
        assert!(!blocked.exists());
    }

    #[test]
    fn refuses_to_overwrite_an_existing_file_on_create() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let file = root.path().join("existing.txt");
        write(&file, "keep me");

        let ws = Workspace::new([root.path()]);
        assert!(ws.create_file(&file.to_string_lossy(), "clobber").is_err());
        assert_eq!(
            std::fs::read_to_string(&file).expect("file must be readable"),
            "keep me"
        );
    }

    #[test]
    fn creates_directories_inside_a_root() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let ws = Workspace::new([root.path()]);

        let dir = root.path().join("components");
        ws.create_dir(&dir.to_string_lossy())
            .expect("creating a directory must succeed");
        assert!(dir.is_dir());
    }

    #[test]
    fn refuses_binary_files() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let file = root.path().join("image.png");
        std::fs::write(&file, [0x89, 0x50, 0x00, 0x1a]).expect("fixture must be written");

        let ws = Workspace::new([root.path()]);
        let error = ws
            .read_file(&file.to_string_lossy())
            .expect_err("binary files must be refused");
        assert!(error.to_string().contains("binary"));
    }

    #[test]
    fn refuses_files_above_the_size_limit() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let file = root.path().join("huge.log");
        let oversized = "a".repeat((MAX_EDITABLE_BYTES + 1) as usize);
        write(&file, &oversized);

        let ws = Workspace::new([root.path()]);
        let error = ws
            .read_file(&file.to_string_lossy())
            .expect_err("oversized files must be refused");
        assert!(error.to_string().contains("too large"));
    }

    #[test]
    fn supports_multiple_roots() {
        let a = tempfile::tempdir().expect("temp dir must be created");
        let b = tempfile::tempdir().expect("temp dir must be created");
        write(&a.path().join("a.txt"), "from a");
        write(&b.path().join("b.txt"), "from b");

        let ws = Workspace::new([a.path(), b.path()]);
        assert_eq!(
            ws.read_file(&a.path().join("a.txt").to_string_lossy())
                .expect("root a must be readable"),
            "from a"
        );
        assert_eq!(
            ws.read_file(&b.path().join("b.txt").to_string_lossy())
                .expect("root b must be readable"),
            "from b"
        );
    }

    #[test]
    fn drops_roots_that_do_not_exist() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let ws = Workspace::new([root.path().to_string_lossy().to_string(), "/nope/missing".to_owned()]);
        assert_eq!(ws.roots().len(), 1);
    }

    #[test]
    fn a_workspace_without_roots_denies_everything() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        write(&root.path().join("a.txt"), "hi");

        let ws = Workspace::new(Vec::<String>::new());
        assert!(ws.read_file(&root.path().join("a.txt").to_string_lossy()).is_err());
        assert!(ws.list_dir(&root.path().to_string_lossy()).is_err());
    }

    #[test]
    fn listing_a_file_is_an_error() {
        let root = tempfile::tempdir().expect("temp dir must be created");
        let file = root.path().join("a.txt");
        write(&file, "hi");

        let ws = Workspace::new([root.path()]);
        assert!(ws.list_dir(&file.to_string_lossy()).is_err());
    }
}
