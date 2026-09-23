use serde::ser::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AetherError {
    #[error("vector engine error: {0}")]
    Vector(String),
    #[error("AI engine error: {0}")]
    AiEngine(String),
    #[error("vault error: {0}")]
    Vault(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    /// SQLite failure from the shared helper in `engine/sqlite.rs`.
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    /// Outbound HTTP failure (offline, timeout, unexpected status).
    #[error("network error: {0}")]
    Network(String),
    /// Sync or backup failure: the sync folder or key state does not allow
    /// the operation, or stored sync/backup data is inconsistent.
    #[error("sync error: {0}")]
    Sync(String),
    /// Key handling or encryption failure: wrong passphrase, corrupt key
    /// material, unsupported KDF parameters, failed (de)encryption.
    #[error("crypto error: {0}")]
    Crypto(String),
}

impl Serialize for AetherError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::AetherError;

    #[test]
    fn serializes_a_safe_human_readable_error() {
        let error = AetherError::AiEngine("Ollama is unavailable".to_owned());
        let serialized = serde_json::to_string(&error).expect("error must serialize");
        assert_eq!(serialized, "\"AI engine error: Ollama is unavailable\"");
    }

    #[test]
    fn database_errors_convert_and_display_with_category() {
        let sqlite = rusqlite::Connection::open_in_memory().expect("in-memory db");
        let error: AetherError = sqlite
            .execute("NOT VALID SQL", [])
            .expect_err("invalid SQL must fail")
            .into();
        assert!(error.to_string().starts_with("database error: "));
    }

    #[test]
    fn sync_and_crypto_errors_serialize_with_their_category() {
        let sync = AetherError::Sync("the sync folder is not reachable: /x".to_owned());
        assert_eq!(
            serde_json::to_string(&sync).expect("serialize"),
            "\"sync error: the sync folder is not reachable: /x\""
        );
        let crypto = AetherError::Crypto("wrong passphrase".to_owned());
        assert_eq!(crypto.to_string(), "crypto error: wrong passphrase");
        assert_eq!(
            serde_json::to_string(&crypto).expect("serialize"),
            "\"crypto error: wrong passphrase\""
        );
    }

    #[test]
    fn display_includes_error_category() {
        let error = AetherError::InvalidInput("title is required".to_owned());
        assert_eq!(error.to_string(), "invalid input: title is required");
    }
}
