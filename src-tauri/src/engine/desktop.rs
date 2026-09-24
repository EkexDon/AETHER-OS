//! Hand-offs to other desktop programs, per platform: the system browser,
//! an external editor, a new terminal window. macOS uses `open`, Windows
//! `rundll32` / Windows Terminal / a new console, Linux `xdg-open` and the
//! first terminal emulator it finds. Whatever a platform cannot do returns
//! a clear error — never a panic.
//!
//! (Revealing a folder in Finder / Explorer / the file manager lives in
//! `diagnostics::open_in_file_manager`; opening exports in
//! `export::open_path`.)

#[cfg(any(test, all(unix, not(target_os = "macos"))))]
use std::ffi::OsString;
use std::path::Path;
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
use std::path::PathBuf;
use std::process::Command;

use crate::engine::error::AetherError;
use crate::engine::lsp::find_in_path;

/// Windows: run a console program without flashing a console window (a GUI
/// app has none to share). No-op elsewhere.
pub fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Tokio variant of [`hide_console`].
pub fn hide_console_async(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Open an already validated `http`/`https`/`mailto` URL in the system's
/// default handler. No shell is involved on any platform, so characters
/// like `&` in a query string are never interpreted.
pub fn open_url_with_system(url: &url::Url) -> Result<(), AetherError> {
    let url = url.as_str();
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = Command::new("open");
        cmd.arg(url);
        cmd
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = Command::new("rundll32.exe");
        cmd.arg("url.dll,FileProtocolHandler").arg(url);
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(url);
        cmd
    };
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| AetherError::InvalidInput(format!("Failed to open URL: {e}")))
}

#[cfg(any(test, all(unix, not(target_os = "macos"))))]
/// How a terminal emulator is told which folder to start in (besides the
/// working directory it is spawned with, which most of them honour).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirArg {
    /// Only the process working directory.
    Cwd,
    /// `--flag=<dir>`.
    Joined(&'static str),
    /// `<flag> <dir>` (may be several words, e.g. `start --cwd`).
    Separate(&'static [&'static str]),
}

#[cfg(any(test, all(unix, not(target_os = "macos"))))]
/// Linux terminal emulators, in the order they are tried after `$TERMINAL`.
const LINUX_TERMINALS: &[(&str, DirArg)] = &[
    ("x-terminal-emulator", DirArg::Cwd),
    ("gnome-terminal", DirArg::Joined("--working-directory=")),
    ("konsole", DirArg::Separate(&["--workdir"])),
    ("xfce4-terminal", DirArg::Joined("--working-directory=")),
    ("mate-terminal", DirArg::Joined("--working-directory=")),
    ("tilix", DirArg::Joined("--working-directory=")),
    ("kgx", DirArg::Joined("--working-directory=")),
    ("ptyxis", DirArg::Joined("--working-directory=")),
    ("kitty", DirArg::Separate(&["--directory"])),
    ("alacritty", DirArg::Separate(&["--working-directory"])),
    ("wezterm", DirArg::Separate(&["start", "--cwd"])),
    ("foot", DirArg::Joined("--working-directory=")),
    ("xterm", DirArg::Cwd),
];

#[cfg(any(test, all(unix, not(target_os = "macos"))))]
/// A resolved "open a terminal in `cwd`" command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalLaunch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
}

#[cfg(any(test, all(unix, not(target_os = "macos"))))]
fn dir_args(kind: DirArg, dir: &Path) -> Vec<OsString> {
    match kind {
        DirArg::Cwd => Vec::new(),
        DirArg::Joined(flag) => {
            let mut arg = OsString::from(flag);
            arg.push(dir.as_os_str());
            vec![arg]
        }
        DirArg::Separate(words) => {
            let mut args: Vec<OsString> = words.iter().map(OsString::from).collect();
            args.push(dir.as_os_str().to_owned());
            args
        }
    }
}

