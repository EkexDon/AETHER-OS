use crate::engine::error::AetherError;
use crate::engine::onboarding::validate_model_name;
use std::path::{Path, PathBuf};

/// Ollama model that turns notes into vectors unless the user picks another.
pub const DEFAULT_EMBEDDING_MODEL: &str = "nomic-embed-text";

/// Persists AI provider settings (the OpenRouter API key, the embedding
/// model) inside the app data directory, away from the webview's
/// localStorage.
pub struct AiConfigStore {
    config_dir: PathBuf,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct AiConfig {
    openrouter_api_key: Option<String>,
    /// Ollama embedding model; `None` = [`DEFAULT_EMBEDDING_MODEL`].
    #[serde(default)]
    embedding_model: Option<String>,
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

    /// The Ollama model used for note embeddings (index and queries).
    pub fn embedding_model(&self) -> String {
        self.load()
            .embedding_model
            .map(|m| m.trim().to_owned())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.to_owned())
    }

    /// Validate (a non-empty Ollama model name) and store the embedding
    /// model. Returns the stored name. The caller must reset the vector
    /// index when the model changes: vectors of different models do not mix.
    pub fn set_embedding_model(&self, model: &str) -> Result<String, AetherError> {
        let model = validate_model_name(model)?;
        let mut config = self.load();
        config.embedding_model = Some(model.clone());
        self.save(&config)?;
        Ok(model)
    }
}

#[cfg(test)]
mod tests {
    use super::{AiConfigStore, DEFAULT_EMBEDDING_MODEL};
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
    fn embedding_model_defaults_and_persists() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = AiConfigStore::new(dir.path()).expect("store must build");
        assert_eq!(store.embedding_model(), DEFAULT_EMBEDDING_MODEL);

        assert_eq!(
            store
                .set_embedding_model("  mxbai-embed-large ")
                .expect("valid model"),
            "mxbai-embed-large"
        );
        let reopened = AiConfigStore::new(dir.path()).expect("reopen must build");
        assert_eq!(reopened.embedding_model(), "mxbai-embed-large");
    }

    #[test]
    fn embedding_model_rejects_empty_or_invalid_names() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = AiConfigStore::new(dir.path()).expect("store must build");
        for bad in ["", "   ", "../evil", "bad name", "-dash-first"] {
            assert!(store.set_embedding_model(bad).is_err(), "{bad:?} must fail");
        }
        assert_eq!(store.embedding_model(), DEFAULT_EMBEDDING_MODEL);
    }

    #[test]
    fn embedding_model_and_key_do_not_clobber_each_other() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = AiConfigStore::new(dir.path()).expect("store must build");
        store.set_openrouter_key(Some("sk-or-v1-abc")).unwrap();
        store.set_embedding_model("all-minilm").unwrap();
        store.set_openrouter_key(Some("sk-or-v1-def")).unwrap();
        assert_eq!(store.embedding_model(), "all-minilm");
        assert_eq!(store.openrouter_key(), Some("sk-or-v1-def".to_owned()));

        // Files written before the field existed still load.
        std::fs::write(
            dir.path().join("ai_config.json"),
            r#"{"openrouter_api_key":"sk-or-v1-old"}"#,
        )
        .unwrap();
        assert_eq!(store.embedding_model(), DEFAULT_EMBEDDING_MODEL);
        assert_eq!(store.openrouter_key(), Some("sk-or-v1-old".to_owned()));
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
