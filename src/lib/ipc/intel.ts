/** `intel` commands (`src-tauri/src/commands/intel_commands.rs`) plus the
 *  conversation-aware variant of `cmd_agent_query_with_notes`. */
import type {
  ActionPreview,
  AddTagResult,
  AgentAction,
  AuditEntry,
  AuditStatus,
  ChatMessageRecord,
  CommandOutput,
  CompactionResult,
  Conversation,
  ConversationContext,
  CreatedTask,
  GitCommitOutcome,
  IntelSettings,
  MovedNote,
  RelatedSuggestion,
  ToggledTask,
  TrashedNote,
} from "../../types";
import { call } from "./core";

// ── Settings ───────────────────────────────────────────────────────────

/** Current intelligence-layer settings. */
export const getIntelSettings = () => call<IntelSettings>("cmd_intel_get_settings");
/** Store settings (numbers are clamped); resolves to what was stored. */
export const setIntelSettings = (settings: IntelSettings) =>
  call<IntelSettings>("cmd_intel_set_settings", { settings });

// ── Chat ───────────────────────────────────────────────────────────────

/**
 * Ask the agent with selected notes as context *and* the chat window
 * (compaction summary + messages after it), so follow-up questions work.
 * Streams over `llm-stream-chunk` like `agentQueryWithNotes`.
 */
export const agentQueryWithConversation = (
  prompt: string,
  notePaths: string[],
  model: string,
  provider: "ollama" | "openrouter",
  conversation: ConversationContext
) =>
  call<void>("cmd_agent_query_with_notes", { prompt, notePaths, model, provider, conversation });

/** Summarise all but the last `keepRecent` messages with the current model
 *  (extractive fallback when the model fails). */
export const intelCompact = (input: {
  messages: ChatMessageRecord[];
  model: string;
  provider: "ollama" | "openrouter";
  previousSummary?: string | null;
  keepRecent?: number | null;
}) =>
  call<CompactionResult>("cmd_intel_compact", {
    messages: input.messages,
    model: input.model,
    provider: input.provider,
    previousSummary: input.previousSummary ?? null,
    keepRecent: input.keepRecent ?? null,
  });

/** Create (no `id`) or replace a chat session in the memory store, with an
 *  optional compaction summary in its `summary` field. */
export const saveIntelConversation = (input: {
  id: string | null;
  messages: ChatMessageRecord[];
  contextNotes: string[];
  summary?: string | null;
}) =>
  call<Conversation>("cmd_intel_save_conversation", {
    id: input.id,
    messages: input.messages,
    contextNotes: input.contextNotes,
    summary: input.summary ?? null,
  });

// ── Suggestions ────────────────────────────────────────────────────────

/** Notes related to `text` (semantic, or keyword fallback). */
export const suggestRelated = (text: string, excludePath: string | null, limit = 8) =>
  call<RelatedSuggestion[]>("cmd_intel_suggest_related", { text, excludePath, limit });
/** Existing vault tags that fit `text`; `model`/`provider` enable the
 *  optional LLM re-ranking (when switched on in settings). */
export const suggestTags = (
  text: string,
  limit = 6,
  model: string | null = null,
  provider: "ollama" | "openrouter" | null = null
) => call<string[]>("cmd_intel_suggest_tags", { text, limit, model, provider });
/** Add a tag to a note (frontmatter-aware). */
export const addNoteTag = (path: string, tag: string) =>
  call<AddTagResult>("cmd_intel_add_tag", { path, tag });

// ── Approval-gated actions ─────────────────────────────────────────────

/** `run_command`: shell command in a project root or the vault. */
export const intelRunCommand = (command: string, cwd: string | null) =>
  call<CommandOutput>("cmd_intel_run_command", { command, cwd });
/** `delete_note`: move a note to `<vault>/.trash/`. */
export const intelDeleteNote = (path: string) => call<TrashedNote>("cmd_intel_delete_note", { path });
/** `move_note`: move or rename a note. */
export const intelMoveNote = (from: string, to: string) =>
  call<MovedNote>("cmd_intel_move_note", { from, to });
/** `git_commit`: commit staged changes (or all changes). */
export const intelGitCommit = (projectPath: string, message: string) =>
  call<GitCommitOutcome>("cmd_intel_git_commit", { projectPath, message });
/** `create_task`: add a task to the board (defaults to "Inbox"). */
export const intelCreateTask = (input: {
  projectId?: string | null;
  title: string;
  description?: string | null;
  priority?: string | null;
  dueDate?: string | null;
}) =>
  call<CreatedTask>("cmd_intel_create_task", {
    projectId: input.projectId ?? null,
    title: input.title,
    description: input.description ?? null,
    priority: input.priority ?? null,
    dueDate: input.dueDate ?? null,
  });
/** `toggle_vault_task`: flip a checkbox on a 1-based line. */
export const intelToggleVaultTask = (notePath: string, line: number) =>
  call<ToggledTask>("cmd_intel_toggle_vault_task", { notePath, line });
/** Resolve what an action would touch (for the approval dialog). */
export const previewAgentAction = (action: AgentAction) =>
  call<ActionPreview>("cmd_intel_preview_action", { action });

// ── Audit log ──────────────────────────────────────────────────────────

/** Newest audit entries first. */
export const listAgentAudit = (limit = 50) => call<AuditEntry[]>("cmd_intel_audit_list", { limit });
/** Record an action executed through another command, or a denial. */
export const recordAgentAudit = (action: AgentAction, status: AuditStatus, detail: string | null) =>
  call<AuditEntry>("cmd_intel_audit_record", { action, status, detail });
/** Delete the audit log. */
export const clearAgentAudit = () => call<void>("cmd_intel_audit_clear");
