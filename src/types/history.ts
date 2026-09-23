/** Note history types — mirror `src-tauri/src/engine/note_history.rs`. */
import type { GitChangeKind } from "./git";

/** State of automatic note versioning (status bar, settings). */
export interface HistoryStatus {
  /** Automatic versioning is switched on. */
  enabled: boolean;
  /** The configured vault, `null` when none is connected. */
  vault_path: string | null;
  /** Work tree root of the history repository (canonical vault root). */
  repo_path: string | null;
  /** Branch the history commits to. */
  branch: string | null;
  /** Commits on that branch (capped at 100 000). */
  commit_count: number;
  /** Seconds since the Unix epoch of the newest snapshot. */
  last_commit_at: number | null;
  /** The file watcher is active on the current vault. */
  watching: boolean;
  /** Most recent background failure, cleared by the next good snapshot. */
  last_error: string | null;
}

/** One version of a note: a commit that changed it. */
export interface NoteVersion {
  /** Full commit id (40 hex characters). */
  id: string;
  /** Abbreviated id (7 characters). */
  short_id: string;
  /** Seconds since the Unix epoch. */
  time: number;
  /** First line of the commit message, e.g. `note: Inbox/Idea.md`. */
  message: string;
  author: string;
  /** Created, modified or deleted in this version. */
  change: GitChangeKind;
  /** Lines added compared with the previous version. */
  summary_added: number;
  /** Lines removed compared with the previous version. */
  summary_removed: number;
}

/** A file touched by a history commit. */
export interface HistoryFileChange {
  /** Vault-relative path with forward slashes. */
  rel_path: string;
  /** Absolute path, comparable with `VaultNote.path`. */
  path: string;
  change: GitChangeKind;
}

/** One entry of the vault-wide activity feed (also the `history-commit` event payload). */
export interface HistoryActivity {
  commit_id: string;
  short_id: string;
  /** Seconds since the Unix epoch. */
  time: number;
  message: string;
  /** Changed files (at most 20, see `file_count`). */
  files: HistoryFileChange[];
  /** Total number of changed files. */
  file_count: number;
}

/** Result of restoring a note to an older version. */
export interface HistoryRestore {
  /** The content now on disk. */
  content: string;
  /** The `restore:` commit; `null` when nothing changed or versioning is off. */
  commit_id: string | null;
}
