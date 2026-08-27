use crate::engine::error::AetherError;
use std::path::{Path, PathBuf};

/// Persists AI provider settings (e.g. the OpenRouter API key) inside the
/// app data directory, away from the webview's localStorage.
pub struct AiConfigStore {
    config_dir: PathBuf,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct AiConfig {
    openrouter_api_key: Option<String>,
}

impl AiConfigStore {
    pub fn new(config_dir: &Path) -> Result<Self, AetherError> {
        std::fs::create_dir_all(config_dir)?;
        Ok(Self {
            config_dir: config_dir.to_path_buf(),
        })
    }

    fn config_path(&self) -> PathBuf {
        self.config_dir.join("ai_config.json")
    }

    fn load(&self) -> AiConfig {
        let path = self.config_path();
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(config) = serde_json::from_str::<AiConfig>(&content) {
                    return config;
                }
            }
        }
        AiConfig::default()
    }

    fn save(&self, config: &AiConfig) -> Result<(), AetherError> {
        let content = serde_json::to_string_pretty(config)
            .map_err(|e| AetherError::AiEngine(format!("config serialize: {e}")))?;
        std::fs::write(self.config_path(), content)?;
        Ok(())
    }

    /// Stores or clears (`None`) the OpenRouter API key.
    pub fn set_openrouter_key(&self, key: Option<&str>) -> Result<(), AetherError> {
        let mut config = self.load();
        config.openrouter_api_key = key
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_owned);
        self.save(&config)
    }

    pub fn openrouter_key(&self) -> Option<String> {
        self.load().openrouter_api_key
    }
}

#[cfg(test)]
mod tests {
    use super::AiConfigStore;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aether-ai-config-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn key_round_trips() {
        let dir = temp_dir("roundtrip");
        let store = AiConfigStore::new(&dir).expect("store must build");
        assert_eq!(store.openrouter_key(), None);

        store.set_openrouter_key(Some("sk-or-v1-abc")).unwrap();
        let reopened = AiConfigStore::new(&dir).expect("reopen must build");
        assert_eq!(reopened.openrouter_key(), Some("sk-or-v1-abc".to_owned()));
    }

    #[test]
    fn empty_and_whitespace_keys_are_stored_as_none() {
        let dir = temp_dir("blank");
        let store = AiConfigStore::new(&dir).expect("store must build");
        store.set_openrouter_key(Some("   ")).unwrap();
        assert_eq!(store.openrouter_key(), None);
    }

    #[test]
    fn clearing_removes_the_key() {
        let dir = temp_dir("clear");
        let store = AiConfigStore::new(&dir).expect("store must build");
        store.set_openrouter_key(Some("sk-or-v1-abc")).unwrap();
        store.set_openrouter_key(None).unwrap();
        assert_eq!(store.openrouter_key(), None);
    }
}
