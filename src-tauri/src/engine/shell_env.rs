//! Start-up environment fixes for GUI launches.
//!
//! Apps opened from Finder, the Dock, Spotlight or a Linux desktop menu do
//! not inherit the `PATH` the user's shell profile builds: macOS hands them
//! launchd's `/usr/bin:/bin:/usr/sbin:/sbin`. Language servers, the `git`
//! CLI, `npx`, the terminal and the agent's `run_command` would then miss
//! everything in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin`,
//! nvm, … even though the same app works when started from a terminal.
//!
//! [`fix_gui_path`] runs once, first thing in `run()` (before any thread
//! exists, so `set_var` cannot race a reader). When the inherited `PATH`
//! only holds system folders it asks the user's login shell for its `PATH`
//! (`$SHELL -i -l -c 'printf … "$PATH"'`, 3 s timeout, every failure
//! ignored) and merges it with the inherited one and common tool folders
//! that exist ([`merge_paths`]). Windows GUI apps already get the full
//! `PATH` from the registry, so nothing changes there.
//!
//! The pure helpers ([`looks_minimal`], [`extract_marked_path`],
//! [`merge_paths`], [`fallback_dirs`]) work on Unix `PATH` syntax (`:`) on
//! every platform so they are tested everywhere.

// Only Unix merges PATH; on Windows the pure helpers are exercised by the
// tests alone.
#![cfg_attr(not(unix), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// How long the login shell may take to print its `PATH`.
pub const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(3);
/// Set for the login shell, so heavy rc-file sections can be skipped with
/// `[ -n "$AETHER_RESOLVING_ENVIRONMENT" ] && return`.
pub const RESOLVING_ENV_VAR: &str = "AETHER_RESOLVING_ENVIRONMENT";

const START_MARKER: &str = "__AETHER_PATH_START__";
const END_MARKER: &str = "__AETHER_PATH_END__";
/// Upper bound for the login shell's captured stdout.
const MAX_SHELL_OUTPUT: usize = 256 * 1024;

/// What start-up did to the environment (logged once diagnostics exist).
static SUMMARY: OnceLock<String> = OnceLock::new();

/// One line describing what [`fix_gui_path`] did, for the app log.
pub fn summary() -> Option<&'static str> {
    SUMMARY.get().map(String::as_str)
}

/// Folders every Unix `PATH` has, plus the macOS system and cryptex
/// folders launchd adds. A `PATH` made only of these is what GUI launches
/// get; a terminal's `PATH` almost always has more.
pub fn is_system_dir(dir: &str) -> bool {
    const SYSTEM_DIRS: &[&str] = &[
        "/bin",
        "/sbin",
        "/usr/bin",
        "/usr/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/games",
        "/usr/local/games",
        "/usr/libexec",
        "/snap/bin",
    ];
    const SYSTEM_PREFIXES: &[&str] = &[
        "/System/",
        "/Library/Apple/",
        "/var/run/com.apple.security.cryptexd/",
    ];
    let dir = normalize(dir);
    SYSTEM_DIRS.contains(&dir) || SYSTEM_PREFIXES.iter().any(|p| dir.starts_with(p))
}

/// `true` when `path` (Unix syntax) is empty or only lists system folders —
/// the signature of a GUI launch that never saw the user's shell profile.
pub fn looks_minimal(path: &str) -> bool {
    path.split(':')
        .filter(|entry| !entry.trim().is_empty())
        .all(is_system_dir)
}

