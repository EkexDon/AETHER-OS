/**
 * Vault tasks — every `- [ ]` checkbox in every note, aggregated.
 * Mirrors `src-tauri/src/engine/vault_tasks.rs` (serde snake_case).
 */

/** Workflow state derived from the checkbox character. */
export type VaultTaskStatus = "todo" | "in_progress" | "done" | "cancelled";

/** Priority scale (same values as the project task board). */
export type VaultTaskPriority = "none" | "low" | "medium" | "high" | "urgent";

/** One checkbox task found in a note. Dates are ISO `YYYY-MM-DD`. */
export interface VaultTaskItem {
  /** FNV-1a 64 of note path, line and raw text (16 hex digits). */
  id: string;
  note_path: string;
  /** File name without `.md`. */
  note_name: string;
  /** 0-based line inside the note. */
  line: number;
  /** Leading whitespace before the bullet in columns (tab = 4). */
  indent: number;
  /** Nesting level among list items (0 = top level). */
  depth: number;
  /** Everything after the checkbox, exactly as written. */
  text_raw: string;
  /** `text_raw` without date / priority / block-id markers (tags and links kept). */
  text_clean: string;
  /** True for `[x]` / `[X]`. */
  checked: boolean;
  /** The character between the brackets. */
  status_char: string;
  status: VaultTaskStatus;
  due: string | null;
  scheduled: string | null;
  start: string | null;
  done_date: string | null;
  priority: VaultTaskPriority;
  /** Inline tags without `#`. */
  tags: string[];
  /** Nearest heading above the task. */
  section: string | null;
}

/** Status filter of {@link VaultTaskFilter}. */
export type VaultTaskStatusFilter = "all" | "open" | "todo" | "in_progress" | "done" | "cancelled";

/**
 * Server-side filter for `cmd_vault_tasks_list`. Every set field must match;
 * date bounds are inclusive and exclude tasks without a due date.
 */
export interface VaultTaskFilter {
  status?: VaultTaskStatusFilter | null;
  /** Due on or before (`YYYY-MM-DD`). */
  due_before?: string | null;
  /** Due on or after (`YYYY-MM-DD`). */
  due_after?: string | null;
  /** Tag without `#`; `work` also matches `work/meeting`. */
  tag?: string | null;
  note_path?: string | null;
  /** Whitespace-separated terms matched against text, note, tags and section. */
  query?: string | null;
}

/** Per-note counters of {@link VaultTaskStats}. */
export interface VaultTaskNoteStats {
  note_path: string;
  note_name: string;
  total: number;
  open: number;
  done: number;
  overdue: number;
}

/** Aggregate counters over all vault tasks. */
export interface VaultTaskStats {
  total: number;
  /** Todo + in progress. */
  open: number;
  in_progress: number;
  done: number;
  cancelled: number;
  /** Open tasks due before today. */
  overdue: number;
  /** Open tasks due today. */
  due_today: number;
  /** Open tasks due today or within the next six days. */
  due_this_week: number;
  /** Notes with tasks, most open first. */
  by_note: VaultTaskNoteStats[];
}
