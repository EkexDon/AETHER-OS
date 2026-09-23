//! User settings of the search feature, persisted in
//! `<data_dir>/search/settings.json`.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri_plugin_global_shortcut::{Modifiers, Shortcut};

use super::SearchKind;
use crate::engine::error::AetherError;

/// The system-wide shortcut used when none is configured.
pub const DEFAULT_GLOBAL_SHORTCUT: &str = "Alt+Space";
/// Upper bound for user-provided file index roots.
pub const MAX_FILE_ROOTS: usize = 32;

/// Settings shown in Settings → Search.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchSettings {
    /// Register [`SearchSettings::global_shortcut`] system-wide.
    #[serde(default = "default_true")]
    pub global_shortcut_enabled: bool,
    /// Accelerator such as `Alt+Space` or `CommandOrControl+Shift+Space`.
    #[serde(default = "default_shortcut")]
    pub global_shortcut: String,
    /// Kinds that are indexed and searched.
    #[serde(default = "SearchKind::all")]
    pub kinds: Vec<SearchKind>,
    /// Folders whose files are indexed; empty means "every project root".
    #[serde(default)]
    pub file_roots: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn default_shortcut() -> String {
    DEFAULT_GLOBAL_SHORTCUT.to_owned()
}

impl Default for SearchSettings {
    fn default() -> Self {
        Self {
            global_shortcut_enabled: true,
            global_shortcut: default_shortcut(),
            kinds: SearchKind::all(),
            file_roots: Vec::new(),
        }
    }
}

/// Parse and validate a global shortcut. It needs at least one of
/// Alt/Ctrl/Cmd (Shift alone would hijack normal typing everywhere).
pub fn parse_global_shortcut(raw: &str) -> Result<Shortcut, AetherError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AetherError::InvalidInput("shortcut is empty".to_owned()));
    }
    let shortcut = Shortcut::from_str(trimmed)
        .map_err(|e| AetherError::InvalidInput(format!("invalid shortcut \"{trimmed}\": {e}")))?;
    let strong = Modifiers::ALT | Modifiers::CONTROL | Modifiers::SUPER | Modifiers::META;
    if !shortcut.mods.intersects(strong) {
        return Err(AetherError::InvalidInput(format!(
            "shortcut \"{trimmed}\" needs Alt, Ctrl or Cmd"
        )));
    }
    Ok(shortcut)
}

impl SearchSettings {
    /// Validate and normalise: the shortcut must parse, kinds are
    /// de-duplicated (at least one required), file roots must be absolute
    /// existing directories other than the filesystem root.
    pub fn validated(mut self) -> Result<Self, AetherError> {
        self.global_shortcut = self.global_shortcut.trim().to_owned();
        parse_global_shortcut(&self.global_shortcut)?;

        let mut kinds = Vec::new();
        for kind in self.kinds {
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
        }
        if kinds.is_empty() {
            return Err(AetherError::InvalidInput(
                "select at least one kind of result to search".to_owned(),
            ));
        }
        self.kinds = kinds;

        let mut roots: Vec<String> = Vec::new();
        for raw in self.file_roots {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let path = Path::new(trimmed);
            if !path.is_absolute() {
                return Err(AetherError::InvalidInput(format!(
                    "file index folder must be an absolute path: {trimmed}"
                )));
            }
            let canonical = std::fs::canonicalize(path).map_err(|_| {
                AetherError::InvalidInput(format!("file index folder does not exist: {trimmed}"))
            })?;
            if !canonical.is_dir() {
                return Err(AetherError::InvalidInput(format!(
                    "file index folder is not a directory: {trimmed}"
                )));
            }
            if canonical.parent().is_none() {
                return Err(AetherError::InvalidInput(
                    "indexing the whole disk is not supported; pick a folder".to_owned(),
                ));
            }
            let normalized = canonical.to_string_lossy().to_string();
            if !roots.contains(&normalized) {
                roots.push(normalized);
            }
        }
        if roots.len() > MAX_FILE_ROOTS {
            return Err(AetherError::InvalidInput(format!(
                "at most {MAX_FILE_ROOTS} file index folders are supported"
            )));
        }
        self.file_roots = roots;
        Ok(self)
    }

    /// Is `kind` enabled?
    pub fn includes(&self, kind: SearchKind) -> bool {
        self.kinds.contains(&kind)
    }
}

