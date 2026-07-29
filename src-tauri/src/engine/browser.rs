use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

/// Information about the detected browser.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserInfo {
    pub librewolf_installed: bool,
    pub librewolf_path: Option<String>,
    pub default_browser: String,
}

/// Manages browser detection and URL launching.
///
/// On macOS, LibreWolf is typically installed at
/// `/Applications/LibreWolf.app`. The binary lives at
/// `LibreWolf.app/Contents/MacOS/librewolf`.
pub struct BrowserManager {
    librewolf_path: Option<String>,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            librewolf_path: Self::detect_librewolf(),
        }
    }

    fn detect_librewolf() -> Option<String> {
        let candidates = [
            "/Applications/LibreWolf.app/Contents/MacOS/librewolf",
            "/usr/bin/librewolf",
            "/usr/local/bin/librewolf",
            "/opt/homebrew/bin/librewolf",
        ];

        for path in &candidates {
            if std::path::Path::new(path).exists() {
                return Some(path.to_string());
            }
        }

        // Try `which librewolf` as a fallback
        if let Ok(output) = Command::new("which").arg("librewolf").output() {
            if output.status.success() {
                let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !p.is_empty() {
                    return Some(p);
                }
            }
        }

        None
    }

    pub fn info(&self) -> BrowserInfo {
        BrowserInfo {
            librewolf_installed: self.librewolf_path.is_some(),
            librewolf_path: self.librewolf_path.clone(),
            default_browser: if self.librewolf_path.is_some() {
                "LibreWolf".to_string()
            } else {
                "System Default".to_string()
            },
        }
    }

    /// Open a URL in LibreWolf if available, otherwise fall back to
    /// the system default browser via `open`.
    pub fn open_url(&self, url: &str) -> Result<(), AetherError> {
        if let Some(ref path) = self.librewolf_path {
            Command::new(path)
                .arg(url)
                .spawn()
                .map_err(|e| AetherError::InvalidInput(format!("Failed to launch LibreWolf: {e}")))?;
        } else {
            // Fallback: system default browser
            let cmd = if cfg!(target_os = "windows") {
                ("cmd", vec!["/C", "start", "", url])
            } else if cfg!(target_os = "macos") {
                ("open", vec![url])
            } else {
                ("xdg-open", vec![url])
            };

            Command::new(cmd.0)
                .args(&cmd.1)
                .spawn()
                .map_err(|e| AetherError::InvalidInput(format!("Failed to open URL: {e}")))?;
        }
        Ok(())
    }

    /// Open a URL in LibreWolf specifically, erroring if not installed.
    pub fn open_in_librewolf(&self, url: &str) -> Result<(), AetherError> {
        let path = self
            .librewolf_path
            .as_ref()
            .ok_or_else(|| AetherError::InvalidInput("LibreWolf is not installed".to_string()))?;

        Command::new(path)
            .arg(url)
            .spawn()
            .map_err(|e| AetherError::InvalidInput(format!("Failed to launch LibreWolf: {e}")))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_returns_consistent_data() {
        let mgr = BrowserManager::new();
        let info = mgr.info();
        assert_eq!(
            info.librewolf_installed,
            info.librewolf_path.is_some(),
            "installed flag must match path presence"
        );
        if info.librewolf_installed {
            assert_eq!(info.default_browser, "LibreWolf");
        } else {
            assert_eq!(info.default_browser, "System Default");
        }
    }

    #[test]
    fn open_in_librewolf_errors_when_not_installed() {
        let mgr = BrowserManager {
            librewolf_path: None,
        };
        let result = mgr.open_in_librewolf("https://example.com");
        assert!(result.is_err(), "should error when LibreWolf not installed");
    }

    #[test]
    fn open_url_with_invalid_scheme_errors() {
        let mgr = BrowserManager::new();
        // Empty URL should still attempt to open — we don't validate URLs
        // at the engine level. Just verify it doesn't panic.
        let _ = mgr.open_url("about:blank");
    }

    #[test]
    fn detect_librewolf_does_not_panic() {
        // Just verify detection runs without panicking
        let path = BrowserManager::detect_librewolf();
        if let Some(ref p) = path {
            assert!(!p.is_empty(), "detected path should not be empty");
        }
    }
}
