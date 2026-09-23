//! Tauri commands of the `intel` feature: conversation compaction,
//! related-note / tag suggestions and the approval-gated agent actions
//! (`run_command`, `delete_note`, `move_note`, `git_commit`, `create_task`,
//! `toggle_vault_task`) with their audit log.
//!
//! Every agent action executed here is recorded in the audit log by Rust;
//! actions routed through other commands are recorded by the frontend via
//! `cmd_intel_audit_record` right after they ran.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::commands::ide_commands::workspace;
use crate::engine::agent_actions::{action_kind, AgentAction};
use crate::engine::error::AetherError;
use crate::engine::git_repo::GitRepo;
use crate::engine::intel::approvals::{
    self, AuditEntry, AuditStatus, GitCommitOutcome, MovedNote, ProjectChoice, ToggledTask,
    TrashedNote,
};
use crate::engine::intel::compaction::{self, CompactionResult};
use crate::engine::intel::shell_exec::{self, CommandOutput};
use crate::engine::intel::suggestions::{self, Suggestion, SuggestionKind};
use crate::engine::intel::IntelSettings;
use crate::engine::memory_store::{ChatMessageRecord, Conversation};
use crate::engine::task_board::{TaskItem, TaskProject};
use crate::engine::vault_reader::VaultNote;
use crate::AppState;

/// Upper bound for one summarisation / tag call.
const MODEL_TIMEOUT: Duration = Duration::from_secs(120);
/// Semantic matches below this cosine score are not "related".
const MIN_SEMANTIC_SCORE: f32 = 0.4;
const MISSING_KEY: &str = "OpenRouter API key is missing. Set it in Settings → AI Providers.";

// ── Helpers ───────────────────────────────────────────────────────────

fn vault_root(state: &AppState) -> Result<PathBuf, AetherError> {
    let path = state
        .vault
        .detect_vault_path()
        .ok_or_else(|| AetherError::Vault("No vault path configured.".to_owned()))?;
    std::fs::canonicalize(&path)
        .map_err(|e| AetherError::Vault(format!("vault path is not accessible: {e}")))
}

fn vault_notes(state: &AppState) -> Result<Vec<VaultNote>, AetherError> {
    let path = state
        .vault
        .detect_vault_path()
        .ok_or_else(|| AetherError::Vault("No vault path configured.".to_owned()))?;
    state.vault.scan_vault(&path)
}

/// Collect a full completion from the local or cloud model.
async fn complete(
    state: &AppState,
    system: &str,
    user: &str,
    model: &str,
    provider: Option<&str>,
) -> Result<String, AetherError> {
    let mut out = String::new();
    let request = async {
        if provider == Some("openrouter") {
            let key = state
                .ai_config
                .openrouter_key()
                .ok_or_else(|| AetherError::AiEngine(MISSING_KEY.to_owned()))?;
            state
                .cloud_ai
                .stream_chat_response(system, user, model, &key, |chunk| out.push_str(&chunk))
                .await
        } else {
            state
                .ai
                .stream_chat_response(system, user, model, |chunk| out.push_str(&chunk))
                .await
        }
    };
    tokio::time::timeout(MODEL_TIMEOUT, request)
        .await
        .map_err(|_| {
            AetherError::AiEngine(format!(
                "the model did not answer within {} s",
                MODEL_TIMEOUT.as_secs()
            ))
        })??;
    Ok(out)
}

/// Record an action outcome; audit failures are logged, never propagated,
/// so a full disk cannot hide the result of an action that already ran.
fn audit<T>(
    state: &AppState,
    action: &AgentAction,
    result: &Result<T, AetherError>,
    started: Instant,
    ok_detail: impl FnOnce(&T) -> (AuditStatus, String),
) {
    let (status, detail) = match result {
        Ok(value) => ok_detail(value),
        Err(error) => (AuditStatus::Error, error.to_string()),
    };
    if let Err(error) =
        state
            .intel
            .audit()
            .record(action, status, Some(&detail), Some(started.elapsed()))
    {
        eprintln!("[AETHER] failed to write the agent audit log: {error}");
    }
}

