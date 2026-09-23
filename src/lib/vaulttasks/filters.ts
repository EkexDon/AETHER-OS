/**
 * Filtering, sorting and grouping of vault tasks for the Note Tasks view,
 * plus {@link matchesFilter}, the TypeScript twin of
 * `VaultTaskFilter::matches` used by the mock backend.
 */
import type {
  VaultTaskFilter,
  VaultTaskItem,
  VaultTaskPriority,
  VaultTaskStatus,
} from "../../types/vaulttasks";
import { addDaysIso } from "./dates";
import { isOpenStatus } from "./parser";

/** Stable key of a task location; survives edits that change the id. */
export function taskKey(task: Pick<VaultTaskItem, "note_path" | "line">): string {
  return `${task.note_path}\u0000${task.line}`;
}

function tagMatches(tags: string[], wanted: string): boolean {
  const w = wanted.trim().replace(/^#+/, "").toLowerCase();
  if (!w) return true;
  return tags.some((t) => {
    const tag = t.toLowerCase();
    return tag === w || tag.startsWith(`${w}/`);
  });
}

function queryMatches(task: VaultTaskItem, query: string): boolean {
  const haystack = `${task.text_clean} ${task.note_name} ${task.tags.join(" ")} ${task.section ?? ""}`.toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term.toLowerCase()));
}

/** Backend filter semantics (`cmd_vault_tasks_list`). */
export function matchesFilter(task: VaultTaskItem, filter: VaultTaskFilter): boolean {
  switch (filter.status ?? "all") {
    case "open":
      if (!isOpenStatus(task.status)) return false;
      break;
    case "all":
      break;
    default:
      if (task.status !== filter.status) return false;
  }
  if (filter.due_before || filter.due_after) {
    if (!task.due) return false;
    if (filter.due_before && task.due > filter.due_before) return false;
    if (filter.due_after && task.due < filter.due_after) return false;
  }
  if (filter.tag && !tagMatches(task.tags, filter.tag)) return false;
  if (filter.note_path && task.note_path !== filter.note_path) return false;
  if (filter.query && !queryMatches(task, filter.query)) return false;
  return true;
}

/** Due-date filter of the view toolbar. */
export type DueFilter = "all" | "today" | "week" | "overdue" | "none";
/** Priority filter of the view toolbar. */
export type PriorityFilter = VaultTaskPriority | "all";

/** Everything the toolbar can filter by. */
export interface ViewFilters {
  query: string;
  due: DueFilter;
  priority: PriorityFilter;
  tag: string | null;
  /** Include done and cancelled tasks (List / By note). */
  showCompleted: boolean;
}

/** Filters with nothing selected. */
export const DEFAULT_FILTERS: ViewFilters = { query: "", due: "all", priority: "all", tag: null, showCompleted: false };

/** True when any filter narrows the list (completed visibility excluded). */
export function hasActiveFilters(f: ViewFilters): boolean {
  return f.query.trim() !== "" || f.due !== "all" || f.priority !== "all" || f.tag !== null;
}

function dueMatches(task: VaultTaskItem, due: DueFilter, today: string): boolean {
  switch (due) {
    case "today":
      return task.due === today;
    case "week":
      return !!task.due && task.due >= today && task.due <= addDaysIso(today, 6);
    case "overdue":
      return !!task.due && task.due < today && isOpenStatus(task.status);
    case "none":
      return !task.due;
    default:
      return true;
  }
}

/**
 * Apply the toolbar filters. `includeCompleted` overrides `showCompleted`
 * (the board always shows its Done / Cancelled columns).
 */
export function applyViewFilters(
  tasks: VaultTaskItem[],
  f: ViewFilters,
  today: string,
  includeCompleted = f.showCompleted
): VaultTaskItem[] {
  const query = f.query.trim();
  return tasks.filter(
    (t) =>
      (includeCompleted || isOpenStatus(t.status)) &&
      dueMatches(t, f.due, today) &&
      (f.priority === "all" || t.priority === f.priority) &&
      (!f.tag || tagMatches(t.tags, f.tag)) &&
      (!query || queryMatches(t, query))
  );
}

/** Higher is more important. */
export const PRIORITY_RANK: Record<VaultTaskPriority, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };

/** Due date ascending (undated last), then priority, note and line. */
export function compareTasks(a: VaultTaskItem, b: VaultTaskItem): number {
  if (a.due !== b.due) {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due < b.due ? -1 : 1;
  }
  return (
    PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
    a.note_name.localeCompare(b.note_name, undefined, { sensitivity: "base" }) ||
    a.line - b.line
  );
}