#[cfg(any(test, all(unix, not(target_os = "macos"))))]
/// Pick the Linux terminal for `dir`: `$TERMINAL` (a program name or path,
/// started in `dir`), then [`LINUX_TERMINALS`]. `resolve` maps a program
/// name to its executable (normally a `PATH` lookup).
pub fn linux_terminal_launch(
    dir: &Path,
    terminal_env: Option<&str>,
    resolve: impl Fn(&str) -> Option<PathBuf>,
) -> Option<TerminalLaunch> {
    let from_env = terminal_env
        .map(str::trim)
        .filter(|t| !t.is_empty() && !t.contains(char::is_whitespace))
        .and_then(|t| {
            let known = LINUX_TERMINALS
                .iter()
                .find(|(name, _)| Path::new(t).file_name() == Some(name.as_ref()))
                .map_or(DirArg::Cwd, |(_, kind)| *kind);
            resolve(t).map(|program| (program, known))
        });
    let (program, kind) = from_env.or_else(|| {
        LINUX_TERMINALS
            .iter()
            .find_map(|(name, kind)| resolve(name).map(|p| (p, *kind)))
    })?;
    Some(TerminalLaunch {
        program,
        args: dir_args(kind, dir),
        cwd: dir.to_path_buf(),
    })
}

/// Open a new terminal window in `dir` (an existing folder).
pub fn open_terminal_at(dir: &Path) -> Result<(), AetherError> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(dir)
            .status()
            .map_err(|e| AetherError::InvalidInput(format!("Failed to open Terminal: {e}")))?;
        if status.success() {
            Ok(())
        } else {
            Err(AetherError::InvalidInput(format!(
                "Terminal could not be opened (open exited with {status})"
            )))
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        // Windows Terminal when installed ("-d ." = its working directory,
        // so the path never goes through wt's own argument parser), else a
        // PowerShell console window.
        let mut cmd = match find_in_path("wt.exe") {
            Some(wt) => {
                let mut cmd = Command::new(wt);
                cmd.args(["-d", "."]);
                cmd
            }
            None => {
                let mut cmd = Command::new("powershell.exe");
                cmd.arg("-NoLogo").creation_flags(CREATE_NEW_CONSOLE);
                cmd
            }
        };
        cmd.current_dir(dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| AetherError::InvalidInput(format!("Failed to open a terminal: {e}")))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let terminal_env = std::env::var("TERMINAL").ok();
        let launch =
            linux_terminal_launch(dir, terminal_env.as_deref(), find_in_path).ok_or_else(|| {
                AetherError::InvalidInput(
                    "No terminal emulator found (tried $TERMINAL, x-terminal-emulator, \
                     gnome-terminal, konsole, xfce4-terminal, kitty, alacritty, xterm, …)"
                        .to_owned(),
                )
            })?;
        Command::new(&launch.program)
            .args(&launch.args)
            .current_dir(&launch.cwd)
            .spawn()
            .map(|_| ())
            .map_err(|e| {
                AetherError::InvalidInput(format!(
                    "Failed to start {}: {e}",
                    launch.program.display()
                ))
            })
    }
}

