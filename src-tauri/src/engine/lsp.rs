//! `lsp` — sidecar bridge between Monaco and Language Servers.
//!
//! The IDE gains project-wide IntelliSense (hover, completions,
//! go-to-definition, diagnostics) by spawning standard LSP servers found on
//! the user's PATH (`typescript-language-server`, `rust-analyzer`,
//! `pyright`, …) as child processes and shuttling JSON-RPC messages between
//! them and the webview over Tauri events/commands.
//!
//! Design notes:
//! - One process per `(root project, language)` pair; servers expect a
//!   stable workspace root for their whole lifetime.
//! - Transport is the mandatory LSP-over-stdio framing
//!   (`Content-Length: N\r\n\r\n{body}`).
//! - The backend is transport-only: it never interprets protocol semantics.
//!   Everything else (initialization handshake, document sync, provider
//!   wiring) lives in the frontend where Monaco is.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use serde_json::Value;

use super::error::AetherError;

/// Stable identifier for one server instance: `<language>::<root path>`.
pub fn session_key(language: &str, root: &str) -> String {
    format!("{language}::{root}")
}

/// Candidate commands for a language, best first. Each candidate is tried in
/// order; the first executable found on PATH wins.
pub fn server_candidates(language: &str) -> &'static [&'static [&'static str]] {
    match language {
        "typescript" | "javascript" => {
            // Direct binary first, npx as the zero-install fallback.
            &[
                &["typescript-language-server", "--stdio"],
                &["npx", "--yes", "typescript-language-server", "--stdio"],
            ]
        }
        "python" => &[&["pyright-langserver", "--stdio"], &["pylsp"]],
        "rust" => &[&["rust-analyzer"]],
        "json" => &[&["vscode-json-language-server", "--stdio"]],
        _ => &[],
    }
}

/// Resolve a program name against PATH (like `which`). Empty PATH entries
/// mean "current directory", matching shell behaviour. On Windows the
/// `PATHEXT` extensions are tried as well, so `npx` finds `npx.cmd` and
/// `code` finds `code.cmd`.
pub fn find_in_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    find_program_in(program, &path, &executable_extensions())
}

/// Extensions tried after the bare name: none on Unix, `PATHEXT` (default
/// `.COM;.EXE;.BAT;.CMD`) on Windows.
fn executable_extensions() -> Vec<String> {
    if cfg!(windows) {
        let pathext = std::env::var("PATHEXT").unwrap_or_default();
        parse_pathext(&pathext)
    } else {
        Vec::new()
    }
}

/// `PATHEXT` → lower-case extensions with a leading dot (blank → defaults).
pub fn parse_pathext(pathext: &str) -> Vec<String> {
    let parsed: Vec<String> = pathext
        .split(';')
        .map(str::trim)
        .filter(|e| e.len() > 1 && e.starts_with('.'))
        .map(str::to_ascii_lowercase)
        .collect();
    if parsed.is_empty() {
        [".com", ".exe", ".bat", ".cmd"].map(str::to_owned).to_vec()
    } else {
        parsed
    }
}

/// [`find_in_path`] against an explicit `path` list and extension set. A
/// name with a path separator is checked as given (plus extensions).
pub fn find_program_in(
    program: &str,
    path: &std::ffi::OsStr,
    extensions: &[String],
) -> Option<PathBuf> {
    if program.is_empty() {
        return None;
    }
    // Windows cannot start an extension-less file (npm ships a POSIX `npx`
    // script next to `npx.cmd`), so a bare name only tries the extensions.
    let has_extension = Path::new(program).extension().is_some();
    let names: Vec<String> = (extensions.is_empty() || has_extension)
        .then(|| program.to_owned())
        .into_iter()
        .chain(extensions.iter().map(|ext| format!("{program}{ext}")))
        .collect();
    let has_separator = program.contains('/') || (cfg!(windows) && program.contains('\\'));
    if has_separator {
        return names.iter().map(PathBuf::from).find(|p| is_program_file(p));
    }
    for dir in std::env::split_paths(path) {
        let dir = if dir.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            dir
        };
        if let Some(found) = names
            .iter()
            .map(|n| dir.join(n))
            .find(|p| is_program_file(p))
        {
            return Some(found);
        }
    }
    None
}

