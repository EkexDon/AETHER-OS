use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

const DEFAULT_ENDPOINT: &str = "http://localhost:11434";

/// Client for a locally running Ollama instance. No request ever leaves the machine.
#[derive(Clone)]
pub struct LocalAiEngine {
    client: reqwest::Client,
    endpoint: String,
}

#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<TagEntry>,
}

#[derive(Deserialize)]
struct TagEntry {
    name: String,
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a str,
}

#[derive(Deserialize)]
struct EmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

#[derive(Serialize)]
struct LegacyEmbedRequest<'a> {
    model: &'a str,
    prompt: &'a str,
}

#[derive(Deserialize)]
struct LegacyEmbedResponse {
    embedding: Vec<f32>,
}

#[derive(Serialize)]
struct GenerateRequest<'a> {
    model: &'a str,
    prompt: &'a str,
    stream: bool,
    options: ChatOptions,
}

#[derive(Deserialize)]
struct GenerateChunk {
    response: String,
}

#[derive(Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage>,
    stream: bool,
    options: ChatOptions,
}

#[derive(Serialize)]
struct ChatOptions {
    num_ctx: u32,
    num_predict: i32,
}

#[derive(Deserialize)]
struct ChatChunk {
    message: Option<ChatChunkMessage>,
}

#[derive(Deserialize)]
struct ChatChunkMessage {
    content: String,
}

