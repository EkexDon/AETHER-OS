use tauri::{AppHandle, Emitter, State};

use crate::engine::vector_db::VectorMatch;
use crate::AppState;

const EMBEDDING_MODEL: &str = "nomic-embed-text";

const SYSTEM_PROMPT: &str = "You are AETHER, the user's personal AI assistant integrated with their NoPes knowledge base. You have access to the user's notes and can answer questions about them. Be concise, helpful, and reference specific notes when relevant. When the user asks about their knowledge, use the provided note context to give accurate answers. The notes may contain images, PDFs, videos, and mermaid diagrams — acknowledge these media types when relevant.";

/// Extract media references from markdown content and append a description
/// so the AI knows what media is present in each note.
fn enrich_with_media(content: &str) -> String {
    let mut media_refs = Vec::new();
    let media_pattern = regex::Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)")
        .expect("media regex is a valid pattern");

    for line in content.lines() {
        // Images: ![alt](path)
        for cap in media_pattern.captures_iter(line) {
            let alt = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let path = cap.get(2).map(|m| m.as_str()).unwrap_or("");
            if path.is_empty() { continue; }
            let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
            let kind = match ext.as_str() {
                "pdf" => "PDF document",
                "mp4" | "webm" | "mov" => "video",
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" => "image",
                _ => "embedded file",
            };
            let label = if alt.is_empty() { path } else { alt };
            media_refs.push(format!("  - [{kind}] {label} ({path})"));
        }
    }

    if media_refs.is_empty() {
        return content.to_string();
    }

    format!("{content}\n\n[Media in this note:]\n{}", media_refs.join("\n"))
}