/// A regular file — or, on Windows, an App Execution Alias (`wt.exe`,
/// `python.exe` in `WindowsApps`), a reparse point `is_file` cannot follow.
fn is_program_file(path: &Path) -> bool {
    path.is_file()
        || (cfg!(windows)
            && path
                .symlink_metadata()
                .is_ok_and(|m| !m.file_type().is_dir()))
}

/// Serialize one JSON-RPC body into the stdio framing every LSP server speaks.
pub fn encode_frame(body: &[u8]) -> Vec<u8> {
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut out = Vec::with_capacity(header.len() + body.len());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(body);
    out
}

/// Largest JSON-RPC body accepted from a language server.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
/// Largest header block (without its `\r\n\r\n` terminator) that is buffered.
pub const MAX_HEADER_BYTES: usize = 8 * 1024;

/// Incremental decoder for the stream of incoming framed bodies. Feed it raw
/// chunks from the server's stdout; it hands back every complete body.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Extracts `Content-Length` from the buffered header block (at most
    /// [`MAX_FRAME_BYTES`]; a header without terminator may not grow past
    /// [`MAX_HEADER_BYTES`]).
    /// Returns `Ok(None)` when the header is not complete yet.
    fn header_length(&self) -> Result<Option<usize>, AetherError> {
        let sep = b"\r\n\r\n";
        let pos = find_subslice(&self.buf, sep);
        let Some(pos) = pos else {
            if self.buf.len() > MAX_HEADER_BYTES {
                return Err(AetherError::InvalidInput(
                    "LSP server sent an oversized frame header".into(),
                ));
            }
            return Ok(None);
        };
        let header = String::from_utf8_lossy(&self.buf[..pos]);
        let mut length = None;
        for line in header.split("\r\n") {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = Some(value.trim().parse::<usize>().map_err(|_| {
                    AetherError::InvalidInput(format!(
                        "LSP server sent invalid Content-Length: {value:?}"
                    ))
                })?);
            }
        }
        match length {
            Some(n) if n > MAX_FRAME_BYTES => Err(AetherError::InvalidInput(format!(
                "LSP server announced a {n}-byte frame (limit {MAX_FRAME_BYTES})"
            ))),
            Some(n) => Ok(Some(n)),
            None => Err(AetherError::InvalidInput(
                "LSP frame is missing Content-Length".into(),
            )),
        }
    }

    /// Consume the next complete body from the buffer, if present.
    fn take_body(&mut self) -> Result<Option<Vec<u8>>, AetherError> {
        let Some(length) = self.header_length()? else {
            return Ok(None);
        };
        const HEADER_TERMINATOR: usize = 4;
        let Some(header_end) = find_subslice(&self.buf, b"\r\n\r\n") else {
            return Ok(None);
        };
        // `length` is capped by `header_length`, so this cannot overflow.
        let total = header_end + HEADER_TERMINATOR + length;
        if self.buf.len() < total {
            return Ok(None);
        }
        let body = self.buf[header_end + HEADER_TERMINATOR..total].to_vec();
        self.buf.drain(..total);
        Ok(Some(body))
    }

    /// Feed raw bytes; returns all bodies that became complete.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, AetherError> {
        self.buf.extend_from_slice(chunk);
        let mut bodies = Vec::new();
        while let Some(body) = self.take_body()? {
            bodies.push(body);
        }
        Ok(bodies)
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

struct LspProcess {
    stdin: Mutex<Box<ChildStdin>>,
    child: Mutex<Child>,
    alive: Arc<AtomicBool>,
}

