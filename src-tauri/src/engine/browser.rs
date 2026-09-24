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
        let mut candidates: Vec<std::path::PathBuf> = [
            "/Applications/LibreWolf.app/Contents/MacOS/librewolf",
            "/usr/bin/librewolf",
            "/usr/local/bin/librewolf",
            "/opt/homebrew/bin/librewolf",
        ]
        .iter()
        .map(std::path::PathBuf::from)
        .collect();
        if cfg!(windows) {
            for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
                if let Some(base) = std::env::var_os(var) {
                    candidates.push(
                        std::path::PathBuf::from(base)
                            .join("LibreWolf")
                            .join("librewolf.exe"),
                    );
                }
            }
        }

        for path in &candidates {
            if path.is_file() {
                return Some(path.to_string_lossy().into_owned());
            }
        }

        // Anywhere on PATH (Flatpak / Nix / custom installs).
        crate::engine::lsp::find_in_path("librewolf").map(|p| p.to_string_lossy().into_owned())
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
    /// the system default browser via `open`. Only `http`, `https` and
    /// `mailto` URLs are accepted (see [`validate_external_url`]).
    pub fn open_url(&self, url: &str) -> Result<(), AetherError> {
        let parsed = validate_external_url(url)?;
        let url = parsed.as_str();
        if let Some(ref path) = self.librewolf_path {
            Command::new(path).arg(url).spawn().map_err(|e| {
                AetherError::InvalidInput(format!("Failed to launch LibreWolf: {e}"))
            })?;
        } else {
            // Fallback: the system default browser (`open`, `rundll32`,
            // `xdg-open` — never through a shell, so `&` in a query string
            // is not a command separator).
            crate::engine::desktop::open_url_with_system(&parsed)?;
        }
        Ok(())
    }

    /// Open a URL in LibreWolf specifically, erroring if not installed.
    pub fn open_in_librewolf(&self, url: &str) -> Result<(), AetherError> {
        let url = validate_external_url(url)?;
        let url = url.as_str();
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

/// Parse a URL that is handed to an external program (the system browser,
/// LibreWolf). Only `http`, `https` and `mailto` are allowed: `open` would
/// launch applications and scripts for `file:` URLs or plain paths, and a
/// leading `-` would be read as an option.
pub fn validate_external_url(raw: &str) -> Result<url::Url, AetherError> {
    let trimmed = raw.trim();
    let url = url::Url::parse(trimmed)
        .map_err(|_| AetherError::InvalidInput(format!("not a valid URL: {trimmed}")))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some_and(|h| !h.is_empty()) => Ok(url),
        "mailto" => Ok(url),
        other => Err(AetherError::InvalidInput(format!(
            "only http, https and mailto links can be opened (got \"{other}:\")"
        ))),
    }
}

/// Parse a URL for the embedded browser webview: `http`/`https` pages and
/// `about:blank` only (no `file:`, `javascript:`, `data:` or app URLs).
pub fn validate_webview_url(raw: &str) -> Result<url::Url, AetherError> {
    let trimmed = raw.trim();
    let url = url::Url::parse(trimmed)
        .map_err(|_| AetherError::InvalidInput(format!("not a valid URL: {trimmed}")))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some_and(|h| !h.is_empty()) => Ok(url),
        "about" if url.path() == "blank" => Ok(url),
        other => Err(AetherError::InvalidInput(format!(
            "the built-in browser only opens http and https pages (got \"{other}:\")"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_urls_are_limited_to_web_and_mail_links() {
        for ok in [
            "https://example.com/a?b=c",
            "http://localhost:11434",
            "  https://openrouter.ai  ",
            "mailto:someone@example.com",
        ] {
            assert!(validate_external_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "file:///Applications/Calculator.app",
            "/Applications/Calculator.app",
            "-a Calculator",
            "javascript:alert(1)",
            "vscode://file/etc/passwd",
            "smb://server/share",
            "https://",
            "",
        ] {
            assert!(validate_external_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn webview_urls_are_web_pages_or_about_blank() {
        assert!(validate_webview_url("https://duckduckgo.com/?q=x").is_ok());
        assert!(validate_webview_url("about:blank").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "tauri://localhost",
            "about:config",
        ] {
            assert!(validate_webview_url(bad).is_err(), "{bad}");
        }
    }

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
        let mgr = BrowserManager {
            librewolf_path: None,
        };
        // Rejected before any process is spawned.
        assert!(mgr.open_url("about:blank").is_err());
        assert!(mgr.open_url("file:///etc/passwd").is_err());
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