#[tauri::command]
pub async fn cmd_index_vault(
    state: State<'_, AppState>,
) -> Result<IndexingResult, String> {
    let vault_path = state
        .vault
        .detect_vault_path()
        .ok_or_else(|| "No vault path configured.".to_owned())?;

    let notes = state
        .vault
        .scan_vault(&vault_path)
        .map_err(|e| e.to_string())?;

    let mut indexed = 0u32;
    let mut skipped = 0u32;

    for note in &notes {
        let content = match state.vault.read_note(&note.path) {
            Ok(c) => c,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        if content.trim().len() < 10 {
            skipped += 1;
            continue;
        }

        let embedding = match state
            .ai
            .generate_embedding(&content, EMBEDDING_MODEL)
            .await
        {
            Ok(vec) => vec,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        if let Err(e) = state
            .vectors
            .upsert_vector(&note.path, embedding, &content)
            .await
        {
            eprintln!("[AETHER] Failed to index {}: {e}", note.path);
            skipped += 1;
            continue;
        }

        indexed += 1;
    }

    Ok(IndexingResult {
        total: notes.len() as u32,
        indexed,
        skipped,
    })
}

#[derive(serde::Serialize)]
pub struct IndexingResult {
    pub total: u32,
    pub indexed: u32,
    pub skipped: u32,
}

#[tauri::command]
pub async fn cmd_semantic_search(
    state: State<'_, AppState>,
    query: String,
    limit: usize,
) -> Result<Vec<VectorMatch>, String> {
    let embedding = state
        .ai
        .generate_embedding(&query, EMBEDDING_MODEL)
        .await
        .map_err(|e| e.to_string())?;
    state
        .vectors
        .search_similar(embedding, limit.min(100))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_agent_query(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
    model: String,
) -> Result<Vec<String>, String> {
    let embedding = state
        .ai
        .generate_embedding(&prompt, EMBEDDING_MODEL)
        .await
        .map_err(|e| e.to_string())?;

    let matches = state
        .vectors
        .search_similar(embedding, 5)
        .await
        .map_err(|e| e.to_string())?;

    let mut context_parts = Vec::new();
    let mut context_paths = Vec::new();

    for m in &matches {
        if let Ok(content) = state.vault.read_note(&m.id) {
            let name = m
                .id
                .rsplit('/')
                .next()
                .unwrap_or(&m.id)
                .trim_end_matches(".md");
            let enriched = enrich_with_media(&content);
            let truncated = if enriched.len() > 2000 {
                &enriched[..2000]
            } else {
                &enriched
            };
            context_parts.push(format!("--- Note: {name} ---\n{truncated}"));
            context_paths.push(m.id.clone());
        }
    }

    let context_str = if context_parts.is_empty() {
        String::from("(No relevant notes found in the vault. Answer from general knowledge.)")
    } else {
        context_parts.join("\n\n")
    };

    let user_prompt = format!(
        "Context from the user's knowledge base:\n\n{context_str}\n\n---\n\nUser question: {prompt}"
    );

    let memory_summary = state.memory.build_context_summary();
    let system_prompt = if memory_summary.is_empty() {
        SYSTEM_PROMPT.to_string()
    } else {
        format!("{SYSTEM_PROMPT}\n\n{memory_summary}")
    };

    let paths_for_return = context_paths.clone();

    state
        .ai
        .stream_chat_response(&system_prompt, &user_prompt, &model, move |chunk| {
            let _ = app_handle.emit("llm-stream-chunk", chunk);
        })
        .await
        .map_err(|e| e.to_string())?;

    Ok(paths_for_return)
}

#[tauri::command]
pub async fn cmd_agent_query_with_notes(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
    note_paths: Vec<String>,
    model: String,
    provider: Option<String>,
) -> Result<(), String> {
    let mut context_parts = Vec::new();
    let mut total_chars = 0usize;
    const MAX_CONTEXT_CHARS: usize = 6000;

    for path in &note_paths {
        match state.vault.read_note(path) {
            Ok(content) => {
                let name = path
                    .rsplit('/')
                    .next()
                    .unwrap_or(path)
                    .trim_end_matches(".md");
                let enriched = enrich_with_media(&content);
                let truncated = if enriched.len() > 1500 {
                    &enriched[..1500]
                } else {
                    &enriched
                };
                let part = format!("--- Note: {name} ---\n{truncated}");
                total_chars += part.len();
                context_parts.push(part);
                if total_chars >= MAX_CONTEXT_CHARS {
                    break;
                }
            }
            Err(e) => {
                eprintln!("[AETHER] Failed to read note {path}: {e}");
            }
        }
    }

    let context_str = if context_parts.is_empty() {
        String::from("(No notes were loaded.)")
    } else {
        context_parts.join("\n\n")
    };

    let memory_summary = state.memory.build_context_summary();

    let user_prompt = format!(
        "The user has selected these notes as context:\n\n{context_str}\n\n---\n\nUser question: {prompt}"
    );

    let system_prompt = if memory_summary.is_empty() {
        SYSTEM_PROMPT.to_string()
    } else {
        format!("{SYSTEM_PROMPT}\n\n{memory_summary}")
    };

    if provider.as_deref() == Some("openrouter") {
        let api_key = state
            .ai_config
            .openrouter_key()
            .ok_or("OpenRouter API key is missing. Set it in Settings → AI Providers.")?;
        return state
            .cloud_ai
            .stream_chat_response(&system_prompt, &user_prompt, &model, &api_key, move |chunk| {
                let _ = app_handle.emit("llm-stream-chunk", chunk);
            })
            .await
            .map_err(|e| e.to_string());
    }

    state
        .ai
        .stream_chat_response(&system_prompt, &user_prompt, &model, move |chunk| {
            let _ = app_handle.emit("llm-stream-chunk", chunk);
        })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_set_openrouter_key(
    state: State<'_, AppState>,
    key: Option<String>,
) -> Result<bool, String> {
    state
        .ai_config
        .set_openrouter_key(key.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(state.ai_config.openrouter_key().is_some())
}

#[tauri::command]
pub async fn cmd_list_cloud_models(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let api_key = state
        .ai_config
        .openrouter_key()
        .ok_or("OpenRouter API key is missing. Set it in Settings → AI Providers.")?;
    state
        .cloud_ai
        .list_models(&api_key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_list_local_models(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    state.ai.list_models().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_health(state: State<'_, AppState>) -> Result<SystemHealth, String> {
    let ollama_online = state.ai.check_ollama_status().await;
    let openrouter_configured = state.ai_config.openrouter_key().is_some();
    let vault_connected = state.vault.detect_vault_path().is_some();

    Ok(SystemHealth {
        ollama_online,
        openrouter_configured,
        vault_connected,
    })
}

#[derive(serde::Serialize)]
pub struct SystemHealth {
    pub ollama_online: bool,
    pub openrouter_configured: bool,
    pub vault_connected: bool,
}