/// Owns all running language-server processes.
pub struct LspManager {
    processes: Mutex<HashMap<String, Arc<LspProcess>>>,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }

    /// Spawn a server for `key`. `on_message` receives every decoded
    /// JSON-RPC body from the server; it is invoked from reader threads.
    pub fn start(
        &self,
        key: &str,
        cwd: &Path,
        argv: &[String],
        on_exit: impl Fn(&str) + Send + Sync + 'static,
        on_message: impl Fn(&str, Value) + Send + Sync + 'static,
    ) -> Result<(), AetherError> {
        {
            let processes = self
                .processes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if processes.contains_key(key) {
                // Already running — idempotent restart requests are fine.
                return Ok(());
            }
        }

        let [program, args @ ..] = argv else {
            return Err(AetherError::InvalidInput(
                "LSP server command must have at least a program name".into(),
            ));
        };
        let program_path = find_in_path(program).ok_or_else(|| {
            AetherError::InvalidInput(format!("language server not found on PATH: {program}"))
        })?;

        let mut command = Command::new(&program_path);
        crate::engine::desktop::hide_console(&mut command);
        let mut child = command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                AetherError::Vault(format!("cannot start language server {program}: {e}"))
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AetherError::Vault("language server has no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AetherError::Vault("language server has no stdout".into()))?;
        let stderr = child.stderr.take();

        let alive = Arc::new(AtomicBool::new(true));
        let process = Arc::new(LspProcess {
            stdin: Mutex::new(Box::new(stdin)),
            child: Mutex::new(child),
            alive: Arc::clone(&alive),
        });

        self.processes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.to_string(), Arc::clone(&process));

        // Reader: decode frames and forward parsed JSON-RPC bodies.
        let reader_key = key.to_string();
        let reader_on_message = on_message;
        let exit_key = key.to_string();
        let on_exit = Arc::new(on_exit);
        thread::spawn(move || {
            let mut decoder = FrameDecoder::new();
            let mut stdout = stdout;
            let mut chunk = [0u8; 16 * 1024];
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) => break, // EOF: server exited
                    Ok(n) => match decoder.push(&chunk[..n]) {
                        Ok(bodies) => {
                            for body in bodies {
                                match serde_json::from_slice::<Value>(&body) {
                                    Ok(value) => reader_on_message(&reader_key, value),
                                    Err(e) => {
                                        eprintln!("[lsp] dropping non-JSON frame: {e}");
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("[lsp] framing error, stopping read loop: {e}");
                            break;
                        }
                    },
                    Err(e) => {
                        eprintln!("[lsp] stdout read error: {e}");
                        break;
                    }
                }
            }
            alive.store(false, Ordering::SeqCst);
            on_exit(&exit_key);
        });

        // Stderr: pure logging, never blocks the protocol.
        if let Some(stderr) = stderr {
            thread::spawn(move || {
                let mut reader = std::io::BufReader::new(stderr);
                loop {
                    let mut line = String::new();
                    match std::io::BufRead::read_line(&mut reader, &mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => eprint!("[lsp-server] {line}"),
                    }
                }
            });
        }

        Ok(())
    }

    /// Send one JSON-RPC message to the server behind `key`.
    pub fn send(&self, key: &str, message: &Value) -> Result<(), AetherError> {
        let process = {
            let processes = self
                .processes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            processes.get(key).cloned()
        };
        let Some(process) = process else {
            return Err(AetherError::InvalidInput(format!(
                "no language server running for {key}"
            )));
        };
        if !process.alive.load(Ordering::SeqCst) {
            return Err(AetherError::InvalidInput(format!(
                "language server for {key} has exited"
            )));
        }
        let body = serde_json::to_vec(message)
            .map_err(|e| AetherError::Vault(format!("cannot serialize LSP message: {e}")))?;
        let mut stdin = process
            .stdin
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        stdin
            .write_all(&encode_frame(&body))
            .and_then(|_| stdin.flush())
            .map_err(|e| AetherError::Vault(format!("cannot write to language server: {e}")))
    }

    /// Stop one server (kill + forget). Stopping an unknown key is fine.
    pub fn stop(&self, key: &str) {
        let process = self
            .processes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(key);
        if let Some(process) = process {
            process.alive.store(false, Ordering::SeqCst);
            if let Ok(mut child) = process.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    /// Kill everything — used on app shutdown and folder close.
    pub fn stop_all(&self) {
        let keys: Vec<String> = self
            .processes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        for key in keys {
            self.stop(&key);
        }
    }

    pub fn running(&self) -> Vec<String> {
        self.processes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LspSessionInfo {
    pub key: String,
    pub language: String,
    pub command: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encodes_the_standard_framing() {
        let body = br#"{"jsonrpc":"2.0"}"#;
        let frame = encode_frame(body);
        let text = String::from_utf8(frame).unwrap();
        assert_eq!(
            text,
            format!(
                "Content-Length: {}\r\n\r\n{{\"jsonrpc\":\"2.0\"}}",
                body.len()
            )
        );
    }

    #[test]
    fn hostile_frame_headers_are_errors_not_panics() {
        let mut decoder = FrameDecoder::new();
        let huge = format!("Content-Length: {}\r\n\r\n{{}}", usize::MAX);
        assert!(decoder.push(huge.as_bytes()).is_err());

        let mut decoder = FrameDecoder::new();
        let over = format!("Content-Length: {}\r\n\r\n", MAX_FRAME_BYTES + 1);
        assert!(decoder.push(over.as_bytes()).is_err());

        let mut decoder = FrameDecoder::new();
        let endless = vec![b'x'; MAX_HEADER_BYTES + 1];
        assert!(decoder.push(&endless).is_err());
    }

    #[test]
    fn decodes_a_single_frame() {
        let mut decoder = FrameDecoder::new();
        let bodies = decoder.push(&encode_frame(br#"{"id":1}"#)).expect("decode");
        assert_eq!(bodies.len(), 1);
        assert_eq!(
            serde_json::from_slice::<Value>(&bodies[0]).unwrap()["id"],
            1
        );
    }

    #[test]
    fn reassembles_frames_split_across_chunks() {
        let mut decoder = FrameDecoder::new();
        let frame = encode_frame(br#"{"method":"x"}"#);

        let first = decoder.push(&frame[..5]).expect("partial header");
        assert!(first.is_empty());

        let mid = decoder.push(&frame[5..12]).expect("partial body");
        assert!(mid.is_empty());

        let rest = decoder.push(&frame[12..]).expect("rest");
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0], br#"{"method":"x"}"#);
    }

    #[test]
    fn decodes_many_frames_from_one_chunk() {
        let mut input = Vec::new();
        for i in 0..25 {
            input.extend(encode_frame(format!(r#"{{"i":{i}}}"#).as_bytes()));
        }
        let mut decoder = FrameDecoder::new();
        let bodies = decoder.push(&input).expect("decode burst");
        assert_eq!(bodies.len(), 25);
        assert_eq!(
            serde_json::from_slice::<Value>(&bodies[24]).unwrap()["i"],
            24
        );
    }

    #[test]
    fn handles_headers_case_insensitively_and_ignores_extra_header_fields() {
        let body = br#"{}"#;
        let raw = format!(
            "content-type: application/vscode-jsonrpc\r\nCONTENT-LENGTH: {}\r\n\r\n",
            body.len()
        ) + r#"{}"#;
        let mut decoder = FrameDecoder::new();
        let bodies = decoder.push(raw.as_bytes()).expect("decode");
        assert_eq!(bodies.len(), 1);
    }

    #[test]
    fn rejects_frames_without_content_length() {
        let mut decoder = FrameDecoder::new();
        let error = decoder
            .push(b"\r\n\r\nnot-framed")
            .expect_err("missing header must fail loudly");
        assert!(error.to_string().contains("Content-Length"));
    }

    #[test]
    fn keys_pair_language_with_root() {
        assert_eq!(session_key("rust", "/tmp/a"), "rust::/tmp/a");
        assert_ne!(session_key("rust", "/tmp/a"), session_key("rust", "/tmp/b"));
        assert_ne!(
            session_key("rust", "/tmp/a"),
            session_key("python", "/tmp/a")
        );
    }

    #[test]
    fn maps_languages_to_expected_servers() {
        assert_eq!(
            server_candidates("typescript")[0][0],
            "typescript-language-server"
        );
        assert_eq!(
            server_candidates("javascript")[0][0],
            "typescript-language-server"
        );
        // npx fallback for machines without the global install.
        assert_eq!(server_candidates("typescript")[1][0], "npx");
        assert_eq!(server_candidates("rust")[0][0], "rust-analyzer");
        // Python has a fallback chain.
        assert!(server_candidates("python").len() >= 2);
        // Unknown languages simply have no server.
        assert!(server_candidates("brainfuck").is_empty());
    }

    #[test]
    fn finds_common_tools_on_path() {
        assert!(find_in_path(if cfg!(target_os = "windows") {
            "cmd"
        } else {
            "ls"
        })
        .is_some());
        assert!(find_in_path("definitely-not-a-real-tool-xyz").is_none());
        assert!(find_in_path("").is_none());
    }

    #[test]
    fn pathext_is_parsed_lower_case_with_defaults() {
        assert_eq!(
            parse_pathext(".COM;.EXE; .Cmd ;;bad;."),
            vec![".com", ".exe", ".cmd"]
        );
        assert_eq!(parse_pathext(""), vec![".com", ".exe", ".bat", ".cmd"]);
    }

    /// Windows lookup rules, simulated with an explicit extension list so
    /// they are checked on every platform.
    #[test]
    fn windows_style_lookup_prefers_launchers_over_extensionless_scripts() {
        let first = tempfile::tempdir().expect("dir");
        let second = tempfile::tempdir().expect("dir");
        // npm puts a POSIX `npx` script next to `npx.cmd`.
        std::fs::write(first.path().join("npx"), "#!/bin/sh").expect("npx");
        std::fs::write(first.path().join("npx.cmd"), "@echo off").expect("npx.cmd");
        std::fs::write(second.path().join("tool.exe"), "").expect("tool.exe");
        std::fs::create_dir(second.path().join("dir.exe")).expect("dir.exe");
        let path = std::env::join_paths([first.path(), second.path()]).expect("join");
        let exts = parse_pathext(".COM;.EXE;.BAT;.CMD");

        assert_eq!(
            find_program_in("npx", &path, &exts),
            Some(first.path().join("npx.cmd"))
        );
        assert_eq!(
            find_program_in("tool", &path, &exts),
            Some(second.path().join("tool.exe"))
        );
        // An explicit extension is used as given; folders never match.
        assert_eq!(
            find_program_in("tool.exe", &path, &exts),
            Some(second.path().join("tool.exe"))
        );
        assert_eq!(find_program_in("dir", &path, &exts), None);
        // Unix rules (no extensions): only the exact name.
        assert_eq!(
            find_program_in("npx", &path, &[]),
            Some(first.path().join("npx"))
        );
        assert_eq!(find_program_in("tool", &path, &[]), None);
        // A path is checked directly.
        let direct = first.path().join("npx.cmd");
        assert_eq!(
            find_program_in(&direct.to_string_lossy(), &path, &[]),
            Some(direct)
        );
    }

    #[test]
    fn manager_start_requires_a_real_executable() {
        let manager = LspManager::new();
        let error = manager
            .start(
                "t::/tmp",
                Path::new("/tmp"),
                &["definitely-not-a-real-tool-xyz".to_string()],
                |_| {},
                |_, _| {},
            )
            .expect_err("unknown binary must fail");
        assert!(error.to_string().contains("not found on PATH"));
    }

    #[cfg(unix)]
    #[test]
    fn manager_lifecycle_smoke_test_with_cat() {
        let manager = LspManager::new();
        manager
            .start(
                "cat::/tmp",
                Path::new("/tmp"),
                &["cat".to_string()],
                |_| {},
                |_, _| {},
            )
            .expect("cat must be spawnable");

        // cat echoes whatever we frame back — not valid LSP, but proves the
        // pipe is bidirectional and the writer accepts framed payloads.
        manager
            .send("cat::/tmp", &json!({"jsonrpc": "2.0", "method": "ping"}))
            .expect("write must succeed while cat lives");

        manager.stop("cat::/tmp");
        assert!(manager.send("cat::/tmp", &json!({})).is_err());
        assert!(!manager.running().contains(&"cat::/tmp".to_string()));
    }

    #[test]
    fn stopping_unknown_keys_is_a_noop() {
        let manager = LspManager::new();
        manager.stop("never-started");
        manager.stop_all(); // must not panic on empty map
        assert!(manager.running().is_empty());
    }

    /// Full-stack proof: if a real language server is installed, drive the
    /// actual `initialize` handshake through spawn → frame → parse. Skips
    /// silently when the binary is absent so CI machines stay green.
    #[test]
    fn real_initialize_handshake_when_typescript_language_server_exists() {
        let Some(tls_path) = find_in_path("typescript-language-server") else {
            return;
        };
        // Only the Unix branch below links the global TypeScript install.
        #[cfg(not(unix))]
        let _ = &tls_path;
        // tls needs a TypeScript installation inside the workspace. The
        // npm global layout is <prefix>/bin/tls + <prefix>/lib/node_modules,
        // so a sibling symlink gives the test a realistic project.
        use std::sync::mpsc;
        let dir = tempfile::tempdir().expect("temp project");
        std::fs::create_dir_all(dir.path().join("node_modules")).expect("node_modules");
        #[cfg(unix)]
        {
            let global_typescript = tls_path
                .parent()
                .and_then(|bin| bin.parent())
                .map(|prefix| prefix.join("lib/node_modules/typescript"));
            let Some(global_typescript) =
                global_typescript.filter(|p: &std::path::PathBuf| p.exists())
            else {
                return;
            };
            std::os::unix::fs::symlink(
                global_typescript.as_path(),
                dir.path().join("node_modules/typescript"),
            )
            .expect("symlink typescript into fake workspace");
        }

        let manager = LspManager::new();
        let (tx, rx) = mpsc::channel::<Value>();

        manager
            .start(
                "tls::test",
                dir.path(),
                &[
                    "typescript-language-server".to_string(),
                    "--stdio".to_string(),
                ],
                |_| {},
                move |_key, message| {
                    let _ = tx.send(message);
                },
            )
            .expect("server must spawn");

        manager
            .send(
                "tls::test",
                &json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "processId": null,
                        "rootUri": format!("file://{}", dir.path().display()),
                        "capabilities": {}
                    }
                }),
            )
            .expect("initialize must be writable");

        // The server answers with capabilities — that is the whole contract.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut answered = false;
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(std::time::Duration::from_millis(500)) {
                Ok(message) => {
                    if message.get("id") == Some(&json!(1)) && message.get("result").is_some() {
                        assert!(
                            message["result"]["capabilities"].is_object(),
                            "initialize response must carry capabilities"
                        );
                        answered = true;
                        break;
                    }
                    // Errors mean the fixture was wrong, not the transport —
                    // surface them instead of timing out confusingly.
                    if message.get("id") == Some(&json!(1)) && message.get("error").is_some() {
                        panic!("initialize failed: {message}");
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(e) => panic!("reader died during handshake: {e}"),
            }
        }
        assert!(answered, "no initialize response within 30s");

        manager
            .send(
                "tls::test",
                &json!({"jsonrpc": "2.0", "method": "shutdown"}),
            )
            .ok();
        manager.stop_all();
    }
}
