//! Shell execution for the agent's `run_command` action.
//!
//! Commands run through `sh -lc` (login shell, so the user's `PATH` from
//! their profile applies; `cmd /C` on Windows) with stdin closed, a working
//! directory that must resolve inside the allowed roots (project folders +
//! vault), captured and size-capped stdout/stderr, and a hard timeout. On
//! Unix the command gets its own process group, so a timeout kills the whole
//! tree — `sh` and everything it started — instead of leaving orphans behind.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::engine::error::AetherError;

/// Default timeout of an agent command.
pub const DEFAULT_TIMEOUT_SECS: u64 = 60;
/// Per-stream capture limit; the rest is drained and discarded.
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// How long to wait for output pipes after the shell exited before the
/// process group (background children holding the pipes) is killed.
const PIPE_GRACE: Duration = Duration::from_secs(2);
/// `PATH` used when the app itself was started without one.
const DEFAULT_PATH: &str = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
/// Appended to a stream that exceeded [`MAX_OUTPUT_BYTES`].
pub const TRUNCATION_MARKER: &str = "\n[… output truncated at 64 KiB]";

/// The complete environment of an agent command: `PATH`, `HOME`, `LANG`,
/// `TERM` and the `AETHER_AGENT=1` marker. Nothing else is inherited from
/// the app, so API keys or tokens in the app's environment never reach a
/// model-proposed command. (A login shell still reads the user's profile.)
pub fn agent_env() -> Vec<(&'static str, String)> {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let mut env = vec![
        (
            "PATH",
            var("PATH").unwrap_or_else(|| DEFAULT_PATH.to_owned()),
        ),
        (
            "LANG",
            var("LANG").unwrap_or_else(|| "en_US.UTF-8".to_owned()),
        ),
        ("TERM", var("TERM").unwrap_or_else(|| "dumb".to_owned())),
        ("AETHER_AGENT", "1".to_owned()),
    ];
    if let Some(home) = var("HOME") {
        env.push(("HOME", home));
    }
    // `cmd.exe` cannot start without its system variables.
    #[cfg(windows)]
    for name in [
        "SystemRoot",
        "ComSpec",
        "PATHEXT",
        "USERPROFILE",
        "TEMP",
        "TMP",
    ] {
        if let Some(value) = var(name) {
            env.push((name, value));
        }
    }
    env
}

/// Result of a finished (or timed-out) command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandOutput {
    pub command: String,
    /// Canonical working directory the command ran in.
    pub cwd: String,
    /// `None` when the command was killed (timeout or signal).
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u64,
    /// At least one stream exceeded [`MAX_OUTPUT_BYTES`].
    pub truncated: bool,
}

impl CommandOutput {
    /// True when the command exited with status 0.
    pub fn succeeded(&self) -> bool {
        self.exit_code == Some(0) && !self.timed_out
    }
}

