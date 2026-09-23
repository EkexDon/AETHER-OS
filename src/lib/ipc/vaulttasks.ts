/** Vault task commands (`src-tauri/src/commands/vaulttasks_commands.rs`). */
import type {
  VaultTaskFilter,
  VaultTaskItem,
  VaultTaskPriority,
  VaultTaskStats,
  VaultTaskStatus,
} from "../../types/vaulttasks";
import { call } from "./core";

/**
 * Where a task lives plus the raw text the UI last saw. Edits send the text
 * as a concurrency token: when the line changed on disk the backend refuses
 * with "note changed, rescan" instead of rewriting the wrong line.
 */
export type VaultTaskRef = Pick<VaultTaskItem, "note_path" | "line" | "text_raw">;

const target = (task: VaultTaskRef) => ({ notePath: task.note_path, line: task.line, expectedText: task.text_raw });

/** Tasks from every note (cache-backed incremental scan), optionally filtered. */
export const listVaultTasks = (filter?: VaultTaskFilter | null) =>
  call<VaultTaskItem[]>("cmd_vault_tasks_list", { filter: filter ?? null });

/** Check (`[x]`) or uncheck (`[ ]`) a task; returns the re-parsed task. */
export const toggleVaultTask = (task: VaultTaskRef, checked: boolean) =>
  call<VaultTaskItem>("cmd_vault_tasks_toggle", { ...target(task), checked });

/** Rewrite the checkbox character (todo / in progress / done / cancelled). */
export const setVaultTaskStatus = (task: VaultTaskRef, status: VaultTaskStatus) =>
  call<VaultTaskItem>("cmd_vault_tasks_set_status", { ...target(task), status });

/** Set (`YYYY-MM-DD`) or clear (`null`) a task's due date. */
export const setVaultTaskDue = (task: VaultTaskRef, due: string | null) =>
  call<VaultTaskItem>("cmd_vault_tasks_set_due", { ...target(task), due });

/** Set or clear (`"none"`) a task's priority. */
export const setVaultTaskPriority = (task: VaultTaskRef, priority: VaultTaskPriority) =>
  call<VaultTaskItem>("cmd_vault_tasks_set_priority", { ...target(task), priority });

/** Add `- [ ] text` under the note's `Tasks` heading (or at its end). */
export const appendVaultTask = (notePath: string, text: string) =>
  call<VaultTaskItem>("cmd_vault_tasks_append", { notePath, text });

/** Open / done / overdue / due-today counters. */
export const getVaultTaskStats = () => call<VaultTaskStats>("cmd_vault_tasks_stats");

/** Drop the parse cache, re-read every note and return all tasks. */
export const rescanVaultTasks = () => call<VaultTaskItem[]>("cmd_vault_tasks_rescan");
