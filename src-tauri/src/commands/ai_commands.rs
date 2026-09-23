use tauri::{AppHandle, Emitter, State};

use crate::engine::intel::compaction::{self, ConversationContext};
use crate::engine::vector_db::VectorMatch;
use crate::AppState;

const EMBEDDING_MODEL: &str = "nomic-embed-text";

const SYSTEM_PROMPT: &str = "You are AETHER, the user's personal AI assistant integrated with their NoPes knowledge base. You have access to the user's notes and can answer questions about them. Be concise, helpful, and reference specific notes when relevant. When the user asks about their knowledge, use the provided note context to give accurate answers. The notes may contain images, PDFs, videos, and mermaid diagrams — acknowledge these media types when relevant.\n\n\
# Agent actions\n\
You can take actions on the user's vault by emitting a fenced JSON block in your reply. The block uses the language tag `action` and contains a single JSON object with an `action` discriminator. Examples:\n\n\
```action\n{\"action\":\"create_note\",\"title\":\"My new note\",\"content\":\"# Hello\\n\\nbody\"}\n```\n\n\
```action\n{\"action\":\"append_daily\",\"content\":\"remember to call mom\"}\n```\n\n\
```action\n{\"action\":\"add_memory_fact\",\"fact\":\"User prefers dark mode\",\"category\":\"preferences\"}\n```\n\n\
```action\n{\"action\":\"save_aether_note\",\"title\":\"Summary of the chat\",\"content\":\"...\"}\n```\n\n\
```action\n{\"action\":\"open_url\",\"url\":\"https://example.com\"}\n```\n\n\
```action\n{\"action\":\"clip_url\",\"url\":\"https://example.com/article\"}\n```\n\n\
Available action discriminators (emit ONLY these):\n\
- `create_note { title, content }` — create a new note in the vault.\n\
- `append_note { path, content }` — append to an existing note by its vault-relative path.\n\
- `append_daily { content }` — append a timestamped bullet to today's daily note.\n\
- `open_url { url }` — open a URL in the user's default browser.\n\
- `clip_url { url }` — fetch a web page and save it as a clean Markdown note in the vault.\n\
- `add_memory_fact { fact, category }` — persist a fact the user wants you to remember forever. Category is one of: general, preferences, projects, people, work, personal.\n\
- `save_aether_note { title, content }` — save the current answer to the AETHER Notes library.\n\
- `create_task { title, project_id?, description?, priority?, due_date? }` — add a task to the task board. `project_id` may be a project name (default: Inbox); priority is none|low|medium|high|urgent; due_date is YYYY-MM-DD.\n\n\
These actions only run after the user approves them in an approval dialog:\n\
- `run_command { command, cwd? }` — run a shell command in a project folder or the vault (cwd defaults to the vault; stops after 60 s; the output is shown to the user).\n\
- `delete_note { path }` — move a vault note to the trash (`.trash/`).\n\
- `move_note { from, to }` — move or rename a vault note (`to` is vault-relative, e.g. `archive/Old idea.md`).\n\
- `git_commit { project_path, message }` — commit the changes of a project repository.\n\
- `toggle_vault_task { note_path, line }` — tick or untick the Markdown checkbox on a 1-based line of a note.\n\n\
```action\n{\"action\":\"run_command\",\"command\":\"npm test\",\"cwd\":\"/Users/me/Developer/app\"}\n```\n\n\
Rules:\n\
1. You may emit MULTIPLE action blocks in one reply (e.g. `add_memory_fact` AND `append_daily` for the same new fact).\n\
2. NEVER emit a tool call for a request the user hasn't made. If the user just wants to chat, do not emit any action block.\n\
3. The `action` block is parsed by the app — do not wrap it in extra text inside the block. JSON only, on a single line, or pretty-printed, both work.\n\
4. Approval-gated actions run only after the user approves them; say what you propose and why, never claim they already happened. Prefer the least destructive option and never propose `sudo`, `rm -rf` or force pushes unless the user explicitly asked for exactly that.\n\
5. When you emit a tool call, ALSO write a one-sentence natural-language summary above it so the user knows what you did. Example: 'I'll remember that for you.' before `add_memory_fact`.\n\
6. Never invent URLs. Never invent note paths that the user did not mention. If unsure, ask before acting.\n\
7. When a summary of the earlier conversation is provided, treat it as what was said before and stay consistent with it.";

/// The system prompt plus the memory block: remembered facts and recent
/// conversation topics (without the current conversation, whose summary
/// travels in the user prompt).
fn build_system_prompt(state: &AppState, conversation_id: Option<&str>) -> String {
    let facts = state.memory.load_facts().unwrap_or_default();
    let recent = state.memory.load_recent(6).unwrap_or_default();
    let memory = compaction::build_memory_section(&facts, &recent, conversation_id);
    if memory.is_empty() {
        SYSTEM_PROMPT.to_string()
    } else {
        format!("{SYSTEM_PROMPT}\n\n{memory}")
    }
}

/// Extract media references from markdown content and append a description
/// so the AI knows what media is present in each note.
fn enrich_with_media(content: &str) -> String {
    let mut media_refs = Vec::new();
    let media_pattern =
        regex::Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)").expect("media regex is a valid pattern");

    for line in content.lines() {
        // Images: ![alt](path)
        for cap in media_pattern.captures_iter(line) {
            let alt = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let path = cap.get(2).map(|m| m.as_str()).unwrap_or("");
            if path.is_empty() {
                continue;
            }
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

    format!(
        "{content}\n\n[Media in this note:]\n{}",
        media_refs.join("\n")
    )
}

#[tauri::command]
pub async fn cmd_index_vault(state: State<'_, AppState>) -> Result<IndexingResult, String> {
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

        let embedding = match state.ai.generate_embedding(&content, EMBEDDING_MODEL).await {
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
            let name =
                m.id.rsplit('/')
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

    let user_prompt = compaction::build_chat_user_prompt(
        "Context from the user's knowledge base:",
        &context_str,
        None,
        &compaction::prompt_budget(None, false),
        &prompt,
    );
    let system_prompt = build_system_prompt(&state, None);

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

/// Ask the agent with explicitly selected notes as context. `conversation`
/// (optional) carries the chat window — its compaction summary and the
/// messages after it — so the model can follow up on earlier turns.
#[tauri::command]
pub async fn cmd_agent_query_with_notes(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
    note_paths: Vec<String>,
    model: String,
    provider: Option<String>,
    conversation: Option<ConversationContext>,
) -> Result<(), String> {
    let mut context_parts = Vec::new();
    let mut total_chars = 0usize;
    let has_conversation = conversation.as_ref().is_some_and(|c| !c.is_empty());
    let budget = compaction::prompt_budget(provider.as_deref(), has_conversation);
    let max_context_chars = budget.notes_chars;

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
                if total_chars >= max_context_chars {
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

    let user_prompt = compaction::build_chat_user_prompt(
        "The user has selected these notes as context:",
        &context_str,
        conversation.as_ref(),
        &budget,
        &prompt,
    );
    let system_prompt =
        build_system_prompt(&state, conversation.as_ref().and_then(|c| c.id.as_deref()));

    if provider.as_deref() == Some("openrouter") {
        let api_key = state
            .ai_config
            .openrouter_key()
            .ok_or("OpenRouter API key is missing. Set it in Settings → AI Providers.")?;
        return state
            .cloud_ai
            .stream_chat_response(
                &system_prompt,
                &user_prompt,
                &model,
                &api_key,
                move |chunk| {
                    let _ = app_handle.emit("llm-stream-chunk", chunk);
                },
            )
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
