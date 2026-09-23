/**
 * Mock handlers for `commands/vaulttasks_commands.rs`. Tasks are parsed live
 * from the shared mock vault with the TypeScript port of the Rust parser, and
 * edits go through the same pure line-rewrite functions, so toggling a task
 * in the preview changes the note exactly like the desktop app would.
 */
import type {
  VaultTaskFilter,
  VaultTaskItem,
  VaultTaskPriority,
  VaultTaskStatus,
} from "../../types/vaulttasks";
import { todayIso } from "../vaulttasks/dates";
import { appendTaskToContent, applyDue, applyPriority, applyStatus, STALE_TASK_ERROR } from "../vaulttasks/edit";
import { matchesFilter } from "../vaulttasks/filters";
import { isValidIsoDate, parseTasks } from "../vaulttasks/parser";
import { computeStats } from "../vaulttasks/stats";
import { argBool, argNumber, argOptString, argString, isWithin, normalizePath, type MockArgs, type MockHandlerMap } from "./runtime";
import { mockVault } from "./vaultStore";

const STATUSES: VaultTaskStatus[] = ["todo", "in_progress", "done", "cancelled"];
const PRIORITIES: VaultTaskPriority[] = ["none", "low", "medium", "high", "urgent"];

/** Every task in the mock vault, notes by name, tasks by line. */
function allTasks(): VaultTaskItem[] {
  return mockVault.list().flatMap((note) => parseTasks(note.path, mockVault.read(note.path)));
}

/** Same checks and messages as `ensure_note_in_vault` in Rust. */
function requireNote(notePath: string): string {
  const root = mockVault.root;
  if (!root) throw new Error("vault error: no vault path configured — choose one in Settings");
  const path = normalizePath(notePath);
  if (!isWithin(path, root) || path === root) {
    throw new Error(`vault error: refusing to edit outside the vault: ${notePath}`);
  }
  if (!mockVault.hasFile(path)) {
    throw new Error(`vault error: note not found: ${notePath} (No such file or directory (os error 2))`);
  }
  if (path.slice(root.length + 1).split("/").some((part) => part.startsWith("."))) {
    throw new Error(`vault error: refusing to edit hidden files: ${notePath}`);
  }
  if (!/\.md$/i.test(path)) throw new Error(`vault error: only Markdown notes contain tasks: ${notePath}`);
  return path;
}

/** Read → transform → write (when changed) → re-parse the task at `line`. */
function editNote(notePath: string, transform: (content: string) => { content: string; line: number }): VaultTaskItem {
  const path = requireNote(notePath);
  const content = mockVault.read(path);
  const next = transform(content);
  if (next.content !== content) mockVault.write(path, next.content);
  const item = parseTasks(path, next.content).find((t) => t.line === next.line);
  if (!item) throw new Error(`vault error: ${STALE_TASK_ERROR} (line ${next.line + 1} no longer holds this task)`);
  return item;
}

function enumArg<T extends string>(args: MockArgs, key: string, allowed: readonly T[]): T {
  const value = argString(args, key);
  if (!allowed.includes(value as T)) {
    throw new Error(
      `invalid args \`${key}\` for command: unknown variant \`${value}\`, expected one of ${allowed
        .map((v) => `\`${v}\``)
        .join(", ")}`
    );
  }
  return value as T;
}

function lineArg(args: MockArgs): number {
  const line = argNumber(args, "line");
  if (!Number.isInteger(line) || line < 0) {
    throw new Error("invalid args `line` for command: invalid value: integer, expected usize");
  }
  return line;
}

function dueArg(args: MockArgs): string | null {
  const raw = argOptString(args, "due")?.trim() ?? "";
  if (!raw) return null;
  if (!isValidIsoDate(raw)) throw new Error(`invalid input: invalid date "${raw}" — expected YYYY-MM-DD`);
  return raw;
}

function filterArg(args: MockArgs): VaultTaskFilter {
  const value = args.filter;
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid args `filter` for command: invalid type, expected struct VaultTaskFilter");
  }
  return value as VaultTaskFilter;
}

export const vaulttasksHandlers: MockHandlerMap = {
  cmd_vault_tasks_list: (args) => {
    const filter = filterArg(args);
    return allTasks().filter((t) => matchesFilter(t, filter));
  },
  cmd_vault_tasks_toggle: (args) => {
    const line = lineArg(args);
    const status: VaultTaskStatus = argBool(args, "checked") ? "done" : "todo";
    const expected = argString(args, "expectedText");
    return editNote(argString(args, "notePath"), (content) => ({
      content: applyStatus(content, argString(args, "notePath"), line, expected, status, todayIso()),
      line,
    }));
  },
  cmd_vault_tasks_set_status: (args) => {
    const line = lineArg(args);
    const status = enumArg(args, "status", STATUSES);
    const expected = argString(args, "expectedText");
    return editNote(argString(args, "notePath"), (content) => ({
      content: applyStatus(content, argString(args, "notePath"), line, expected, status, todayIso()),
      line,
    }));
  },
  cmd_vault_tasks_set_due: (args) => {
    const line = lineArg(args);
    const due = dueArg(args);
    const expected = argString(args, "expectedText");
    return editNote(argString(args, "notePath"), (content) => ({
      content: applyDue(content, argString(args, "notePath"), line, expected, due),
      line,
    }));
  },
  cmd_vault_tasks_set_priority: (args) => {
    const line = lineArg(args);
    const priority = enumArg(args, "priority", PRIORITIES);
    const expected = argString(args, "expectedText");
    return editNote(argString(args, "notePath"), (content) => ({
      content: applyPriority(content, argString(args, "notePath"), line, expected, priority),
      line,
    }));
  },
  cmd_vault_tasks_append: (args) => {
    const text = argString(args, "text");
    return editNote(argString(args, "notePath"), (content) => appendTaskToContent(content, text));
  },
  cmd_vault_tasks_stats: () => computeStats(allTasks(), todayIso()),
  cmd_vault_tasks_rescan: () => allTasks(),
};
