use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use uuid::Uuid;

use crate::engine::error::AetherError;

#[derive(Debug, Clone, Serialize)]
pub struct TerminalSession {
    pub id: String,
    pub cwd: String,
    pub shell: String,
    pub alive: bool,
}

struct SessionHandle {
    writer: Option<Box<dyn Write + Send>>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    shell: String,
    cwd: String,
    alive: Arc<std::sync::atomic::AtomicBool>,
}

pub struct TerminalManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn default_shell() -> String {
        if cfg!(target_os = "windows") {
            "powershell.exe".to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
        }
    }

    pub fn spawn(
        &self,
        cwd: Option<&str>,
        shell: Option<&str>,
        cols: u16,
        rows: u16,
        on_output: impl Fn(&str, &[u8]) + Send + 'static,
    ) -> Result<TerminalSession, AetherError> {
        let id = Uuid::new_v4().to_string();
        let shell = shell.map(|s| s.to_string()).unwrap_or_else(Self::default_shell);
        let cwd = cwd.map(|c| c.to_string()).unwrap_or_else(|| {
            std::env::current_dir()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_else(|_| "/".to_string())
        });

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AetherError::InvalidInput(format!("Failed to open PTY: {e}")))?;

        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&cwd);

        if cfg!(target_os = "windows") {
            cmd.env("TERM", "xterm-256color");
        } else {
            cmd.env("TERM", "xterm-256color");
            cmd.env("LANG", "en_US.UTF-8");
            cmd.env("CLICOLOR", "1");
            cmd.env("LSCOLORS", "GxFxCxDxBxegedabagaced");
        }

        let slave = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AetherError::InvalidInput(format!("Failed to spawn shell: {e}")))?;

        let master = pair.master;
        let writer = master
            .take_writer()
            .map_err(|e| AetherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        let mut reader = master
            .try_clone_reader()
            .map_err(|e| AetherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let alive_clone = Arc::clone(&alive);
        let thread_id = id.clone();

        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut warned_binary = false;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        // Diagnostics: programs occasionally emit binary that
                        // no terminal can render (the source of "tofu" glyph
                        // rows). Log the first occurrence per session so the
                        // culprit shows up in the app log instead of staying
                        // invisible. The transport itself stays byte-exact.
                        if !warned_binary && chunk.iter().any(|&b| b == 0 || (0x80..=0x8F).contains(&b) || b == 0xFF) {
                            warned_binary = true;
                            eprintln!(
                                "[terminal] session {thread_id}: first non-text chunk ({} bytes): {:?}",
                                chunk.len(),
                                &chunk[..chunk.len().min(64)]
                            );
                        }
                        on_output(&thread_id, chunk);
                    }
                    Err(_) => break,
                }
            }
            alive_clone.store(false, std::sync::atomic::Ordering::Relaxed);
        });

        let session_info = TerminalSession {
            id: id.clone(),
            cwd: cwd.clone(),
            shell: shell.clone(),
            alive: true,
        };

        let handle = SessionHandle {
            writer: Some(writer),
            master,
            shell,
            cwd,
            alive,
        };

        self.sessions
            .lock()
            .map_err(|e| AetherError::InvalidInput(format!("Session lock poisoned: {e}")))?
            .insert(id, handle);

        let _ = slave;
        Ok(session_info)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), AetherError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| AetherError::InvalidInput(format!("Session lock poisoned: {e}")))?;

        let handle = sessions
            .get_mut(id)
            .ok_or_else(|| AetherError::InvalidInput(format!("Session {id} not found")))?;

        if !handle.alive.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(AetherError::InvalidInput(format!(
                "Session {id} is not alive"
            )));
        }

        let writer = handle
            .writer
            .as_mut()
            .ok_or_else(|| AetherError::InvalidInput(format!("Session {id} writer already taken")))?;

        writer.write_all(data.as_bytes()).map_err(AetherError::Io)?;
        writer.flush().map_err(AetherError::Io)?;

        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), AetherError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| AetherError::InvalidInput(format!("Session lock poisoned: {e}")))?;

        let handle = sessions
            .get(id)
            .ok_or_else(|| AetherError::InvalidInput(format!("Session {id} not found")))?;

        handle
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AetherError::InvalidInput(format!("Failed to resize PTY: {e}")))?;

        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), AetherError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| AetherError::InvalidInput(format!("Session lock poisoned: {e}")))?;

        if let Some(handle) = sessions.remove(id) {
            handle
                .alive
                .store(false, std::sync::atomic::Ordering::Relaxed);
            drop(handle.master);
            Ok(())
        } else {
            Err(AetherError::InvalidInput(format!(
                "Session {id} not found"
            )))
        }
    }

    pub fn list(&self) -> Result<Vec<TerminalSession>, AetherError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| AetherError::InvalidInput(format!("Session lock poisoned: {e}")))?;

        Ok(sessions
            .iter()
            .map(|(id, h)| TerminalSession {
                id: id.clone(),
                cwd: h.cwd.clone(),
                shell: h.shell.clone(),
                alive: h.alive.load(std::sync::atomic::Ordering::Relaxed),
            })
            .collect())
    }

    pub fn cleanup_dead(&self) -> Result<usize, AetherError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| AetherError::InvalidInput(format!("Session lock poisoned: {e}")))?;

        let before = sessions.len();
        sessions.retain(|_, h| h.alive.load(std::sync::atomic::Ordering::Relaxed));
        Ok(before - sessions.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn spawn_and_write_echo() {
        let manager = TerminalManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();

        let session = manager
            .spawn(None, None, 80, 24, move |_id, output| {
                let _ = tx.send(output.to_vec());
            })
            .expect("spawn should succeed");

        assert!(!session.id.is_empty());
        assert!(session.alive);

        manager
            .write(&session.id, "echo aether_test_42\n")
            .expect("write should succeed");

        let mut combined = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(500)) {
                combined.extend_from_slice(&chunk);
                if combined.windows(14).any(|w| w == b"aether_test_42") {
                    break;
                }
            } else {
                break;
            }
        }

        assert!(
            combined.windows(14).any(|w| w == b"aether_test_42"),
            "expected output to contain 'aether_test_42', got: {}",
            String::from_utf8_lossy(&combined)
        );

        manager.kill(&session.id).expect("kill should succeed");
    }

    /// The transport must be byte-exact: binary output (which no terminal
    /// can render as text) arrives unmodified instead of being mangled into
    /// replacement characters. This is what used to produce rows of "tofu"
    /// glyphs for the user.
    #[test]
    fn output_is_byte_exact_for_binary() {
        let manager = TerminalManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();

        let session = manager
            .spawn(None, None, 80, 24, move |_id, output| {
                let _ = tx.send(output.to_vec());
            })
            .expect("spawn should succeed");

        // 0xFF and a 4-byte UTF-8 emoji split across the boundary are the
        // classic corruption cases.
        manager
            .write(&session.id, "printf '\\xff\\xfe\\xf0\\x9f\\x91\\x80'\n")
            .expect("write should succeed");

        let mut combined = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(500)) {
                combined.extend_from_slice(&chunk);
                if combined.contains(&0xFF) && combined.windows(4).any(|w| w == [0xF0, 0x9F, 0x91, 0x80]) {
                    break;
                }
            } else {
                break;
            }
        }

        assert!(
            combined.contains(&0xFF),
            "raw 0xFF byte must survive the transport untouched"
        );
        assert!(
            combined.windows(4).any(|w| w == [0xF0, 0x9F, 0x91, 0x80]),
            "multi-byte UTF-8 must arrive unsplit/unmangled"
        );

        manager.kill(&session.id).expect("kill should succeed");
    }

    #[test]
    fn resize_does_not_error() {
        let manager = TerminalManager::new();
        let (tx, _rx) = mpsc::channel::<Vec<u8>>();

        let session = manager
            .spawn(None, None, 80, 24, move |_id, output| {
                let _ = tx.send(output.to_vec());
            })
            .expect("spawn should succeed");

        manager
            .resize(&session.id, 120, 40)
            .expect("resize should succeed");

        manager.kill(&session.id).expect("kill should succeed");
    }

    #[test]
    fn list_returns_active_sessions() {
        let manager = TerminalManager::new();
        let (tx, _rx) = mpsc::channel::<Vec<u8>>();

        let session = manager
            .spawn(None, None, 80, 24, move |_id, output| {
                let _ = tx.send(output.to_vec());
            })
            .expect("spawn should succeed");

        let list = manager.list().expect("list should succeed");
        assert!(list.iter().any(|s| s.id == session.id));

        manager.kill(&session.id).expect("kill should succeed");

        let list_after = manager.list().expect("list should succeed");
        assert!(!list_after.iter().any(|s| s.id == session.id));
    }

    #[test]
    fn preserves_multibyte_utf8_output_intact() {
        let manager = TerminalManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();

        let session = manager
            .spawn(None, None, 80, 24, move |_id, output| {
                let _ = tx.send(output.to_vec());
            })
            .expect("spawn should succeed");

        // Emit a marker string containing multi-byte UTF-8 characters
        // (checkmark, arrow, emoji) that could straddle a read-buffer
        // boundary and get corrupted by naive from_utf8_lossy chunking.
        manager
            .write(
                &session.id,
                "printf 'MARKER_START\\xe2\\x9c\\x94\\xe2\\x86\\x92\\xf0\\x9f\\x9a\\x80MARKER_END\\n'\n",
            )
            .expect("write should succeed");

        let expected = "MARKER_START\u{2714}\u{2192}\u{1F680}MARKER_END";
        let mut combined: Vec<u8> = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if combined.windows(expected.len()).any(|w| w == expected.as_bytes()) {
                break;
            }
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(500)) {
                combined.extend_from_slice(&chunk);
            } else {
                break;
            }
        }

        let combined_str = String::from_utf8_lossy(&combined);
        assert!(
            combined_str.contains(expected),
            "expected intact multi-byte UTF-8 sequence, got: {combined_str:?}"
        );
        assert!(
            !combined.contains(&0xEF) || !combined.windows(3).any(|w| w == [0xEF, 0xBF, 0xBD]),
            "output should not contain UTF-8 replacement characters, got: {combined_str:?}"
        );

        manager.kill(&session.id).expect("kill should succeed");
    }

    #[test]
    fn tags_output_with_the_correct_session_id_across_concurrent_sessions() {
        let manager = TerminalManager::new();
        let (tx, rx) = mpsc::channel::<(String, Vec<u8>)>();

        let tx_a = tx.clone();
        let session_a = manager
            .spawn(None, None, 80, 24, move |id, output| {
                let _ = tx_a.send((id.to_string(), output.to_vec()));
            })
            .expect("spawn a should succeed");

        let tx_b = tx.clone();
        let session_b = manager
            .spawn(None, None, 80, 24, move |id, output| {
                let _ = tx_b.send((id.to_string(), output.to_vec()));
            })
            .expect("spawn b should succeed");

        manager
            .write(&session_a.id, "echo AAA_MARKER\n")
            .expect("write a should succeed");
        manager
            .write(&session_b.id, "echo BBB_MARKER\n")
            .expect("write b should succeed");

        let mut combined_a: Vec<u8> = Vec::new();
        let mut combined_b: Vec<u8> = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if combined_a.windows(10).any(|w| w == b"AAA_MARKER")
                && combined_b.windows(10).any(|w| w == b"BBB_MARKER")
            {
                break;
            }
            if let Ok((id, chunk)) = rx.recv_timeout(Duration::from_millis(500)) {
                if id == session_a.id {
                    combined_a.extend_from_slice(&chunk);
                } else if id == session_b.id {
                    combined_b.extend_from_slice(&chunk);
                }
            } else {
                break;
            }
        }

        let out_a = String::from_utf8_lossy(&combined_a);
        let out_b = String::from_utf8_lossy(&combined_b);
        assert!(
            out_a.contains("AAA_MARKER"),
            "session A should receive its own output, got: {out_a:?}"
        );
        assert!(
            !out_a.contains("BBB_MARKER"),
            "session A must never receive session B's output, got: {out_a:?}"
        );
        assert!(
            out_b.contains("BBB_MARKER"),
            "session B should receive its own output, got: {out_b:?}"
        );
        assert!(
            !out_b.contains("AAA_MARKER"),
            "session B must never receive session A's output, got: {out_b:?}"
        );

        manager.kill(&session_a.id).expect("kill a should succeed");
        manager.kill(&session_b.id).expect("kill b should succeed");
    }

    #[test]
    fn write_to_nonexistent_session_errors() {
        let manager = TerminalManager::new();
        let result = manager.write("nonexistent", "hello");
        assert!(result.is_err());
    }

    #[test]
    fn kill_nonexistent_session_errors() {
        let manager = TerminalManager::new();
        let result = manager.kill("nonexistent");
        assert!(result.is_err());
    }
}
