/** Note history commands (`src-tauri/src/commands/history_commands.rs`).
 *  Paths are absolute vault paths (as in `VaultNote.path`) or vault-relative. */
import type { FileDiff, HistoryActivity, HistoryRestore, HistoryStatus, NoteVersion } from "../../types";
import { call, listenSafe, type UnlistenFn } from "./core";

/** Tauri event emitted after every history commit. */
export const HISTORY_COMMIT_EVENT = "history-commit";

/** Enabled flag, repository, commit count, last snapshot, watcher state. */
export const historyStatus = () => call<HistoryStatus>("cmd_history_status");

/** Versions of one note, newest first (default 50, max 500). */
export const historyList = (path: string, limit?: number) =>
  call<NoteVersion[]>("cmd_history_list", { path, limit });

/** Content of a note in one version (full or abbreviated commit id). */
export const historyRead = (path: string, commitId: string) =>
  call<string>("cmd_history_read", { path, commitId });

/**
 * Old/new content between two versions. `to: null` compares against the file
 * on disk; `from: null` means "the version before `to`".
 */
export const historyDiff = (path: string, from: string | null, to: string | null) =>
  call<FileDiff>("cmd_history_diff", { path, from, to });

/** Restore a note to a version (written like an editor save, then committed). */
export const historyRestore = (path: string, commitId: string) =>
  call<HistoryRestore>("cmd_history_restore", { path, commitId });

/** Vault-wide activity feed, newest first (default 50, max 500). */
export const historyRecent = (limit?: number) => call<HistoryActivity[]>("cmd_history_recent", { limit });

/** Switch automatic versioning on or off; resolves to the new status. */
export const historySetEnabled = (enabled: boolean) =>
  call<HistoryStatus>("cmd_history_set_enabled", { enabled });

/** Snapshot one note (or every pending change); `null` when nothing changed. */
export const historyCommitNow = (path?: string | null) =>
  call<HistoryActivity | null>("cmd_history_commit_now", { path: path ?? null });

/** Subscribe to history commits made in the background or by other windows. */
export const onHistoryCommit = (handler: (activity: HistoryActivity) => void): Promise<UnlistenFn> =>
  listenSafe<HistoryActivity>(HISTORY_COMMIT_EVENT, handler);