/// JSON-backed settings store.
pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<SearchSettings>,
}

impl SettingsStore {
    /// Load settings from `path`; missing or invalid files yield defaults
    /// (individual invalid values are reset rather than failing start-up).
    pub fn open(path: &Path) -> Self {
        let loaded = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<SearchSettings>(&raw).ok())
            .map(|s| SearchSettings {
                global_shortcut: if parse_global_shortcut(&s.global_shortcut).is_ok() {
                    s.global_shortcut.clone()
                } else {
                    default_shortcut()
                },
                kinds: if s.kinds.is_empty() {
                    SearchKind::all()
                } else {
                    s.kinds.clone()
                },
                ..s
            })
            .unwrap_or_default();
        Self {
            path: path.to_path_buf(),
            current: Mutex::new(loaded),
        }
    }

    /// Current settings.
    pub fn get(&self) -> SearchSettings {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Validate, persist and apply new settings; returns the normalised value.
    pub fn set(&self, settings: SearchSettings) -> Result<SearchSettings, AetherError> {
        let valid = settings.validated()?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&valid)
            .map_err(|e| AetherError::InvalidInput(format!("settings serialize: {e}")))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path)?;
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = valid.clone();
        Ok(valid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_common_accelerators() {
        for ok in [
            "Alt+Space",
            "CommandOrControl+Shift+Space",
            "Ctrl+Alt+K",
            "Cmd+Shift+Period",
        ] {
            assert!(parse_global_shortcut(ok).is_ok(), "{ok} should parse");
        }
    }

    #[test]
    fn rejects_bad_or_weak_shortcuts() {
        for bad in ["", "Space", "Shift+K", "Alt+", "Alt+NotAKey", "K+Alt"] {
            assert!(
                parse_global_shortcut(bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn validation_normalises_kinds_and_roots() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().to_string_lossy().to_string();
        let settings = SearchSettings {
            global_shortcut_enabled: true,
            global_shortcut: "  Alt+Space ".into(),
            kinds: vec![SearchKind::Note, SearchKind::Note, SearchKind::File],
            file_roots: vec![root.clone(), format!("{root}/"), "   ".into()],
        }
        .validated()
        .expect("valid");
        assert_eq!(settings.global_shortcut, "Alt+Space");
        assert_eq!(settings.kinds, vec![SearchKind::Note, SearchKind::File]);
        assert_eq!(settings.file_roots.len(), 1);
        assert!(settings.includes(SearchKind::File) && !settings.includes(SearchKind::App));
    }

    #[test]
    fn validation_rejects_bad_roots_and_empty_kinds() {
        let base = SearchSettings::default();
        let relative = SearchSettings {
            file_roots: vec!["relative/dir".into()],
            ..base.clone()
        };
        assert!(relative.validated().is_err());
        let missing = SearchSettings {
            file_roots: vec!["/definitely/not/here/xyz".into()],
            ..base.clone()
        };
        assert!(missing.validated().is_err());
        let disk = SearchSettings {
            file_roots: vec!["/".into()],
            ..base.clone()
        };
        assert!(disk.validated().is_err());
        let none = SearchSettings {
            kinds: vec![],
            ..base
        };
        assert!(none.validated().is_err());
    }

    #[test]
    fn store_persists_and_recovers_from_bad_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("search/settings.json");
        let store = SettingsStore::open(&path);
        assert_eq!(store.get(), SearchSettings::default());
        let saved = store
            .set(SearchSettings {
                global_shortcut_enabled: false,
                kinds: vec![SearchKind::App],
                ..SearchSettings::default()
            })
            .expect("save");
        assert_eq!(SettingsStore::open(&path).get(), saved);
        assert!(store
            .set(SearchSettings {
                global_shortcut: "nope".into(),
                ..saved.clone()
            })
            .is_err());
        assert_eq!(store.get(), saved, "failed save keeps the old value");

        std::fs::write(&path, r#"{"global_shortcut":"broken","kinds":[]}"#).expect("write");
        let recovered = SettingsStore::open(&path).get();
        assert_eq!(recovered.global_shortcut, DEFAULT_GLOBAL_SHORTCUT);
        assert_eq!(recovered.kinds, SearchKind::all());
    }
}