impl LocalAiEngine {
    pub fn new() -> Result<Self, AetherError> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(2))
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|error| AetherError::AiEngine(error.to_string()))?;
        Ok(Self {
            client,
            endpoint: DEFAULT_ENDPOINT.to_owned(),
        })
    }

    pub async fn check_ollama_status(&self) -> bool {
        self.list_models().await.is_ok()
    }

    /// Names of every model installed in the local Ollama instance.
    pub async fn list_models(&self) -> Result<Vec<String>, AetherError> {
        let response = self
            .client
            .get(format!("{}/api/tags", self.endpoint))
            .send()
            .await
            .map_err(|_| {
                AetherError::AiEngine(
                    "Ollama is not reachable on localhost:11434. Start it with: ollama serve"
                        .to_owned(),
                )
            })?
            .error_for_status()
            .map_err(|error| AetherError::AiEngine(error.to_string()))?
            .json::<TagsResponse>()
            .await
            .map_err(|error| AetherError::AiEngine(error.to_string()))?;
        Ok(response
            .models
            .into_iter()
            .map(|entry| entry.name)
            .collect())
    }

    /// Generates an embedding locally, supporting both the current and legacy Ollama endpoints.
    pub async fn generate_embedding(
        &self,
        text: &str,
        model: &str,
    ) -> Result<Vec<f32>, AetherError> {
        if text.trim().is_empty() || model.trim().is_empty() {
            return Err(AetherError::InvalidInput(
                "embedding text and model are required".to_owned(),
            ));
        }

        let modern = self
            .client
            .post(format!("{}/api/embed", self.endpoint))
            .json(&EmbedRequest { model, input: text })
            .send()
            .await
            .map_err(|error| self.unreachable(error))?;

        if modern.status().is_success() {
            let parsed = modern
                .json::<EmbedResponse>()
                .await
                .map_err(|error| AetherError::AiEngine(error.to_string()))?;
            return parsed
                .embeddings
                .into_iter()
                .next()
                .ok_or_else(|| AetherError::AiEngine("Ollama returned no embedding".to_owned()));
        }

        let legacy = self
            .client
            .post(format!("{}/api/embeddings", self.endpoint))
            .json(&LegacyEmbedRequest {
                model,
                prompt: text,
            })
            .send()
            .await
            .map_err(|error| self.unreachable(error))?;

        if legacy.status().is_success() {
            let parsed = legacy
                .json::<LegacyEmbedResponse>()
                .await
                .map_err(|error| AetherError::AiEngine(error.to_string()))?;
            if parsed.embedding.is_empty() {
                return Err(AetherError::AiEngine(
                    "Ollama returned an empty embedding".to_owned(),
                ));
            }
            return Ok(parsed.embedding);
        }

        Err(self.missing_model(model, legacy.status()).await)
    }

    /// Streams a completion from the local model, invoking the callback per token chunk.
    pub async fn stream_llm_response<F>(
        &self,
        prompt: &str,
        model: &str,
        mut chunk_callback: F,
    ) -> Result<(), AetherError>
    where
        F: FnMut(String) + Send,
    {
        let response = self
            .client
            .post(format!("{}/api/generate", self.endpoint))
            .json(&GenerateRequest {
                model,
                prompt,
                stream: true,
                options: ChatOptions {
                    num_ctx: 4096,
                    num_predict: -1,
                },
            })
            .send()
            .await
            .map_err(|error| self.unreachable(error))?;

        if !response.status().is_success() {
            return Err(self.missing_model(model, response.status()).await);
        }

        let mut stream = response.bytes_stream();
        let mut buffered = String::new();
        while let Some(next) = stream.next().await {
            let bytes = next.map_err(|error| AetherError::AiEngine(error.to_string()))?;
            buffered.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(index) = buffered.find('\n') {
                let line = buffered[..index].trim().to_owned();
                buffered.drain(..=index);
                if line.is_empty() {
                    continue;
                }
                let chunk: GenerateChunk = serde_json::from_str(&line).map_err(|error| {
                    AetherError::AiEngine(format!("invalid Ollama stream chunk: {error}"))
                })?;
                if !chunk.response.is_empty() {
                    chunk_callback(chunk.response);
                }
            }
        }
        Ok(())
    }

    /// Streams a chat completion with system context, invoking the callback per token chunk.
    pub async fn stream_chat_response<F>(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        model: &str,
        mut chunk_callback: F,
    ) -> Result<(), AetherError>
    where
        F: FnMut(String) + Send,
    {
        let messages = vec![
            ChatMessage {
                role: "system".to_owned(),
                content: system_prompt.to_owned(),
            },
            ChatMessage {
                role: "user".to_owned(),
                content: user_prompt.to_owned(),
            },
        ];

        let response = self
            .client
            .post(format!("{}/api/chat", self.endpoint))
            .json(&ChatRequest {
                model,
                messages,
                stream: true,
                options: ChatOptions {
                    num_ctx: 4096,
                    num_predict: -1,
                },
            })
            .send()
            .await
            .map_err(|error| self.unreachable(error))?;

        if !response.status().is_success() {
            return Err(self.missing_model(model, response.status()).await);
        }

        let mut stream = response.bytes_stream();
        let mut buffered = String::new();
        while let Some(next) = stream.next().await {
            let bytes = next.map_err(|error| AetherError::AiEngine(error.to_string()))?;
            buffered.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(index) = buffered.find('\n') {
                let line = buffered[..index].trim().to_owned();
                buffered.drain(..=index);
                if line.is_empty() {
                    continue;
                }
                let chunk: ChatChunk = serde_json::from_str(&line).map_err(|error| {
                    AetherError::AiEngine(format!("invalid Ollama chat chunk: {error}"))
                })?;
                if let Some(msg) = &chunk.message {
                    if !msg.content.is_empty() {
                        chunk_callback(msg.content.clone());
                    }
                }
            }
        }
        Ok(())
    }

    fn unreachable(&self, error: reqwest::Error) -> AetherError {
        if error.is_connect() {
            return AetherError::AiEngine(
                "Ollama is not reachable on localhost:11434. Start it with: ollama serve"
                    .to_owned(),
            );
        }
        AetherError::AiEngine(error.to_string())
    }

    async fn missing_model(&self, model: &str, status: reqwest::StatusCode) -> AetherError {
        if status == reqwest::StatusCode::NOT_FOUND {
            let installed = self.list_models().await.unwrap_or_default();
            let available = if installed.is_empty() {
                "none".to_owned()
            } else {
                installed.join(", ")
            };
            return AetherError::AiEngine(format!(
                "Model '{model}' is not installed. Run: ollama pull {model} (installed: {available})"
            ));
        }
        AetherError::AiEngine(format!("Ollama request failed with status {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::LocalAiEngine;

    #[test]
    fn constructs_a_local_only_client() {
        assert!(LocalAiEngine::new().is_ok());
    }

    #[tokio::test]
    async fn rejects_empty_embedding_input() {
        let engine = LocalAiEngine::new().expect("engine must build");
        let error = engine
            .generate_embedding("   ", "nomic-embed-text")
            .await
            .expect_err("empty text must be rejected");
        assert!(error.to_string().contains("required"));
    }
}
