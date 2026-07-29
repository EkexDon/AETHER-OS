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
        on_output: impl Fn(String) + Send + 'static,
    ) -> Result<TerminalSession, AetherError> {
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

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        on_output(data);
                    }
                    Err(_) => break,
                }
            }
            alive_clone.store(false, std::sync::atomic::Ordering::Relaxed);
        });

        let id = Uuid::new_v4().to_string();
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
        let (tx, rx) = mpsc::channel::<String>();

        let session = manager
            .spawn(None, None, 80, 24, move |output| {
                let _ = tx.send(output);
            })
            .expect("spawn should succeed");

        assert!(!session.id.is_empty());
        assert!(session.alive);

        manager
            .write(&session.id, "echo aether_test_42\n")
            .expect("write should succeed");

        let mut combined = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(500)) {
                combined.push_str(&chunk);
                if combined.contains("aether_test_42") {
                    break;
                }
            } else {
                break;
            }
        }

        assert!(
            combined.contains("aether_test_42"),
            "expected output to contain 'aether_test_42', got: {combined}"
        );

        manager.kill(&session.id).expect("kill should succeed");
    }

    #[test]
    fn resize_does_not_error() {
        let manager = TerminalManager::new();
        let (tx, _rx) = mpsc::channel::<String>();

        let session = manager
            .spawn(None, None, 80, 24, move |output| {
                let _ = tx.send(output);
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
        let (tx, _rx) = mpsc::channel::<String>();

        let session = manager
            .spawn(None, None, 80, 24, move |output| {
                let _ = tx.send(output);
            })
            .expect("spawn should succeed");

        let list = manager.list().expect("list should succeed");
        assert!(list.iter().any(|s| s.id == session.id));

        manager.kill(&session.id).expect("kill should succeed");

        let list_after = manager.list().expect("list should succeed");
        assert!(!list_after.iter().any(|s| s.id == session.id));
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