/// The `PATH` printed between the markers by the login-shell command. rc
/// files may print banners before or after it; only the last marked value
/// counts. `None` when the markers are missing or the value is blank.
pub fn extract_marked_path(stdout: &str) -> Option<String> {
    let start = stdout.rfind(START_MARKER)? + START_MARKER.len();
    let rest = &stdout[start..];
    let end = rest.find(END_MARKER)?;
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// Merge the login shell's `PATH`, the inherited `PATH` and fallback
/// folders (all Unix syntax) into one `PATH`:
///
/// 1. the login shell's entries, in their order — that is the `PATH` the
///    user's terminal has, so tools resolve to the same binaries there and
///    in the app (nvm's `node` before a system `node`);
/// 2. inherited entries the login shell did not list, in their order;
/// 3. fallbacks not listed yet, in their order.
///
/// Duplicates (also `dir` vs `dir/`), blank entries and relative entries
/// (which would resolve against the app's working directory) are dropped.
pub fn merge_paths(login: Option<&str>, current: &str, fallbacks: &[String]) -> String {
    let mut merged: Vec<&str> = Vec::new();
    let sources = login
        .into_iter()
        .flat_map(|p| p.split(':'))
        .chain(current.split(':'))
        .chain(fallbacks.iter().map(String::as_str));
    for entry in sources {
        let entry = normalize(entry.trim());
        if !entry.starts_with('/') || merged.contains(&entry) {
            continue;
        }
        merged.push(entry);
    }
    merged.join(":")
}

/// Common per-user and package-manager tool folders, best first. The
/// caller keeps the ones that exist. `home` is the user's home folder.
pub fn fallback_dirs(home: Option<&Path>, macos: bool) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if macos {
        dirs.extend(
            [
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/usr/local/sbin",
                "/opt/local/bin",
            ]
            .map(PathBuf::from),
        );
    } else {
        dirs.extend(
            [
                "/usr/local/bin",
                "/usr/local/sbin",
                "/home/linuxbrew/.linuxbrew/bin",
                "/snap/bin",
                "/usr/local/go/bin",
            ]
            .map(PathBuf::from),
        );
    }
    if let Some(home) = home {
        for rel in [
            ".cargo/bin",
            ".local/bin",
            "bin",
            ".volta/bin",
            ".bun/bin",
            ".deno/bin",
            "go/bin",
            ".nix-profile/bin",
        ] {
            dirs.push(home.join(rel));
        }
        if !macos {
            dirs.push(home.join(".linuxbrew/bin"));
        }
    }
    dirs.push(PathBuf::from("/nix/var/nix/profiles/default/bin"));
    dirs.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from));
    dirs
}

/// The highest `vX.Y.Z` folder name (nvm's `versions/node/<name>`).
pub fn latest_node_version<'a>(names: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    fn parse(name: &str) -> Option<(u64, u64, u64)> {
        let mut parts = name.strip_prefix('v')?.splitn(3, '.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        Some((major, minor, patch))
    }
    names
        .into_iter()
        .filter_map(|name| parse(name).map(|v| (v, name)))
        .max_by_key(|(v, _)| *v)
        .map(|(_, name)| name)
}

/// `dir` without trailing slashes (`/` stays `/`).
fn normalize(dir: &str) -> &str {
    let trimmed = dir.trim_end_matches('/');
    if trimmed.is_empty() && dir.starts_with('/') {
        "/"
    } else {
        trimmed
    }
}

/// The user's login shell: `$SHELL`, else the password database entry.
/// `None` on Windows or when neither names an existing file.
pub fn user_shell() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let from_env = std::env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && p.is_file());
        from_env.or_else(passwd_shell)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// The shell for new terminal tabs: the user's shell, else the first of
/// zsh / bash / sh that exists (PowerShell on Windows).
pub fn default_terminal_shell() -> String {
    if cfg!(windows) {
        return "powershell.exe".to_owned();
    }
    if let Some(shell) = user_shell() {
        return shell.to_string_lossy().into_owned();
    }
    ["/bin/zsh", "/bin/bash", "/usr/bin/bash", "/bin/sh"]
        .into_iter()
        .find(|p| Path::new(p).is_file())
        .unwrap_or("/bin/sh")
        .to_owned()
}

/// The user's home folder (`HOME`, `USERPROFILE` on Windows).
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|h| !h.is_empty()))
        .map(PathBuf::from)
}

