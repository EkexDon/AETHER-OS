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
    fn display_includes_error_category() {
        let error = AetherError::InvalidInput("title is required".to_owned());
        assert_eq!(error.to_string(), "invalid input: title is required");
    }
}