fn to_string_err<T>(result: Result<T, AetherError>) -> Result<T, String> {
    result.map_err(|e| e.to_string())
}

// ── Settings ──────────────────────────────────────────────────────────

/// Current intelligence-layer settings.
#[tauri::command]
pub async fn cmd_intel_get_settings(state: State<'_, AppState>) -> Result<IntelSettings, String> {
    Ok(state.intel.settings())
}

/// Store settings (numeric fields are clamped); returns what was stored.
#[tauri::command]
pub async fn cmd_intel_set_settings(
    state: State<'_, AppState>,
    settings: IntelSettings,
) -> Result<IntelSettings, String> {
    to_string_err(state.intel.set_settings(settings))
}

// ── Compaction ────────────────────────────────────────────────────────

/// Summarise everything but the most recent messages with the current
/// model (Ollama or OpenRouter). Invalid or failed model output falls back
/// to an extractive summary, so this only fails on invalid input.
#[tauri::command]
pub async fn cmd_intel_compact(
    state: State<'_, AppState>,
    messages: Vec<ChatMessageRecord>,
    model: String,
    provider: Option<String>,
    previous_summary: Option<String>,
    keep_recent: Option<usize>,
) -> Result<CompactionResult, String> {
    let keep = keep_recent
        .unwrap_or(state.intel.settings().keep_recent_messages as usize)
        .clamp(1, 50);
    let plan = to_string_err(compaction::plan_compaction(
        previous_summary.as_deref(),
        &messages,
        keep,
    ))?;
    let output = if model.trim().is_empty() {
        Err(AetherError::InvalidInput("no model selected".to_owned()))
    } else {
        complete(
            &state,
            compaction::SUMMARY_SYSTEM_PROMPT,
            &plan.prompt(),
            model.trim(),
            provider.as_deref(),
        )
        .await
    };
    Ok(plan.finish(output))
}

/// Create or replace a chat conversation in the memory store. With `id`
/// the session's previous record is replaced; `summary` (a compaction
/// summary) is stored in the conversation's `summary` field.
#[tauri::command]
pub async fn cmd_intel_save_conversation(
    state: State<'_, AppState>,
    id: Option<String>,
    messages: Vec<ChatMessageRecord>,
    context_notes: Vec<String>,
    summary: Option<String>,
) -> Result<Conversation, String> {
    to_string_err(
        state
            .memory
            .upsert_conversation(id.as_deref(), messages, context_notes, summary),
    )
}

// ── Suggestions ───────────────────────────────────────────────────────

fn semantic_suggestions(
    matches: Vec<crate::engine::vector_db::VectorMatch>,
    exclude: Option<&str>,
    exclude_canonical: Option<&Path>,
    linked: &std::collections::HashSet<String>,
    limit: usize,
) -> Vec<Suggestion> {
    matches
        .into_iter()
        .filter(|m| m.score >= MIN_SEMANTIC_SCORE)
        .filter(|m| exclude != Some(m.id.as_str()))
        .filter(|m| {
            let path = Path::new(&m.id);
            if !path.is_file() {
                return false;
            }
            match (exclude_canonical, std::fs::canonicalize(path)) {
                (Some(ex), Ok(canonical)) => canonical != ex,
                _ => true,
            }
        })
        .take(limit)
        .map(|m| {
            let name = Path::new(&m.id)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| m.id.clone());
            let score = (m.score.clamp(0.0, 1.0) * 1000.0).round() / 1000.0;
            Suggestion {
                linked: linked.contains(&name.to_lowercase()),
                path: m.id,
                name,
                score,
                reason: format!("semantic {score:.2}"),
                kind: SuggestionKind::Semantic,
            }
        })
        .collect()
}

