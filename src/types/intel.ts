/** Types of the `intel` feature — mirror `src-tauri/src/engine/intel*.rs`
 *  and `src-tauri/src/commands/intel_commands.rs`. */

import type { ChatMessageRecord } from "./memory";
import type { TaskItem, TaskProject } from "./tasks";

/** User-tunable settings (`<data>/intel/settings.json`). */
export interface IntelSettings {
  /** Compact the chat automatically once it exceeds the threshold. */
  auto_compact: boolean;
  /** Estimated tokens after which the conversation is compacted. */
  compact_threshold_tokens: number;
  /** Most recent messages kept verbatim when compacting. */
  keep_recent_messages: number;
  /** Compute related-note suggestions while writing. */
  related_suggestions: boolean;
  /** Let the current model re-rank tag suggestions. */
  llm_tag_suggestions: boolean;
  /** Timeout of agent `run_command` actions in seconds. */
  command_timeout_secs: number;
}

/** Where a compaction summary came from. */
export type SummarySource = "model" | "extractive";

/** Outcome of `cmd_intel_compact`. */
export interface CompactionResult {
  summary: string;
  kept_messages: ChatMessageRecord[];
  dropped_count: number;
  tokens_before: number;
  tokens_after: number;
  source: SummarySource;
  /** Why the model summary was rejected (extractive fallback). */
  model_error: string | null;
}

/** The chat window sent with a question (`cmd_agent_query_with_notes`). */
export interface ConversationContext {
  id: string | null;
  summary: string | null;
  history: ChatMessageRecord[];
}

/** Why a note was suggested. */
export type SuggestionKind = "semantic" | "keywords" | "tags";

/** One related-note suggestion. */
export interface RelatedSuggestion {
  path: string;
  name: string;
  /** 0–1, higher is more related. */
  score: number;
  /** Chip label: "semantic 0.82", "shares #rust", "keywords: a, b". */
  reason: string;
  kind: SuggestionKind;
  /** The note already links to this one. */
  linked: boolean;
}

/** Result of `cmd_intel_add_tag`. */
export interface AddTagResult {
  path: string;
  tag: string;
  /** False when the note already had the tag. */
  changed: boolean;
}

/** Output of an agent shell command. */
export interface CommandOutput {
  command: string;
  cwd: string;
  /** `null` when the command was killed (timeout or signal). */
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
  /** At least one stream exceeded 64 KB and was cut. */
  truncated: boolean;
}

/** A note moved to `<vault>/.trash/`. */
export interface TrashedNote {
  original_path: string;
  trash_path: string;
}

/** A moved/renamed note. */
export interface MovedNote {
  from: string;
  to: string;
}

/** Result of an agent commit. */
export interface GitCommitOutcome {
  commit_id: string;
  branch: string;
  files: string[];
  /** Nothing was staged, so every change was staged first. */
  staged_all: boolean;
}

/** Result of `cmd_intel_create_task`. */
export interface CreatedTask {
  task: TaskItem;
  project: TaskProject;
  /** The "Inbox" project had to be created. */
  created_project: boolean;
}

/** A toggled Markdown checkbox. */
export interface ToggledTask {
  path: string;
  /** 1-based line number. */
  line: number;
  checked: boolean;
  text: string;
}

/** What an action will touch, resolved before approval. */
export interface ActionPreview {
  target: string | null;
  details: string[];
  warnings: string[];
  /** Why the action will fail if approved as-is. */
  error: string | null;
}

/** Approval level of an agent action. */
export type ActionRisk = "safe" | "confirm" | "dangerous";

/** Outcome recorded in the audit log. */
export type AuditStatus = "ok" | "error" | "denied";

/** One line of `<data>/intel/audit.jsonl`. */
export interface AuditEntry {
  id: string;
  /** RFC 3339 local time. */
  timestamp: string;
  /** Action discriminator (`run_command`, `create_note`, …). */
  action: string;
  risk: ActionRisk;
  summary: string;
  status: AuditStatus;
  detail: string | null;
  duration_ms: number | null;
}