#[cfg(unix)]
fn passwd_shell() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;

    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: `pwd` is zero-initialised plain data; `getpwuid_r` fills it
    // with pointers into `buf`, which outlives every read below.
    unsafe {
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let rc = libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        );
        if rc != 0 || result.is_null() || pwd.pw_shell.is_null() {
            return None;
        }
        let bytes = CStr::from_ptr(pwd.pw_shell).to_bytes();
        let path = PathBuf::from(std::ffi::OsStr::from_bytes(bytes));
        (path.is_absolute() && path.is_file()).then_some(path)
    }
}

/// Ask `shell` for its login `PATH`. Runs `shell -i -l -c 'printf …'` with
/// stdin closed and stderr discarded, in its own process group (killed
/// with everything it started when `timeout` expires). `None` on any
/// failure — the caller falls back to the inherited `PATH`.
#[cfg(unix)]
pub fn read_login_shell_path(shell: &Path, timeout: Duration) -> Option<String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let script = format!("printf '{START_MARKER}%s{END_MARKER}' \"$PATH\"");
    let mut child = Command::new(shell)
        .args(["-i", "-l", "-c", &script])
        .env(RESOLVING_ENV_VAR, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let pid = child.id();
    let deadline = Instant::now() + timeout;

    let (tx, rx) = std::sync::mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        // Not joined: after a timeout a daemon started by an rc file may
        // keep the pipe open forever; the thread then just stays blocked.
        let _ = std::thread::Builder::new()
            .name("aether-login-path".into())
            .spawn(move || {
                let mut out = Vec::new();
                let mut chunk = [0u8; 8192];
                while let Ok(n) = stdout.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    if out.len() < MAX_SHELL_OUTPUT {
                        out.extend_from_slice(&chunk[..n]);
                    }
                }
                let _ = tx.send(out);
            });
    }

    let output = rx.recv_timeout(timeout).ok();
    // Reap the shell; kill its whole group if it is still around at the
    // deadline (the pid cannot be reused before `wait` reaps it).
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                // SAFETY: `killpg` has no memory-safety preconditions; the
                // group was created for this child by `process_group(0)`.
                unsafe {
                    libc::killpg(pid as libc::pid_t, libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    let stdout = String::from_utf8_lossy(&output?).into_owned();
    extract_marked_path(&stdout)
}

/// Fallback folders that exist on this machine, plus the newest nvm node.
#[cfg(unix)]
fn existing_fallbacks(home: Option<&Path>) -> Vec<String> {
    let mut dirs = fallback_dirs(home, cfg!(target_os = "macos"));
    if let Some(home) = home {
        let nvm_dir = std::env::var_os("NVM_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".nvm"));
        let versions = nvm_dir.join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&versions) {
            let names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            if let Some(latest) = latest_node_version(names.iter().map(String::as_str)) {
                dirs.insert(0, versions.join(latest).join("bin"));
            }
        }
    }
    dirs.into_iter()
        .filter(|d| d.is_dir())
        .map(|d| d.to_string_lossy().into_owned())
        .collect()
}

/// Give a GUI-launched app the user's shell `PATH` (see the module docs).
/// Call once at the very start of `run()`, before any thread is spawned.
pub fn fix_gui_path() {
    let summary = fix_gui_path_inner();
    let _ = SUMMARY.set(summary);
}

#[cfg(unix)]
fn fix_gui_path_inner() -> String {
    use std::time::Instant;

    let current = std::env::var("PATH").unwrap_or_default();
    if !looks_minimal(&current) {
        return "PATH: inherited PATH kept (started from a shell)".to_owned();
    }
    let started = Instant::now();
    let shell = user_shell();
    let login = shell
        .as_deref()
        .and_then(|s| read_login_shell_path(s, LOGIN_SHELL_TIMEOUT));
    let home = home_dir();
    let merged = merge_paths(
        login.as_deref(),
        &current,
        &existing_fallbacks(home.as_deref()),
    );
    let before = current.split(':').filter(|e| !e.is_empty()).count();
    let after = merged.split(':').count();
    if merged != current {
        // Single-threaded at this point (see `fix_gui_path`).
        std::env::set_var("PATH", &merged);
    }
    let source = match (&shell, &login) {
        (Some(shell), Some(_)) => format!("login shell {}", shell.display()),
        (Some(shell), None) => format!(
            "fallback folders (login shell {} gave no PATH)",
            shell.display()
        ),
        (None, _) => "fallback folders (no login shell found)".to_owned(),
    };
    format!(
        "PATH: minimal GUI PATH ({before} entries) extended to {after} entries from {source} in {} ms",
        started.elapsed().as_millis()
    )
}

#[cfg(not(unix))]
fn fix_gui_path_inner() -> String {
    "PATH: unchanged (Windows apps inherit the full PATH)".to_owned()
}

/// Linux: WebKitGTK's DMA-BUF renderer shows a blank window with the
/// proprietary NVIDIA driver (notably on Wayland). Unless the user chose a
/// value, it is switched off when that driver is loaded. Call right after
/// [`fix_gui_path`], still before any thread exists.
pub fn apply_webkit_workarounds() {
    #[cfg(target_os = "linux")]
    {
        const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
        if std::env::var_os(VAR).is_none() && Path::new("/proc/driver/nvidia/version").exists() {
            std::env::set_var(VAR, "1");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gui_paths_are_minimal_terminal_paths_are_not() {
        // macOS launchd, with and without the cryptex folders.
        assert!(looks_minimal("/usr/bin:/bin:/usr/sbin:/sbin"));
        assert!(looks_minimal(
            "/usr/bin:/bin:/usr/sbin:/sbin:/System/Cryptexes/App/usr/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:/Library/Apple/usr/bin"
        ));
        // A typical Linux desktop session.
        assert!(looks_minimal(
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"
        ));
        assert!(looks_minimal(""));
        assert!(looks_minimal("/usr/bin/::/bin/"));
        // Terminals add Homebrew, per-user or version-manager folders.
        assert!(!looks_minimal("/opt/homebrew/bin:/usr/bin:/bin"));
        assert!(!looks_minimal("/Users/me/.cargo/bin:/usr/bin:/bin"));
        assert!(!looks_minimal(
            "/home/me/.nvm/versions/node/v22.1.0/bin:/usr/local/bin:/usr/bin"
        ));
    }

    #[test]
    fn marked_path_ignores_banners_and_needs_both_markers() {
        let out = format!("Welcome!\n{START_MARKER}/a/bin:/b/bin{END_MARKER}\nbye\n");
        assert_eq!(extract_marked_path(&out).as_deref(), Some("/a/bin:/b/bin"));
        // An rc file that echoes the command itself: the last value wins.
        let twice = format!("{START_MARKER}junk{END_MARKER}{START_MARKER}/x{END_MARKER}");
        assert_eq!(extract_marked_path(&twice).as_deref(), Some("/x"));
        assert_eq!(extract_marked_path("/usr/bin:/bin"), None);
        assert_eq!(extract_marked_path(&format!("{START_MARKER}/a")), None);
        assert_eq!(
            extract_marked_path(&format!("{START_MARKER}  {END_MARKER}")),
            None
        );
    }

    #[test]
    fn merge_puts_the_login_path_first_and_keeps_both_orders() {
        let merged = merge_paths(
            Some("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"),
            "/usr/bin:/bin:/usr/sbin:/sbin",
            &[
                "/Users/me/.cargo/bin".to_owned(),
                "/usr/local/bin".to_owned(),
            ],
        );
        assert_eq!(
            merged,
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.cargo/bin"
        );
    }

    #[test]
    fn merge_without_a_login_path_keeps_the_current_order_then_fallbacks() {
        let merged = merge_paths(
            None,
            "/usr/bin:/bin",
            &["/opt/homebrew/bin".to_owned(), "/bin".to_owned()],
        );
        assert_eq!(merged, "/usr/bin:/bin:/opt/homebrew/bin");
    }

    #[test]
    fn merge_drops_duplicates_blanks_and_relative_entries() {
        let merged = merge_paths(
            Some("/a/bin/::.:bin:/a/bin: /b "),
            "/b/:/c//:",
            &["relative".to_owned(), "/c".to_owned(), "/".to_owned()],
        );
        assert_eq!(merged, "/a/bin:/b:/c:/");
        assert_eq!(merge_paths(None, "", &[]), "");
    }

    #[test]
    fn fallbacks_cover_homebrew_cargo_and_the_system() {
        let home = Path::new("/Users/me");
        let mac = fallback_dirs(Some(home), true);
        assert_eq!(mac[0], PathBuf::from("/opt/homebrew/bin"));
        assert!(mac.contains(&PathBuf::from("/usr/local/bin")));
        assert!(mac.contains(&home.join(".cargo/bin")));
        assert!(mac.contains(&home.join(".local/bin")));
        assert!(mac.contains(&PathBuf::from("/usr/bin")));

        let linux = fallback_dirs(Some(Path::new("/home/me")), false);
        assert!(!linux.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(linux.contains(&PathBuf::from("/home/linuxbrew/.linuxbrew/bin")));
        assert!(linux.contains(&PathBuf::from("/home/me/.cargo/bin")));
        assert!(!fallback_dirs(None, false).is_empty());
    }

    #[test]
    fn newest_nvm_node_is_picked_numerically() {
        let names = [
            "v9.11.2", "v18.20.4", "v22.3.0", "v22.10.1", "default", "v20",
        ];
        assert_eq!(latest_node_version(names), Some("v22.10.1"));
        assert_eq!(latest_node_version(["system", "lts"]), None);
    }

    #[test]
    fn system_dirs_ignore_trailing_slashes() {
        assert!(is_system_dir("/usr/bin/"));
        assert!(is_system_dir("/System/Cryptexes/App/usr/bin"));
        assert!(!is_system_dir("/opt/homebrew/bin"));
        assert!(!is_system_dir("/usr/bin/../../tmp/evil"));
    }

    #[test]
    fn a_terminal_shell_is_always_chosen() {
        let shell = default_terminal_shell();
        assert!(!shell.is_empty());
        if cfg!(unix) {
            assert!(Path::new(&shell).is_absolute(), "{shell}");
        }
    }

    #[cfg(unix)]
    mod unix {
        use super::super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;

        fn fake_shell(dir: &Path, body: &str) -> PathBuf {
            let path = dir.join("fake-shell");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write shell");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            path
        }

        #[test]
        fn reads_the_path_a_shell_prints_between_banners() {
            let dir = tempfile::tempdir().expect("tempdir");
            // The fake shell ignores `-i -l -c` and prints like a noisy rc.
            let shell = fake_shell(
                dir.path(),
                &format!(
                    "echo 'motd'\nprintf '{START_MARKER}/opt/tool/bin:/usr/bin{END_MARKER}'\necho done"
                ),
            );
            assert_eq!(
                read_login_shell_path(&shell, Duration::from_secs(3)).as_deref(),
                Some("/opt/tool/bin:/usr/bin")
            );
        }

        #[test]
        fn a_real_posix_shell_reports_its_path() {
            let path = read_login_shell_path(Path::new("/bin/sh"), Duration::from_secs(5));
            // `sh -i -l -c` works on every Unix; PATH is never empty there.
            let path = path.expect("sh prints its PATH");
            assert!(path.contains('/'), "{path}");
        }

        #[test]
        fn a_hanging_shell_is_killed_at_the_timeout() {
            let dir = tempfile::tempdir().expect("tempdir");
            // A background child keeps the pipe open after the shell.
            let shell = fake_shell(dir.path(), "sleep 30 &\nsleep 30");
            let started = Instant::now();
            assert_eq!(
                read_login_shell_path(&shell, Duration::from_millis(400)),
                None
            );
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "took {:?}",
                started.elapsed()
            );
        }

        #[test]
        fn missing_or_silent_shells_give_nothing() {
            let dir = tempfile::tempdir().expect("tempdir");
            assert_eq!(
                read_login_shell_path(&dir.path().join("nope"), Duration::from_secs(1)),
                None
            );
            let silent = fake_shell(dir.path(), "exit 3");
            assert_eq!(read_login_shell_path(&silent, Duration::from_secs(2)), None);
        }
    }
}
