/**
 * Pure single-line task edits — the TypeScript port of `apply_status`,
 * `apply_due`, `apply_priority` and `append_task_to_content` in
 * `src-tauri/src/engine/vault_tasks.rs`. The mock backend uses them so the
 * browser preview writes exactly what the desktop app would. Error messages
 * match the Rust `AetherError` display strings.
 */
import type { VaultTaskItem, VaultTaskPriority, VaultTaskStatus } from "../../types/vaulttasks";
import {
  fenceCloses,
  fenceOpen,
  frontmatterEnd,
  headingTitle,
  parseTaskLine,
  parseTasks,
  priorityEmoji,
  scanMarkers,
  splitLines,
  statusFromChar,
  statusMarker,
  stripBom,
  trimBlanks,
  type TaskLine,
  type TaskMarker,
} from "./parser";

/** Longest task text accepted when appending. */
export const MAX_TASK_TEXT = 2000;
/** Start of the message thrown when a line no longer holds the expected task. */
export const STALE_TASK_ERROR = "note changed, rescan";

/** True when an error message reports a stale line ("note changed, rescan"). */
export function isStaleTaskError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(STALE_TASK_ERROR);
}

function staleError(line: number): Error {
  return new Error(`vault error: ${STALE_TASK_ERROR} (line ${line + 1} no longer holds this task)`);
}

interface NoteStyle {
  emoji: boolean;
  text: boolean;
}

function noteStyle(tasks: VaultTaskItem[]): NoteStyle {
  const style: NoteStyle = { emoji: false, text: false };
  for (const task of tasks) {
    for (const m of scanMarkers(task.text_raw)) {
      if (m.syntax === "emoji") style.emoji = true;
      else if (m.syntax === "text") style.text = true;
    }
  }
  return style;
}

const prefersText = (style: NoteStyle) => style.text && !style.emoji;
const isDateKind = (m: TaskMarker) => m.kind !== "priority" && m.kind !== "block";

/** Remove `text[start, end)` plus one adjacent blank. */
function removeSpan(text: string, start: number, end: number): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  let joined: string;
  if (before.endsWith(" ") || before.endsWith("\t")) joined = before.slice(0, -1) + after;
  else if (after.startsWith(" ") || after.startsWith("\t")) joined = before + after.slice(1);
  else joined = before + after;
  return joined.replace(/[ \t]+$/, "");
}

/** Insert `marker` at `at`, separated by single spaces. */
function insertMarker(text: string, at: number, marker: string): string {
  const head = text.slice(0, at).replace(/[ \t]+$/, "");
  const tail = text.slice(at).replace(/^[ \t]+/, "");
  if (!head && !tail) return marker;
  if (!head) return `${marker} ${tail}`;
  if (!tail) return `${head} ${marker}`;
  return `${head} ${marker} ${tail}`;
}

const blockStart = (markers: TaskMarker[]) => markers.find((m) => m.kind === "block")?.start;

function doneInsertPoint(text: string, markers: TaskMarker[]): number {
  return blockStart(markers) ?? text.length;
}

function dueInsertPoint(text: string, markers: TaskMarker[]): number {
  return markers.find((m) => m.kind === "done")?.start ?? blockStart(markers) ?? text.length;
}

function priorityInsertPoint(text: string, markers: TaskMarker[]): number {
  return markers.find(isDateKind)?.start ?? blockStart(markers) ?? text.length;
}

interface LineEdit {
  line: string;
  task: TaskLine;
  markers: TaskMarker[];
  style: NoteStyle;
}

/** The line with its text (and optionally status char) replaced. */
function rebuild(ctx: LineEdit, status: string | null, text: string): string {
  const statusEnd = ctx.task.statusAt + ctx.task.statusChar.length;
  const head = ctx.line.slice(0, ctx.task.statusAt) + (status ?? ctx.task.statusChar);
  if (text === ctx.task.text) return head + ctx.line.slice(statusEnd);
  return head + ctx.line.slice(statusEnd, ctx.task.textAt) + text;
}

function editTaskLine(
  content: string,
  notePath: string,
  line: number,
  expectedText: string,
  edit: (ctx: LineEdit) => string
): string {
  const tasks = parseTasks(notePath, content);
  const task = tasks.find((t) => t.line === line);
  if (!task || task.text_raw !== trimBlanks(expectedText)) throw staleError(line);
  const [bom, body] = stripBom(content);
  const lines = body.split("\n");
  const raw = lines[line];
  if (raw === undefined) throw staleError(line);
  const cr = raw.endsWith("\r") ? "\r" : "";
  const textLine = cr ? raw.slice(0, -1) : raw;
  const parsed = parseTaskLine(textLine);
  if (!parsed) throw staleError(line);
  lines[line] = edit({ line: textLine, task: parsed, markers: scanMarkers(parsed.text), style: noteStyle(tasks) }) + cr;
  return bom + lines.join("\n");
}

/**
 * Set a task's status. Checking appends `✅ today` when the note already uses
 * Tasks-plugin emoji; any other status removes the done date.
 */
export function applyStatus(
  content: string,
  notePath: string,
  line: number,
  expectedText: string,
  status: VaultTaskStatus,
  today: string
): string {
  return editTaskLine(content, notePath, line, expectedText, (ctx) => {
    const current = statusFromChar(ctx.task.statusChar);
    const statusChar = current !== status ? statusMarker(status) : null;
    const done = ctx.markers.find((m) => m.kind === "done");
    let text = ctx.task.text;
    if (status === "done") {
      if (!done && ctx.style.emoji) text = insertMarker(text, doneInsertPoint(text, ctx.markers), `✅ ${today}`);
    } else if (done) {
      text = removeSpan(text, done.start, done.end);
    }
    return rebuild(ctx, statusChar, text);
  });
}