/** List-view bucket of an open task. */
export type DueBucket = "overdue" | "today" | "week" | "later" | "none";

/** Which List-view group an open task belongs to. */
export function dueBucket(task: VaultTaskItem, today: string): DueBucket {
  if (!task.due) return "none";
  if (task.due < today) return "overdue";
  if (task.due === today) return "today";
  if (task.due <= addDaysIso(today, 6)) return "week";
  return "later";
}

/** A labelled group of tasks. */
export interface TaskGroup {
  id: DueBucket | "completed";
  label: string;
  tasks: VaultTaskItem[];
}

const BUCKETS: Array<{ id: DueBucket; label: string }> = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "later", label: "Later" },
  { id: "none", label: "No date" },
];

/** Open tasks by due bucket, then a "Completed" group; empty groups omitted. */
export function groupByDue(tasks: VaultTaskItem[], today: string): TaskGroup[] {
  const groups = new Map<TaskGroup["id"], VaultTaskItem[]>();
  for (const task of tasks) {
    const id = isOpenStatus(task.status) ? dueBucket(task, today) : "completed";
    const list = groups.get(id);
    if (list) list.push(task);
    else groups.set(id, [task]);
  }
  const out: TaskGroup[] = [];
  for (const b of BUCKETS) {
    const list = groups.get(b.id);
    if (list) out.push({ id: b.id, label: b.label, tasks: list.sort(compareTasks) });
  }
  const completed = groups.get("completed");
  if (completed) {
    out.push({
      id: "completed",
      label: "Completed",
      tasks: completed.sort((a, b) => (b.done_date ?? "").localeCompare(a.done_date ?? "") || compareTasks(a, b)),
    });
  }
  return out;
}

/** All tasks of one note with progress counters. */
export interface NoteGroup {
  notePath: string;
  noteName: string;
  /** Tasks in line order. */
  tasks: VaultTaskItem[];
  total: number;
  open: number;
  done: number;
  overdue: number;
  /** Done share of non-cancelled tasks, 0…1. */
  progress: number;
}

/** Tasks grouped per note: notes with open tasks first, then by name. */
export function groupByNote(tasks: VaultTaskItem[], today: string): NoteGroup[] {
  const map = new Map<string, NoteGroup>();
  for (const task of tasks) {
    let group = map.get(task.note_path);
    if (!group) {
      group = { notePath: task.note_path, noteName: task.note_name, tasks: [], total: 0, open: 0, done: 0, overdue: 0, progress: 0 };
      map.set(task.note_path, group);
    }
    group.tasks.push(task);
    group.total += 1;
    if (task.status === "done") group.done += 1;
    if (isOpenStatus(task.status)) {
      group.open += 1;
      if (task.due && task.due < today) group.overdue += 1;
    }
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.tasks.sort((a, b) => a.line - b.line);
    const countable = g.tasks.filter((t) => t.status !== "cancelled").length;
    g.progress = countable === 0 ? 1 : g.done / countable;
  }
  return groups.sort(
    (a, b) =>
      Number(b.open > 0) - Number(a.open > 0) ||
      a.noteName.localeCompare(b.noteName, undefined, { sensitivity: "base" }) ||
      a.notePath.localeCompare(b.notePath)
  );
}

/** Board columns in display order. */
export const BOARD_COLUMNS: Array<{ id: VaultTaskStatus; label: string }> = [
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" },
  { id: "cancelled", label: "Cancelled" },
];

/** Tasks per board column; open columns by due date, closed ones newest first. */
export function boardColumns(tasks: VaultTaskItem[]): Record<VaultTaskStatus, VaultTaskItem[]> {
  const cols: Record<VaultTaskStatus, VaultTaskItem[]> = { todo: [], in_progress: [], done: [], cancelled: [] };
  for (const t of tasks) cols[t.status].push(t);
  cols.todo.sort(compareTasks);
  cols.in_progress.sort(compareTasks);
  const closed = (a: VaultTaskItem, b: VaultTaskItem) =>
    (b.done_date ?? "").localeCompare(a.done_date ?? "") || compareTasks(a, b);
  cols.done.sort(closed);
  cols.cancelled.sort(closed);
  return cols;
}

/** Every tag in use, sorted case-insensitively. */
export function collectTags(tasks: VaultTaskItem[]): string[] {
  const seen = new Map<string, string>();
  for (const t of tasks) for (const tag of t.tags) if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