/// Open `target` (an existing, validated path) in an editor. On macOS
/// `app_name` is launched with `open -a` (works without the CLI shim),
/// falling back to `cli`. Elsewhere only the CLI launcher can be used —
/// `code`, `cursor`, … must be on `PATH`.
pub fn open_in_editor(app_name: &str, cli: Option<&str>, target: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let opened = Command::new("open")
            .arg("-a")
            .arg(app_name)
            .arg(target)
            .status()
            .is_ok_and(|s| s.success());
        if opened {
            return Ok(());
        }
    }
    let Some(cli) = cli else {
        return Err(if cfg!(target_os = "macos") {
            format!("Failed to launch {app_name}")
        } else {
            format!(
                "Opening an editor by application name ({app_name}) is only supported on macOS. \
                 Choose VS Code, Cursor, Windsurf or Devin and install its command-line launcher."
            )
        });
    };
    let program = find_in_path(cli).ok_or_else(|| {
        format!("Failed to launch {app_name}: its command-line launcher `{cli}` is not on PATH")
    })?;
    let status = hide_console(Command::new(&program).arg(target))
        .status()
        .map_err(|e| format!("Failed to launch {app_name}: {e}"))?;
    if !status.success() {
        return Err(format!("{cli} exited with status {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver(available: &'static [&'static str]) -> impl Fn(&str) -> Option<PathBuf> {
        move |name: &str| {
            let base = Path::new(name)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(name);
            available
                .contains(&base)
                .then(|| PathBuf::from("/usr/bin").join(base))
        }
    }

    #[test]
    fn linux_terminal_prefers_the_debian_alternative() {
        let dir = Path::new("/home/me/My Project");
        let launch = linux_terminal_launch(dir, None, resolver(&["xterm", "x-terminal-emulator"]))
            .expect("terminal");
        assert_eq!(
            launch.program,
            PathBuf::from("/usr/bin/x-terminal-emulator")
        );
        assert!(launch.args.is_empty());
        assert_eq!(launch.cwd, dir);
    }

    #[test]
    fn linux_terminal_passes_the_folder_in_each_emulators_syntax() {
        let dir = Path::new("/home/me/p");
        let gnome = linux_terminal_launch(dir, None, resolver(&["gnome-terminal"])).expect("g");
        assert_eq!(
            gnome.args,
            vec![OsString::from("--working-directory=/home/me/p")]
        );
        let konsole = linux_terminal_launch(dir, None, resolver(&["konsole"])).expect("k");
        assert_eq!(
            konsole.args,
            vec![OsString::from("--workdir"), OsString::from("/home/me/p")]
        );
        let wez = linux_terminal_launch(dir, None, resolver(&["wezterm"])).expect("w");
        assert_eq!(
            wez.args,
            ["start", "--cwd", "/home/me/p"]
                .map(OsString::from)
                .to_vec()
        );
    }

    #[test]
    fn linux_terminal_env_wins_and_known_names_keep_their_flags() {
        let dir = Path::new("/p");
        let launch =
            linux_terminal_launch(dir, Some("kitty"), resolver(&["kitty", "gnome-terminal"]))
                .expect("kitty");
        assert_eq!(launch.program, PathBuf::from("/usr/bin/kitty"));
        assert_eq!(
            launch.args,
            ["--directory", "/p"].map(OsString::from).to_vec()
        );
        // Unknown $TERMINAL: started in the folder, no flags.
        let custom = linux_terminal_launch(dir, Some("st"), resolver(&["st"])).expect("st");
        assert!(custom.args.is_empty());
        // A $TERMINAL with arguments or one that is missing is skipped.
        let fallback =
            linux_terminal_launch(dir, Some("kitty -1"), resolver(&["xterm"])).expect("xterm");
        assert_eq!(fallback.program, PathBuf::from("/usr/bin/xterm"));
        let missing = linux_terminal_launch(dir, Some("nope"), resolver(&["foot"])).expect("foot");
        assert_eq!(missing.program, PathBuf::from("/usr/bin/foot"));
    }

    #[test]
    fn linux_terminal_reports_none_without_any_emulator() {
        assert_eq!(
            linux_terminal_launch(Path::new("/p"), Some(""), resolver(&[])),
            None
        );
    }

    #[test]
    fn unknown_editors_need_macos_or_a_cli() {
        let dir = tempfile::tempdir().expect("tempdir");
        if !cfg!(target_os = "macos") {
            let err = open_in_editor("Some Editor", None, dir.path()).expect_err("unsupported");
            assert!(err.contains("only supported on macOS"), "{err}");
        }
        let err = open_in_editor(
            "AetherNoSuchEditorApp",
            Some("definitely-not-an-editor-cli-xyz"),
            dir.path(),
        )
        .expect_err("missing CLI");
        assert!(
            err.contains("not on PATH") || err.contains("Failed to launch"),
            "{err}"
        );
    }
}
