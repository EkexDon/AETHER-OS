//! Router commands for agent-action variants that need more than the
//! synchronous `execute_action` path. Each variant here corresponds to a
//! specific `AgentAction` discriminator and forwards to the right engine.

use tauri::State;

use crate::engine::error::AetherError;
use crate::engine::web_clipper::ClippedPage;
use crate::engine::aether_notes::AetherNote;
use crate::engine::memory_store::MemoryFact;
use crate::AppState;

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentActionResult {
    /// `OpenUrl` succeeded — the URL is in the system browser.
    Opened { url: String },
    /// `ClipUrl` returned the extracted page; the frontend should now do
    /// HTML→Markdown and call `cmd_create_note` to write the note.
    ClippedPage { path: ClippedPage },
    /// `AddMemoryFact` succeeded — returns the updated fact list.
    FactSaved { fact: MemoryFact },
    /// `SaveAetherNote` succeeded — returns the new AETHER Note.
    AetherNoteSaved { note: AetherNote },
}

/// Open a URL in the system browser. Used by `AgentAction::OpenUrl`.
#[tauri::command]
pub async fn cmd_agent_open_url(
    state: State<'_, AppState>,
    url: String,
) -> Result<AgentActionResult, String> {
    state
        .browser
        .open_url(&url)
        .map_err(|e: AetherError| e.to_string())?;
    Ok(AgentActionResult::Opened { url })
}

/// Fetch a web page and return its readable content. The frontend then
/// runs HTML→Markdown and writes the note. Used by `AgentAction::ClipUrl`.
#[tauri::command]
pub async fn cmd_agent_clip_url(
    state: State<'_, AppState>,
    url: String,
) -> Result<AgentActionResult, String> {
    let page = state
        .clipper
        .clip(&url)
        .await
        .map_err(|e| e.to_string())?;
    Ok(AgentActionResult::ClippedPage { path: page })
}

/// Save a fact to the agent's memory store. Used by
/// `AgentAction::AddMemoryFact`.
#[tauri::command]
pub async fn cmd_agent_add_memory_fact(
    state: State<'_, AppState>,
    fact: String,
    category: String,
) -> Result<AgentActionResult, String> {
    let facts = state
        .memory
        .save_fact(&fact, &category)
        .map_err(|e| e.to_string())?;
    // Return the just-saved fact (last in the list).
    let saved = facts
        .last()
        .cloned()
        .ok_or_else(|| "memory store returned no fact".to_string())?;
    Ok(AgentActionResult::FactSaved { fact: saved })
}

/// Save the current AI answer to the AETHER Notes library. Used by
/// `AgentAction::SaveAetherNote`. The frontend is responsible for
/// composing the title + content; we just persist.
#[tauri::command]
pub async fn cmd_agent_save_aether_note(
    state: State<'_, AppState>,
    title: String,
    content: String,
) -> Result<AgentActionResult, String> {
    let note = state
        .aether_notes
        .create(&title, &content, "", Vec::new())
        .map_err(|e| e.to_string())?;
    Ok(AgentActionResult::AetherNoteSaved { note })
}
