/**
 * "Due today / overdue" selection for the Home "Today" block: open task
 * board items and — when the `vaulttasks` feature is installed — open
 * checkbox tasks from notes. Note tasks arrive as untyped JSON from an
 * optional command, so they are parsed defensively.
 */
import type { TaskItem, TaskPriority, TaskProject } from "../../types";
import { shiftDateKey } from "./focusStats";

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };

/** A board task that is due today or overdue. */
export interface DueBoardTask {
  task: TaskItem;
  projectName: string;
  projectColor: string | null;
  /** `YYYY-MM-DD`. */
  due: string;
}

/** An open checkbox task from a note (subset of the `vaulttasks` item). */
export interface HomeNoteTask {
  id: string;
  notePath: string;
  noteName: string;
  /** 0-based line in the note. */
  line: number;
  text: string;
  /** `YYYY-MM-DD` or `null`. */
  due: string | null;
  checked: boolean;
  priority: TaskPriority;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}/;

function dueKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DATE_KEY.exec(value.trim());
  return match ? match[0] : null;
}

/** Open board tasks due on or before `today`, soonest first, then by priority. */
export function boardTasksDue(tasks: TaskItem[], projects: TaskProject[], today: string): DueBoardTask[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return tasks
    .filter((t) => t.status !== "done")
    .map((task) => ({ task, due: dueKey(task.due_date) }))
    .filter((x): x is { task: TaskItem; due: string } => x.due !== null && x.due <= today)
    .map(({ task, due }) => {
      const project = byId.get(task.project_id);
      return { task, due, projectName: project?.name ?? "Tasks", projectColor: project?.color ?? null };
    })
    .sort(
      (a, b) =>
        a.due.localeCompare(b.due) ||
        (PRIORITY_RANK[b.task.priority] ?? 0) - (PRIORITY_RANK[a.task.priority] ?? 0) ||
        a.task.title.localeCompare(b.task.title)
    );
}

function basename(path: string): string {
  return (path.split(/[\\/]/).filter(Boolean).pop() ?? path).replace(/\.md$/i, "");
}

/**
 * Parse whatever `cmd_vault_tasks_list` returned into note tasks; entries
 * that do not look like tasks are dropped, so a changed or missing feature
 * never breaks Home.
 */
export function parseNoteTasks(raw: unknown): HomeNoteTask[] {
  if (!Array.isArray(raw)) return [];
  const out: HomeNoteTask[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const notePath = typeof r.note_path === "string" ? r.note_path : null;
    const text =
      typeof r.text_clean === "string" ? r.text_clean : typeof r.text === "string" ? r.text : typeof r.text_raw === "string" ? r.text_raw : null;
    if (!notePath || !text || !text.trim()) continue;
    const line = typeof r.line === "number" && Number.isFinite(r.line) ? r.line : 0;
    const priority = typeof r.priority === "string" && r.priority in PRIORITY_RANK ? (r.priority as TaskPriority) : "none";
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : `${notePath}:${line}`,
      notePath,
      noteName: typeof r.note_name === "string" && r.note_name ? r.note_name : basename(notePath),
      line,
      text: text.trim(),
      due: dueKey(r.due),
      checked: r.checked === true,
      priority,
    });
  }
  return out;
}

/** Open note tasks due on or before `today`, soonest first, then by priority. */
export function noteTasksDue(tasks: HomeNoteTask[], today: string): HomeNoteTask[] {
  return tasks
    .filter((t): t is HomeNoteTask & { due: string } => !t.checked && t.due !== null && t.due <= today)
    .sort(
      (a, b) =>
        a.due.localeCompare(b.due) ||
        PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
        a.text.localeCompare(b.text)
    );
}

/** Badge text and tone for a due date relative to `today`. */
export function dueLabel(due: string, today: string): { label: string; tone: "danger" | "warning" | "neutral" } {
  if (due === today) return { label: "Today", tone: "warning" };
  if (due > today) return { label: due === shiftDateKey(today, 1) ? "Tomorrow" : due, tone: "neutral" };
  if (due === shiftDateKey(today, -1)) return { label: "Yesterday", tone: "danger" };
  const [y1, m1, d1] = due.split("-").map(Number);
  const [y2, m2, d2] = today.split("-").map(Number);
  const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
  return { label: `${days}d overdue`, tone: "danger" };
}
