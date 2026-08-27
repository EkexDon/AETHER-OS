use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

const DEFAULT_ENDPOINT: &str = "https://openrouter.ai";

/// Events produced while reading an OpenRouter SSE stream.
#[derive(Debug, PartialEq)]
pub enum SseEvent {
    /// A token chunk extracted from `choices[0].delta.content`.
    Content(String),
    /// The `data: [DONE]` sentinel terminating the stream.
    Done,
}

/// Parses one line of an OpenRouter SSE stream into an event.
pub fn parse_sse_line(line: &str) -> Option<SseEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return None;
    }
    let payload = trimmed.strip_prefix("data:")?.trim();
    if payload == "[DONE]" {
        return Some(SseEvent::Done);
    }
    let chunk = serde_json::from_str::<StreamChunk>(payload).ok()?;
    let content = chunk
        .choices
        .as_ref()?
        .first()?
        .delta
        .as_ref()?
        .content
        .clone()?;
    if content.is_empty() {
        return None;
    }
    Some(SseEvent::Content(content))
}

#[derive(Deserialize)]
struct StreamChunk {
    choices: Option<Vec<StreamChoice>>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: Option<Delta>,
}

#[derive(Deserialize)]
struct Delta {
    content: Option<String>,
}

#[derive(Serialize)]
pub struct CloudChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct CloudChatRequest {
    model: String,
    messages: Vec<CloudChatMessage>,
    stream: bool,
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

/// Client for the OpenRouter cloud API. Requests carry the user's API key
/// and leave the machine only towards openrouter.ai.
#[derive(Clone)]
pub struct CloudAiEngine {
    client: reqwest::Client,
    endpoint: String,
}

impl CloudAiEngine {
    pub fn new() -> Result<Self, AetherError> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|error| AetherError::AiEngine(error.to_string()))?;
        Ok(Self {
            client,
            endpoint: DEFAULT_ENDPOINT.to_owned(),
        })
    }

    fn require_key(&self, api_key: &str) -> Result<(), AetherError> {
        if api_key.trim().is_empty() {
            return Err(AetherError::AiEngine(
                "OpenRouter API key is missing. Set it in Settings → AI Providers.".to_owned(),
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn with_endpoint(mut self, endpoint: String) -> Self {
        self.endpoint = endpoint;
        self
    }

    /// True when the key authenticates successfully against OpenRouter.
    pub async fn check_key(&self, api_key: &str) -> bool {
        self.list_models(api_key).await.is_ok()
    }

    /// IDs of models available through OpenRouter for this account.
    pub async fn list_models(&self, api_key: &str) -> Result<Vec<String>, AetherError> {
        self.require_key(api_key)?;
        let response = self
            .client
            .get(format!("{}/api/v1/models", self.endpoint))
            .bearer_auth(api_key.trim())
            .send()
            .await
            .map_err(|error| self.unreachable(error))?
            .error_for_status()
            .map_err(|error| self.api_status(error.status()))?
            .json::<ModelsResponse>()
            .await
            .map_err(|error| AetherError::AiEngine(error.to_string()))?;
        Ok(response.data.into_iter().map(|entry| entry.id).collect())
    }

    /// Streams a chat completion from OpenRouter, invoking the callback per token chunk.
    pub async fn stream_chat_response<F>(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        model: &str,
        api_key: &str,
        mut chunk_callback: F,
    ) -> Result<(), AetherError>
    where
        F: FnMut(String) + Send,
    {
        self.require_key(api_key)?;

        let messages = vec![
            CloudChatMessage {
                role: "system".to_owned(),
                content: system_prompt.to_owned(),
            },
            CloudChatMessage {
                role: "user".to_owned(),
                content: user_prompt.to_owned(),
            },
        ];

        let response = self
            .client
            .post(format!("{}/api/v1/chat/completions", self.endpoint))
            .bearer_auth(api_key.trim())
            .header("HTTP-Referer", "https://aether-os.local")
            .header("X-Title", "AETHER-OS")
            .json(&CloudChatRequest {
                model: model.to_owned(),
                messages,
                stream: true,
            })
            .send()
            .await
            .map_err(|error| self.unreachable(error))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let detail = Self::extract_error_message(&body)
                .unwrap_or_else(|| format!("OpenRouter request failed with status {status}"));
            return Err(AetherError::AiEngine(detail));
        }

        let mut stream = response.bytes_stream();
        let mut buffered = String::new();
        while let Some(next) = stream.next().await {
            let bytes = next.map_err(|error| AetherError::AiEngine(error.to_string()))?;
            buffered.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(index) = buffered.find('\n') {
                let line = buffered[..index].to_owned();
                buffered.drain(..=index);
                match parse_sse_line(&line) {
                    Some(SseEvent::Content(text)) => chunk_callback(text),
                    Some(SseEvent::Done) | None => {}
                }
            }
        }
        Ok(())
    }

    fn extract_error_message(body: &str) -> Option<String> {
        let parsed = serde_json::from_str::<serde_json::Value>(body).ok()?;
        let message = parsed.get("error")?.get("message")?.as_str()?;
        Some(message.to_owned())
    }

    fn unreachable(&self, error: reqwest::Error) -> AetherError {
        if error.is_connect() || error.is_timeout() {
            return AetherError::AiEngine(
                "OpenRouter is not reachable. Check your internet connection.".to_owned(),
            );
        }
        AetherError::AiEngine(error.to_string())
    }

    fn api_status(&self, status: Option<reqwest::StatusCode>) -> AetherError {
        let detail = match status {
            Some(reqwest::StatusCode::UNAUTHORIZED) => {
                "OpenRouter API key is invalid.".to_owned()
            }
            Some(reqwest::StatusCode::PAYMENT_REQUIRED) => {
                "OpenRouter account is out of credits.".to_owned()
            }
            Some(reqwest::StatusCode::TOO_MANY_REQUESTS) => {
                "OpenRouter rate limit reached. Try again shortly.".to_owned()
            }
            other => format!("OpenRouter request failed with status {other:?}"),
        };
        AetherError::AiEngine(detail)
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_sse_line, CloudAiEngine, SseEvent};
    use std::io::Write;
    use std::net::TcpListener;

    #[test]
    fn extracts_delta_content_from_data_line() {
        let line = r#"data: {"id":"x","choices":[{"delta":{"content":"Hello"}}]}"#;
        assert_eq!(
            parse_sse_line(line),
            Some(SseEvent::Content("Hello".to_owned()))
        );
    }

    #[test]
    fn signals_done_sentinel() {
        assert_eq!(parse_sse_line("data: [DONE]"), Some(SseEvent::Done));
    }

    #[test]
    fn ignores_keepalive_comment_lines() {
        assert_eq!(parse_sse_line(": OPENROUTER PROCESSING"), None);
    }

    #[test]
    fn ignores_chunks_without_content() {
        let line = r#"data: {"id":"x","choices":[{"delta":{}}]}"#;
        assert_eq!(parse_sse_line(line), None);
    }

    #[test]
    fn ignores_plain_whitespace_lines() {
        assert_eq!(parse_sse_line(""), None);
        assert_eq!(parse_sse_line("   "), None);
    }

    #[tokio::test]
    async fn stream_rejects_missing_api_key_before_any_request() {
        let engine = CloudAiEngine::new().expect("engine must build");
        let error = engine
            .stream_chat_response("sys", "user", "anthropic/claude-sonnet-4", "", |_| {})
            .await
            .expect_err("empty key must be rejected");
        assert!(error.to_string().contains("API key"));
    }

    #[test]
    fn extracts_api_error_message_from_response_body() {
        let body = r#"{"error":{"message":"Insufficient credits"}}"#;
        assert_eq!(
            CloudAiEngine::extract_error_message(body),
            Some("Insufficient credits".to_owned())
        );
    }

    /// Serves a canned SSE chat-completion response on localhost so the whole
    /// streaming path (headers → bytes → SSE parse → callbacks) runs without
    /// touching openrouter.ai.
    fn spawn_sse_server(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let addr = listener.local_addr().expect("local addr");
        std::thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                // Wait for the request so the client never sees an abrupt reset.
                let mut buf = [0u8; 8192];
                let _ = std::io::Read::read(&mut socket, &mut buf);
                let _ = socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
                let _ = socket.write_all(response.as_bytes());
                let _ = socket.flush();
                // Hold the connection open until the client drains the stream.
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn streams_content_chunks_until_done() {
        let endpoint = spawn_sse_server(concat!(
            ": OPENROUTER PROCESSING\n",
            "data: {\"id\":\"1\",\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"id\":\"1\",\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: [DONE]\n\n"
        ));
        let engine =
            CloudAiEngine::new().unwrap().with_endpoint(endpoint);

        let collected = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let sink = collected.clone();
        engine
            .stream_chat_response("sys", "user", "test-model", "sk-test", move |chunk| {
                sink.lock().unwrap().push_str(&chunk);
            })
            .await
            .expect("stream must succeed");

        assert_eq!(collected.lock().unwrap().as_str(), "Hello");
    }
}