/// Notes related to `text` (the note being written): semantic neighbours
/// from the vector index when it is populated and Ollama answers, otherwise
/// the local keyword scorer over titles + the first 3 KB of every note.
#[tauri::command]
pub async fn cmd_intel_suggest_related(
    state: State<'_, AppState>,
    text: String,
    exclude_path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Suggestion>, String> {
    let limit = limit.unwrap_or(8).clamp(1, 30);
    let query = suggestions::clip_chars(&text, suggestions::QUERY_CHARS).to_owned();
    if suggestions::tokenize(&query).is_empty() {
        return Ok(Vec::new());
    }
    let linked = suggestions::extract_wikilinks(&text);
    let exclude = exclude_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let exclude_canonical = exclude.and_then(|p| std::fs::canonicalize(p).ok());

    if state.vectors.dimension().is_some() {
        if let Ok(embedding) = state
            .ai
            .generate_embedding(&query, &state.ai_config.embedding_model())
            .await
        {
            if let Ok(matches) = state.vectors.search_similar(embedding, limit + 4).await {
                let semantic = semantic_suggestions(
                    matches,
                    exclude,
                    exclude_canonical.as_deref(),
                    &linked,
                    limit,
                );
                if !semantic.is_empty() {
                    return Ok(semantic);
                }
            }
        }
    }

    let notes = to_string_err(vault_notes(&state))?;
    let mut cache = state.intel.doc_cache();
    cache.refresh(&notes, |path| state.vault.read_note(path).ok());
    Ok(suggestions::rank_by_keywords(
        &text,
        &cache.docs(),
        exclude,
        limit,
    ))
}

/// Existing vault tags that fit `text`, ranked by keyword co-occurrence.
/// With the `llm_tag_suggestions` setting and a `model`, the model may
/// re-order the candidates (it can never invent new tags).
#[tauri::command]
pub async fn cmd_intel_suggest_tags(
    state: State<'_, AppState>,
    text: String,
    limit: Option<usize>,
    model: Option<String>,
    provider: Option<String>,
) -> Result<Vec<String>, String> {
    let limit = limit.unwrap_or(6).clamp(1, 20);
    let vault_path = state
        .vault
        .detect_vault_path()
        .ok_or_else(|| "No vault path configured.".to_owned())?;
    let notes = to_string_err(state.vault.scan_vault(&vault_path))?;
    let index_tags: HashMap<String, Vec<String>> = state
        .vault
        .load_vault_index(&vault_path)
        .ok()
        .flatten()
        .map(|index| {
            index
                .notes
                .into_iter()
                .map(|entry| (entry.path, entry.tags))
                .collect()
        })
        .unwrap_or_default();

    let candidates = {
        let mut cache = state.intel.doc_cache();
        cache.refresh(&notes, |path| state.vault.read_note(path).ok());
        suggestions::rank_tags(&text, &cache.docs(), &index_tags, 30)
    };

    let use_llm = state.intel.settings().llm_tag_suggestions && candidates.len() > 1;
    if let (true, Some(model)) = (
        use_llm,
        model.as_deref().map(str::trim).filter(|m| !m.is_empty()),
    ) {
        let system = "You pick tags for a note. Reply with a JSON array of tag names chosen ONLY from the candidate list, most fitting first, at most 6. No explanation.";
        let excerpt = suggestions::clip_chars(&text, 1_500);
        let user = format!(
            "Candidate tags: {}\n\nNote:\n{excerpt}",
            serde_json::to_string(&candidates).unwrap_or_default()
        );
        if let Ok(reply) = complete(&state, system, &user, model, provider.as_deref()).await {
            let mut picked = suggestions::parse_llm_tags(&reply, &candidates);
            for tag in &candidates {
                if !picked.iter().any(|p| p.eq_ignore_ascii_case(tag)) {
                    picked.push(tag.clone());
                }
            }
            picked.truncate(limit);
            return Ok(picked);
        }
    }
    let mut ranked = candidates;
    ranked.truncate(limit);
    Ok(ranked)
}

/// Result of `cmd_intel_add_tag`.
#[derive(Debug, Serialize)]
pub struct AddTagResult {
    pub path: String,
    pub tag: String,
    /// False when the note already had the tag.
    pub changed: bool,
}

/// Add a tag to a note: merged into the frontmatter `tags:` key when the
/// note has frontmatter, otherwise appended as `#tag`.
#[tauri::command]
pub async fn cmd_intel_add_tag(
    state: State<'_, AppState>,
    path: String,
    tag: String,
) -> Result<AddTagResult, String> {
    to_string_err(add_tag(&state, &path, &tag))
}

fn add_tag(state: &AppState, path: &str, tag: &str) -> Result<AddTagResult, AetherError> {
    let tag = suggestions::normalize_tag(tag)?;
    let root = vault_root(state)?;
    let notes = vault_notes(state)?;
    let note = approvals::resolve_existing_note(&root, path, &notes)?;
    let note_str = note.to_string_lossy().into_owned();
    let content = std::fs::read_to_string(&note)?;
    let (updated, changed) = suggestions::add_tag_to_content(&content, &tag)?;
    if changed {
        state.vault.write_note(&note_str, &updated)?;
    }
    Ok(AddTagResult {
        path: note_str,
        tag,
        changed,
    })
}

// ── Approval-gated actions ────────────────────────────────────────────

/// Run a shell command (`sh -lc`) inside a project directory or the vault
/// with the configured timeout. Non-zero exits return normally (with the
/// output); only invalid input or a failure to start fails.
#[tauri::command]
pub async fn cmd_intel_run_command(
    state: State<'_, AppState>,
    command: String,
    cwd: Option<String>,
) -> Result<CommandOutput, String> {
    let action = AgentAction::RunCommand {
        command: command.clone(),
        cwd: cwd.clone(),
    };
    let started = Instant::now();
    let timeout = Duration::from_secs(state.intel.settings().command_timeout_secs as u64);
    let result = async {
        let ws = workspace(&state);
        let vault = vault_root(&state).ok();
        let dir = shell_exec::resolve_cwd(ws.roots(), vault.as_deref(), cwd.as_deref())?;
        shell_exec::run_shell(&command, &dir, timeout).await
    }
    .await;
    audit(&state, &action, &result, started, |out| {
        let status = if out.succeeded() {
            AuditStatus::Ok
        } else {
            AuditStatus::Error
        };
        let outcome = if out.timed_out {
            format!("timed out after {} s", timeout.as_secs())
        } else {
            match out.exit_code {
                Some(code) => format!("exit {code}"),
                None => "killed".to_owned(),
            }
        };
        (
            status,
            format!("{} (in {}) → {outcome}", out.command, out.cwd),
        )
    });
    to_string_err(result)
}

/// Move a vault note to `<vault>/.trash/` (never a hard delete).
#[tauri::command]
pub async fn cmd_intel_delete_note(
    state: State<'_, AppState>,
    path: String,
) -> Result<TrashedNote, String> {
    let action = AgentAction::DeleteNote { path: path.clone() };
    let started = Instant::now();
    let result = delete_note(&state, &path);
    audit(&state, &action, &result, started, |t| {
        (
            AuditStatus::Ok,
            format!("{} → {}", t.original_path, t.trash_path),
        )
    });
    to_string_err(result)
}

fn delete_note(state: &AppState, path: &str) -> Result<TrashedNote, AetherError> {
    let root = vault_root(state)?;
    let notes = vault_notes(state)?;
    let note = approvals::resolve_existing_note(&root, path, &notes)?;
    approvals::trash_note(&root, &note, chrono::Local::now())
}

/// Move or rename a vault note; never overwrites an existing note.
#[tauri::command]
pub async fn cmd_intel_move_note(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<MovedNote, String> {
    let action = AgentAction::MoveNote {
        from: from.clone(),
        to: to.clone(),
    };
    let started = Instant::now();
    let result = move_note(&state, &from, &to);
    audit(&state, &action, &result, started, |m| {
        (AuditStatus::Ok, format!("{} → {}", m.from, m.to))
    });
    to_string_err(result)
}

fn move_note(state: &AppState, from: &str, to: &str) -> Result<MovedNote, AetherError> {
    let root = vault_root(state)?;
    let notes = vault_notes(state)?;
    let source = approvals::resolve_existing_note(&root, from, &notes)?;
    let target = approvals::resolve_move_target(&root, &source, to)?;
    approvals::move_note(&root, &source, &target)
}

/// Open the repository at `path`, which must live inside the sandbox roots
/// (the same rule as the IDE's Source Control).
fn open_repo(state: &State<'_, AppState>, path: &str) -> Result<GitRepo, AetherError> {
    let ws = workspace(state);
    let resolved = ws.resolve_existing(path)?;
    let repo = GitRepo::open(&resolved)?;
    let workdir = repo.workdir()?.to_path_buf();
    if !ws.roots().iter().any(|root| workdir.starts_with(root)) {
        return Err(AetherError::InvalidInput(format!(
            "repository root is outside the allowed project directories: {}",
            workdir.display()
        )));
    }
    Ok(repo)
}

/// Commit in a project repository: the staged changes, or every change
/// when nothing is staged. Refuses empty commits.
#[tauri::command]
pub async fn cmd_intel_git_commit(
    state: State<'_, AppState>,
    project_path: String,
    message: String,
) -> Result<GitCommitOutcome, String> {
    let action = AgentAction::GitCommit {
        project_path: project_path.clone(),
        message: message.clone(),
    };
    let started = Instant::now();
    let result = open_repo(&state, &project_path)
        .and_then(|repo| approvals::git_commit_all(&repo, &message));
    audit(&state, &action, &result, started, |c| {
        (
            AuditStatus::Ok,
            format!(
                "{} on {} ({} file(s))",
                &c.commit_id[..c.commit_id.len().min(7)],
                c.branch,
                c.files.len()
            ),
        )
    });
    to_string_err(result)
}

/// Result of `cmd_intel_create_task`.
#[derive(Debug, Serialize)]
pub struct CreatedTask {
    pub task: TaskItem,
    pub project: TaskProject,
    /// True when the "Inbox" project had to be created.
    pub created_project: bool,
}

/// Create a task on the board. `project_id` may be an id or a project
/// name; without one the task goes to "Inbox" (created on demand).
#[tauri::command]
pub async fn cmd_intel_create_task(
    state: State<'_, AppState>,
    project_id: Option<String>,
    title: String,
    description: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
) -> Result<CreatedTask, String> {
    let action = AgentAction::CreateTask {
        project_id,
        title,
        description,
        priority,
        due_date,
    };
    let started = Instant::now();
    let result = create_task(&state, &action);
    audit(&state, &action, &result, started, |c| {
        (
            AuditStatus::Ok,
            format!("\"{}\" in {}", c.task.title, c.project.name),
        )
    });
    to_string_err(result)
}

fn create_task(state: &AppState, action: &AgentAction) -> Result<CreatedTask, AetherError> {
    let AgentAction::CreateTask {
        project_id,
        title,
        description,
        priority,
        due_date,
    } = action
    else {
        return Err(AetherError::InvalidInput(
            "expected a create_task action".to_owned(),
        ));
    };
    let priority = approvals::normalize_priority(priority.as_deref())?;
    let due = approvals::normalize_due_date(due_date.as_deref())?;
    let board = &state.task_board;
    let projects = board.list_projects()?;
    let (project, created_project) =
        match approvals::choose_task_project(&projects, project_id.as_deref())? {
            ProjectChoice::Existing(id) => (board.get_project(&id)?, false),
            ProjectChoice::CreateInbox => (
                board.create_project(
                    approvals::INBOX_PROJECT,
                    "Tasks captured by the AETHER agent",
                    "",
                    None,
                )?,
                true,
            ),
        };
    let task = board.create_task(
        &project.id,
        title,
        description.as_deref().unwrap_or(""),
        "todo",
        &priority,
        due,
        Vec::new(),
        None,
    )?;
    Ok(CreatedTask {
        task,
        project,
        created_project,
    })
}

/// Tick or untick the Markdown checkbox on a 1-based line of a vault note
/// (a minimal one-line rewrite; see docs/features/intel.md).
#[tauri::command]
pub async fn cmd_intel_toggle_vault_task(
    state: State<'_, AppState>,
    note_path: String,
    line: usize,
) -> Result<ToggledTask, String> {
    let action = AgentAction::ToggleVaultTask {
        note_path: note_path.clone(),
        line,
    };
    let started = Instant::now();
    let result = toggle_vault_task(&state, &note_path, line);
    audit(&state, &action, &result, started, |t| {
        (
            AuditStatus::Ok,
            format!(
                "{} \"{}\"",
                if t.checked { "checked" } else { "unchecked" },
                t.text
            ),
        )
    });
    to_string_err(result)
}

fn toggle_vault_task(
    state: &AppState,
    note_path: &str,
    line: usize,
) -> Result<ToggledTask, AetherError> {
    let root = vault_root(state)?;
    let notes = vault_notes(state)?;
    let note = approvals::resolve_existing_note(&root, note_path, &notes)?;
    let content = std::fs::read_to_string(&note)?;
    let (updated, checked, text) = approvals::toggle_task_line(&content, line)?;
    let path = note.to_string_lossy().into_owned();
    state.vault.write_note(&path, &updated)?;
    Ok(ToggledTask {
        path,
        line,
        checked,
        text,
    })
}

/// What an action will touch, resolved before approval.
#[derive(Debug, Default, Serialize)]
pub struct ActionPreview {
    /// Resolved main target (note path, working directory, repository).
    pub target: Option<String>,
    /// Extra facts for the approval dialog.
    pub details: Vec<String>,
    /// Heuristic warnings (destructive commands, …).
    pub warnings: Vec<String>,
    /// Why the action will fail if approved as-is.
    pub error: Option<String>,
}

fn preview_of(state: &State<'_, AppState>, action: &AgentAction) -> ActionPreview {
    let mut preview = ActionPreview::default();
    if let Err(error) = fill_preview(state, action, &mut preview) {
        preview.error = Some(error.to_string());
    }
    preview
}

fn fill_preview(
    state: &State<'_, AppState>,
    action: &AgentAction,
    preview: &mut ActionPreview,
) -> Result<(), AetherError> {
    match action {
        AgentAction::RunCommand { command, cwd } => {
            preview.warnings = shell_exec::command_warnings(command);
            let ws = workspace(state);
            let vault = vault_root(state).ok();
            let dir = shell_exec::resolve_cwd(ws.roots(), vault.as_deref(), cwd.as_deref())?;
            preview.target = Some(dir.to_string_lossy().into_owned());
            preview.details.push(format!(
                "Runs in a login shell (sh -lc), stops after {} s",
                state.intel.settings().command_timeout_secs
            ));
        }
        AgentAction::DeleteNote { path } => {
            let root = vault_root(state)?;
            let note = approvals::resolve_existing_note(&root, path, &vault_notes(state)?)?;
            preview.target = Some(note.to_string_lossy().into_owned());
            preview.details.push(format!(
                "Moves the note to {}/{} — restore it by moving it back",
                root.display(),
                approvals::TRASH_DIR
            ));
        }
        AgentAction::MoveNote { from, to } => {
            let root = vault_root(state)?;
            let source = approvals::resolve_existing_note(&root, from, &vault_notes(state)?)?;
            preview.target = Some(source.to_string_lossy().into_owned());
            let target = approvals::resolve_move_target(&root, &source, to)?;
            preview
                .details
                .push(format!("New location: {}", target.display()));
            preview
                .details
                .push("Wikilinks to the old name are not rewritten".to_owned());
        }
        AgentAction::GitCommit { project_path, .. } => {
            let repo = open_repo(state, project_path)?;
            preview.target = Some(repo.workdir()?.to_string_lossy().into_owned());
            let (files, staged_all, branch) = approvals::commit_candidates(&repo)?;
            preview.details.push(format!(
                "Branch {branch}: {} file(s){}",
                files.len(),
                if staged_all {
                    ", all changes are staged first"
                } else {
                    " already staged"
                }
            ));
            for file in files.iter().take(8) {
                preview.details.push(format!("• {file}"));
            }
            if files.len() > 8 {
                preview
                    .details
                    .push(format!("… and {} more", files.len() - 8));
            }
        }
        AgentAction::ToggleVaultTask { note_path, line } => {
            let root = vault_root(state)?;
            let note = approvals::resolve_existing_note(&root, note_path, &vault_notes(state)?)?;
            preview.target = Some(note.to_string_lossy().into_owned());
            let content = std::fs::read_to_string(&note)?;
            match approvals::task_line_text(&content, *line) {
                Some((checked, text)) => preview.details.push(format!(
                    "Line {line}: [{}] {text} → [{}]",
                    if checked { "x" } else { " " },
                    if checked { " " } else { "x" }
                )),
                None => {
                    return Err(AetherError::InvalidInput(format!(
                        "line {line} is not a Markdown task"
                    )))
                }
            }
        }
        AgentAction::ImportCalendarIcs { path, .. } => {
            preview.target = Some(path.clone());
        }
        _ => {}
    }
    Ok(())
}

/// Resolve what an action would touch (for the approval dialog). Never
/// fails: resolution problems are reported in `error`.
#[tauri::command]
pub async fn cmd_intel_preview_action(
    state: State<'_, AppState>,
    action: AgentAction,
) -> Result<ActionPreview, String> {
    Ok(preview_of(&state, &action))
}

// ── Audit log ─────────────────────────────────────────────────────────

/// Newest audit entries first (default 50, at most 500).
#[tauri::command]
pub async fn cmd_intel_audit_list(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<AuditEntry>, String> {
    to_string_err(state.intel.audit().list(limit.unwrap_or(50).clamp(1, 500)))
}

/// True for the kinds whose `cmd_intel_*` command audits itself.
fn audited_in_rust(action: &AgentAction) -> bool {
    matches!(
        action,
        AgentAction::RunCommand { .. }
            | AgentAction::DeleteNote { .. }
            | AgentAction::MoveNote { .. }
            | AgentAction::GitCommit { .. }
            | AgentAction::CreateTask { .. }
            | AgentAction::ToggleVaultTask { .. }
    )
}

/// Record an action the frontend executed through another command (or a
/// denial of any action). Actions executed by `cmd_intel_*` commands are
/// already audited and only accept `denied` here.
#[tauri::command]
pub async fn cmd_intel_audit_record(
    state: State<'_, AppState>,
    action: AgentAction,
    status: AuditStatus,
    detail: Option<String>,
) -> Result<AuditEntry, String> {
    if audited_in_rust(&action) && status != AuditStatus::Denied {
        return Err(format!(
            "invalid input: {} is audited by its own command",
            action_kind(&action)
        ));
    }
    to_string_err(
        state
            .intel
            .audit()
            .record(&action, status, detail.as_deref(), None),
    )
}

/// Delete the whole audit log.
#[tauri::command]
pub async fn cmd_intel_audit_clear(state: State<'_, AppState>) -> Result<(), String> {
    to_string_err(state.intel.audit().clear())
}
