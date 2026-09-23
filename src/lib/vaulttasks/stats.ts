/**
 * Task counters — the TypeScript twin of `compute_stats` in
 * `engine/vault_tasks.rs`, so optimistic edits update the header chips and
 * status bar immediately.
 */
import type { VaultTaskItem, VaultTaskNoteStats, VaultTaskStats } from "../../types/vaulttasks";
import { addDaysIso } from "./dates";

/** Counters for `tasks` relative to `today` (`YYYY-MM-DD`). */
export function computeStats(tasks: VaultTaskItem[], today: string): VaultTaskStats {
  const weekEnd = addDaysIso(today, 6);
  const stats: VaultTaskStats = {
    total: tasks.length,
    open: 0,
    in_progress: 0,
    done: 0,
    cancelled: 0,
    overdue: 0,
    due_today: 0,
    due_this_week: 0,
    by_note: [],
  };
  const byNote = new Map<string, VaultTaskNoteStats>();
  for (const task of tasks) {
    let note = byNote.get(task.note_path);
    if (!note) {
      note = { note_path: task.note_path, note_name: task.note_name, total: 0, open: 0, done: 0, overdue: 0 };
      byNote.set(task.note_path, note);
    }
    note.total += 1;
    if (task.status === "done") {
      stats.done += 1;
      note.done += 1;
    } else if (task.status === "cancelled") {
      stats.cancelled += 1;
    } else {
      if (task.status === "in_progress") stats.in_progress += 1;
      stats.open += 1;
      note.open += 1;
      if (task.due) {
        // ISO dates compare correctly as strings.
        if (task.due < today) {
          stats.overdue += 1;
          note.overdue += 1;
        } else if (task.due === today) {
          stats.due_today += 1;
        }
        if (task.due >= today && task.due <= weekEnd) stats.due_this_week += 1;
      }
    }
  }
  stats.by_note = [...byNote.values()].sort(
    (a, b) =>
      b.open - a.open ||
      compareStrings(a.note_name.toLowerCase(), b.note_name.toLowerCase()) ||
      compareStrings(a.note_path, b.note_path)
  );
  return stats;
}

/** Ordinal string order (matches Rust's `str::cmp` for BMP text). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