/** Set (`YYYY-MM-DD`) or clear (`null`) the due date, keeping an existing marker's syntax. */
export function applyDue(
  content: string,
  notePath: string,
  line: number,
  expectedText: string,
  due: string | null
): string {
  return editTaskLine(content, notePath, line, expectedText, (ctx) => {
    const text = ctx.task.text;
    const existing = ctx.markers.find((m) => m.kind === "due");
    let next = text;
    if (existing?.date && due) {
      next = text.slice(0, existing.date.start) + due + text.slice(existing.date.end);
    } else if (existing && !due) {
      next = removeSpan(text, existing.start, existing.end);
    } else if (!existing && due) {
      const marker = prefersText(ctx.style) ? `due:${due}` : `📅 ${due}`;
      next = insertMarker(text, dueInsertPoint(text, ctx.markers), marker);
    }
    return rebuild(ctx, null, next);
  });
}

/** Set or clear (`"none"`) the priority, keeping an existing marker's syntax. */
export function applyPriority(
  content: string,
  notePath: string,
  line: number,
  expectedText: string,
  priority: VaultTaskPriority
): string {
  return editTaskLine(content, notePath, line, expectedText, (ctx) => {
    const text = ctx.task.text;
    const existing = ctx.markers.find((m) => m.kind === "priority");
    const glyph = priorityEmoji(priority);
    const word = priority === "none" ? null : `!${priority}`;
    let next = text;
    if (existing && glyph && word) {
      const replacement = existing.syntax === "emoji" ? glyph : word;
      next = text.slice(0, existing.start) + replacement + text.slice(existing.end);
    } else if (existing) {
      next = removeSpan(text, existing.start, existing.end);
    } else if (glyph && word) {
      next = insertMarker(text, priorityInsertPoint(text, ctx.markers), prefersText(ctx.style) ? word : glyph);
    }
    return rebuild(ctx, null, next);
  });
}

/** Validate and normalise the text of a new task (single line, trimmed). */
export function sanitizeTaskText(text: string): string {
  const trimmed = text.replace(/[\r\n]/g, " ").trim();
  if (!trimmed) throw new Error("invalid input: task text is required");
  if ([...trimmed].length > MAX_TASK_TEXT) {
    throw new Error(`invalid input: task text is longer than ${MAX_TASK_TEXT} characters`);
  }
  return trimmed;
}

/**
 * Add `- [ ] text` at the end of a `Tasks` section (any heading level) or,
 * without one, at the end of the note.
 */
export function appendTaskToContent(content: string, text: string): { content: string; line: number } {
  const clean = sanitizeTaskText(text);
  const [bom, body] = stripBom(content);
  const cr = body.includes("\r\n") ? "\r" : "";
  const lines = body.split("\n");
  const plain = splitLines(body);

  const skipUntil = frontmatterEnd(plain);
  let fence: [string, number] | null = null;
  const headings: Array<{ idx: number; level: number; title: string }> = [];
  for (let idx = 0; idx < plain.length; idx++) {
    const line = plain[idx];
    if (skipUntil !== null && idx <= skipUntil) continue;
    if (fence) {
      if (fenceCloses(line, fence[0], fence[1])) fence = null;
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      fence = open;
      continue;
    }
    const heading = headingTitle(line);
    if (heading) headings.push({ idx, level: heading[0], title: heading[1] });
  }

  const target = headings.findIndex((h) => trimBlanks(h.title).toLowerCase() === "tasks");
  let insertAt: number;
  if (target >= 0) {
    const { idx: start, level } = headings[target];
    const end = headings.slice(target + 1).find((h) => h.level <= level)?.idx ?? plain.length;
    let lastContent = start;
    for (let i = end - 1; i > start; i--) {
      if (trimBlanks(plain[i]) !== "") {
        lastContent = i;
        break;
      }
    }
    insertAt = lastContent + 1;
  } else {
    insertAt = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  }
  if (insertAt === lines.length) {
    // Inserting after an unterminated last line: terminate it and keep a final newline.
    const last = lines.length - 1;
    if (cr && last >= 0 && !lines[last].endsWith("\r")) lines[last] += "\r";
    lines.push("");
    insertAt = lines.length - 1;
  }
  lines.splice(insertAt, 0, `- [ ] ${clean}${cr}`);
  return { content: bom + lines.join("\n"), line: insertAt };
}

/**
 * Optimistic copy of a task with a new status, as the UI shows it before the
 * backend confirms (the backend result replaces it).
 */
export function withStatus(task: VaultTaskItem, status: VaultTaskStatus): VaultTaskItem {
  const statusChar = statusFromChar(task.status_char) === status ? task.status_char : statusMarker(status);
  return { ...task, status, status_char: statusChar, checked: status === "done" };
}

/**
 * Text for a new task from the quick-add dialog: appends the priority and
 * due date as Tasks-plugin emoji (priority first, like the plugin writes it)
 * unless the typed text already carries such a marker.
 */
export function composeTaskText(text: string, due: string | null, priority: VaultTaskPriority): string {
  let out = text.trim();
  const markers = scanMarkers(out);
  const glyph = priorityEmoji(priority);
  if (glyph && !markers.some((m) => m.kind === "priority")) out = `${out} ${glyph}`;
  if (due && !markers.some((m) => m.kind === "due")) out = `${out} 📅 ${due}`;
  return out;
}