/// Resolve the working directory: `None`/empty → the vault root; relative
/// paths are resolved against the vault; `~/` expands to `$HOME`. The
/// canonical result must be a directory inside one of `roots` (which must
/// themselves be canonical, as produced by `Workspace::roots`).
pub fn resolve_cwd(
    roots: &[PathBuf],
    vault_root: Option<&Path>,
    requested: Option<&str>,
) -> Result<PathBuf, AetherError> {
    let requested = requested.map(str::trim).filter(|r| !r.is_empty());
    let candidate = match requested {
        None => vault_root.map(Path::to_path_buf).ok_or_else(|| {
            AetherError::InvalidInput(
                "no vault is configured; give the command a cwd inside a project directory"
                    .to_owned(),
            )
        })?,
        Some(dir) => {
            if let Some(rest) = dir.strip_prefix("~/") {
                let home = std::env::var("HOME").map_err(|_| {
                    AetherError::InvalidInput("cannot expand ~: HOME is not set".to_owned())
                })?;
                Path::new(&home).join(rest)
            } else if Path::new(dir).is_absolute() {
                PathBuf::from(dir)
            } else {
                vault_root
                    .ok_or_else(|| {
                        AetherError::InvalidInput(format!(
                            "relative cwd \"{dir}\" needs a configured vault; use an absolute path"
                        ))
                    })?
                    .join(dir)
            }
        }
    };
    let canonical = std::fs::canonicalize(&candidate).map_err(|_| {
        AetherError::InvalidInput(format!(
            "working directory does not exist: {}",
            candidate.display()
        ))
    })?;
    if !canonical.is_dir() {
        return Err(AetherError::InvalidInput(format!(
            "working directory is not a directory: {}",
            canonical.display()
        )));
    }
    if !roots.iter().any(|root| canonical.starts_with(root)) {
        return Err(AetherError::InvalidInput(format!(
            "working directory is outside the project directories and the vault: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

/// Heuristic warnings shown in the approval dialog for commands that can
/// destroy data or escalate privileges. Never a substitute for reading the
/// command — just a second pair of eyes.
pub fn command_warnings(command: &str) -> Vec<String> {
    let lower = command.to_lowercase();
    let compact: String = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = Vec::new();
    let mut warn = |cond: bool, text: &str| {
        if cond && !out.iter().any(|w: &String| w == text) {
            out.push(text.to_owned());
        }
    };
    let rm_recursive = compact.split(['|', ';', '&']).any(|part| {
        let words: Vec<&str> = part.split_whitespace().collect();
        words
            .first()
            .is_some_and(|w| *w == "rm" || w.ends_with("/rm"))
            && words.iter().skip(1).any(|w| {
                (w.starts_with('-') && !w.starts_with("--") && (w.contains('r') || w.contains('f')))
                    || *w == "--recursive"
                    || *w == "--force"
            })
    });
    warn(
        rm_recursive,
        "Deletes files recursively or without confirmation (rm -r / -f).",
    );
    warn(
        compact.starts_with("sudo ") || compact.contains(" sudo ") || compact.contains("|sudo"),
        "Runs with administrator privileges (sudo).",
    );
    warn(
        compact.contains("git push") && (compact.contains("--force") || compact.contains(" -f")),
        "Force-pushes and can overwrite remote history.",
    );
    warn(
        compact.contains("git reset --hard") || compact.contains("git clean -"),
        "Discards uncommitted changes in the repository.",
    );
    warn(
        (compact.contains("curl ") || compact.contains("wget "))
            && (compact.contains("| sh")
                || compact.contains("| bash")
                || compact.contains("|sh")
                || compact.contains("|bash")),
        "Downloads and executes a remote script.",
    );
    warn(
        compact.contains("mkfs")
            || compact.contains("dd if=")
            || compact.contains("diskutil erase"),
        "Writes directly to a disk or formats it.",
    );
    warn(
        compact.contains("chmod -r") || compact.contains("chown -r"),
        "Changes permissions or ownership recursively.",
    );
    warn(
        compact.contains("shutdown") || compact.contains("reboot") || compact.contains("killall"),
        "Stops processes or the whole system.",
    );
    warn(compact.contains(":(){"), "Looks like a fork bomb.");
    warn(
        compact.contains("> /dev/") && !compact.contains("> /dev/null"),
        "Writes to a device file.",
    );
    out
}

#[cfg(unix)]
fn shell_command(command: &str, login: bool) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg(if login { "-lc" } else { "-c" }).arg(command);
    // Own process group: a timeout can then kill the whole tree.
    cmd.process_group(0);
    cmd
}

#[cfg(windows)]
fn shell_command(command: &str, _login: bool) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("cmd");
    cmd.arg("/C").arg(command);
    cmd
}

/// Kill the command's process group (Unix) and the process itself. `pid`
/// is captured at spawn time: after the shell has been reaped `Child::id`
/// returns `None`, but its group lives on while any member does (and POSIX
/// never hands out a pid that is still in use as a group id).
fn kill_tree(pid: Option<u32>, child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // SAFETY: `killpg` has no memory-safety preconditions; the pid is
        // the group leader we spawned with `process_group(0)`.
        unsafe {
            libc::killpg(pid as libc::pid_t, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    let _ = child.start_kill();
}

/// Read a stream to the end, keeping at most `cap` bytes.
async fn read_capped<R: AsyncRead + Unpin>(mut reader: R, cap: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = cap.saturating_sub(buf.len());
                if room > 0 {
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
                if n > room {
                    truncated = true;
                }
            }
        }
    }
    (buf, truncated)
}

type Reader = tokio::task::JoinHandle<(Vec<u8>, bool)>;

fn spawn_reader<R: AsyncRead + Unpin + Send + 'static>(stream: Option<R>) -> Option<Reader> {
    stream.map(|s| tokio::spawn(read_capped(s, MAX_OUTPUT_BYTES)))
}

async fn collect(reader: Option<Reader>) -> (String, bool) {
    match reader {
        Some(handle) => match handle.await {
            Ok((bytes, truncated)) => {
                let mut text = String::from_utf8_lossy(&bytes).into_owned();
                if truncated {
                    text.push_str(TRUNCATION_MARKER);
                }
                (text, truncated)
            }
            Err(_) => (String::new(), false),
        },
        None => (String::new(), false),
    }
}

/// Run `command` through a login shell (`sh -lc`) in `cwd` (already
/// resolved with [`resolve_cwd`]) and wait at most `timeout`. A non-zero
/// exit is not an error — the output is returned so the user sees what
/// happened; only a failure to start the shell is.
pub async fn run_shell(
    command: &str,
    cwd: &Path,
    timeout: Duration,
) -> Result<CommandOutput, AetherError> {
    run_shell_with(command, cwd, timeout, true).await
}

/// [`run_shell`] with the login-shell flag exposed (tests use a plain
/// `sh -c` so the user's profile cannot change their output).
async fn run_shell_with(
    command: &str,
    cwd: &Path,
    timeout: Duration,
    login: bool,
) -> Result<CommandOutput, AetherError> {
    let command = command.trim();
    if command.is_empty() {
        return Err(AetherError::InvalidInput(
            "command must not be empty".to_owned(),
        ));
    }
    let mut cmd = shell_command(command, login);
    cmd.current_dir(cwd)
        .env_clear()
        .envs(agent_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let started = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| AetherError::InvalidInput(format!("failed to start the shell: {e}")))?;
    let pid = child.id();
    let stdout = spawn_reader(child.stdout.take());
    let stderr = spawn_reader(child.stderr.take());

    let (exit_code, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(error)) => {
            kill_tree(pid, &mut child);
            return Err(AetherError::Io(error));
        }
        Err(_) => {
            kill_tree(pid, &mut child);
            let _ = child.wait().await;
            (None, true)
        }
    };

    // Background children may still hold the pipes open; give them a moment,
    // then kill the group so the readers see EOF.
    let readers = async { (collect(stdout).await, collect(stderr).await) };
    tokio::pin!(readers);
    let ((stdout, out_truncated), (stderr, err_truncated)) =
        match tokio::time::timeout(PIPE_GRACE, &mut readers).await {
            Ok(output) => output,
            Err(_) => {
                kill_tree(pid, &mut child);
                match tokio::time::timeout(PIPE_GRACE, &mut readers).await {
                    Ok(output) => output,
                    // A detached daemon kept the pipes: give up on the output.
                    Err(_) => ((String::new(), true), (String::new(), true)),
                }
            }
        };

    Ok(CommandOutput {
        command: command.to_owned(),
        cwd: cwd.to_string_lossy().into_owned(),
        exit_code,
        stdout,
        stderr,
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
        truncated: out_truncated || err_truncated,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn canonical(dir: &tempfile::TempDir) -> PathBuf {
        std::fs::canonicalize(dir.path()).expect("canonicalize")
    }

    #[test]
    fn resolves_the_default_relative_and_absolute_cwd() {
        let vault = tempfile::tempdir().expect("vault");
        let project = tempfile::tempdir().expect("project");
        std::fs::create_dir(vault.path().join("daily")).expect("mkdir");
        let roots = vec![canonical(&vault), canonical(&project)];
        let vault_root = canonical(&vault);

        assert_eq!(
            resolve_cwd(&roots, Some(&vault_root), None).expect("default"),
            vault_root
        );
        assert_eq!(
            resolve_cwd(&roots, Some(&vault_root), Some("  ")).expect("blank"),
            vault_root
        );
        assert_eq!(
            resolve_cwd(&roots, Some(&vault_root), Some("daily")).expect("relative"),
            vault_root.join("daily")
        );
        assert_eq!(
            resolve_cwd(
                &roots,
                Some(&vault_root),
                Some(project.path().to_str().unwrap())
            )
            .expect("absolute"),
            canonical(&project)
        );
    }

    #[test]
    fn rejects_cwds_outside_the_roots_or_missing() {
        let vault = tempfile::tempdir().expect("vault");
        let outside = tempfile::tempdir().expect("outside");
        let roots = vec![canonical(&vault)];
        let vault_root = canonical(&vault);
        let err = resolve_cwd(
            &roots,
            Some(&vault_root),
            Some(outside.path().to_str().unwrap()),
        )
        .expect_err("outside");
        assert!(err.to_string().contains("outside"));
        assert!(resolve_cwd(&roots, Some(&vault_root), Some("../")).is_err());
        assert!(resolve_cwd(&roots, Some(&vault_root), Some("missing-dir")).is_err());
        assert!(resolve_cwd(&roots, None, None).is_err());
        std::fs::write(vault.path().join("file.md"), "x").expect("write");
        assert!(resolve_cwd(&roots, Some(&vault_root), Some("file.md")).is_err());
    }

    #[tokio::test]
    async fn captures_stdout_stderr_and_exit_code() {
        let dir = tempfile::tempdir().expect("dir");
        let cwd = canonical(&dir);
        let out = run_shell_with(
            "echo hello; echo oops >&2; pwd; exit 3",
            &cwd,
            Duration::from_secs(10),
            false,
        )
        .await
        .expect("run");
        assert_eq!(out.exit_code, Some(3));
        assert!(!out.timed_out);
        assert!(!out.succeeded());
        assert!(out.stdout.starts_with("hello\n"));
        assert!(out.stdout.contains(cwd.to_str().unwrap()));
        assert_eq!(out.stderr.trim(), "oops");
        assert_eq!(out.cwd, cwd.to_string_lossy());

        // The public entry point uses a login shell.
        let ok = run_shell("true", &cwd, Duration::from_secs(30))
            .await
            .expect("run");
        assert!(ok.succeeded());
    }

    #[tokio::test]
    async fn marks_the_agent_environment() {
        let dir = tempfile::tempdir().expect("dir");
        let out = run_shell_with(
            "echo $AETHER_AGENT",
            &canonical(&dir),
            Duration::from_secs(10),
            false,
        )
        .await
        .expect("run");
        assert_eq!(out.stdout.trim(), "1");
    }

    #[tokio::test]
    async fn times_out_and_kills_the_process_group() {
        let dir = tempfile::tempdir().expect("dir");
        let started = Instant::now();
        let out = run_shell_with(
            "echo started; sleep 30; echo never",
            &canonical(&dir),
            Duration::from_millis(400),
            false,
        )
        .await
        .expect("run");
        assert!(out.timed_out);
        assert_eq!(out.exit_code, None);
        assert!(out.stdout.contains("started"));
        assert!(!out.stdout.contains("never"));
        // The sleeping grandchild must not keep the call alive.
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn caps_huge_output() {
        let dir = tempfile::tempdir().expect("dir");
        let out = run_shell_with(
            "head -c 200000 /dev/zero | tr '\\0' 'a'",
            &canonical(&dir),
            Duration::from_secs(20),
            false,
        )
        .await
        .expect("run");
        assert!(out.truncated);
        assert!(out.stdout.ends_with(TRUNCATION_MARKER));
        let kept = out.stdout.strip_suffix(TRUNCATION_MARKER).unwrap();
        assert_eq!(kept.len(), MAX_OUTPUT_BYTES);
        assert!(kept.bytes().all(|b| b == b'a'));
    }

    #[tokio::test]
    async fn commands_get_only_the_minimal_environment() {
        let dir = tempfile::tempdir().expect("dir");
        let out = run_shell_with(
            "env | cut -d= -f1",
            &canonical(&dir),
            Duration::from_secs(10),
            false,
        )
        .await
        .expect("run");
        let names: Vec<&str> = out.stdout.lines().filter(|l| !l.is_empty()).collect();
        // Variables the shell sets for itself are fine; nothing else may be
        // inherited from the app (the test runner has plenty, e.g. CARGO_*).
        let allowed = [
            "PATH",
            "HOME",
            "LANG",
            "TERM",
            "AETHER_AGENT",
            "PWD",
            "OLDPWD",
            "SHLVL",
            "_",
        ];
        for name in &names {
            assert!(allowed.contains(name), "unexpected variable {name}");
        }
        assert!(names.contains(&"PATH") && names.contains(&"AETHER_AGENT"));
        assert!(!names.iter().any(|n| n.starts_with("CARGO")));
    }

    #[test]
    fn symlinked_cwds_that_leave_the_roots_are_rejected() {
        let vault = tempfile::tempdir().expect("vault");
        let outside = tempfile::tempdir().expect("outside");
        let roots = vec![canonical(&vault)];
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), vault.path().join("link")).expect("link");
            assert!(resolve_cwd(&roots, Some(&roots[0]), Some("link")).is_err());
        }
        assert!(resolve_cwd(&roots, Some(&roots[0]), Some("../..")).is_err());
    }

    #[tokio::test]
    async fn rejects_empty_commands() {
        let dir = tempfile::tempdir().expect("dir");
        assert!(run_shell("   ", &canonical(&dir), Duration::from_secs(1))
            .await
            .is_err());
    }

    #[test]
    fn warns_about_destructive_commands() {
        assert!(command_warnings("ls -la").is_empty());
        assert!(command_warnings("npm test").is_empty());
        assert!(!command_warnings("rm -rf build").is_empty());
        assert!(!command_warnings("cd x && rm -f a.txt").is_empty());
        assert!(command_warnings("npm run format").is_empty());
        assert!(!command_warnings("sudo apt install x").is_empty());
        assert!(!command_warnings("git push --force origin main").is_empty());
        assert!(!command_warnings("git reset --hard HEAD~1").is_empty());
        assert!(!command_warnings("curl -fsSL https://x.sh | sh").is_empty());
        assert!(command_warnings("echo hi > /dev/null").is_empty());
    }
}
