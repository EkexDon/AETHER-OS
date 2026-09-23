/**
 * TypeScript port of the vault task parser in
 * `src-tauri/src/engine/vault_tasks.rs` (the source of truth). Used by the
 * mock backend and for optimistic UI updates. Both implementations are
 * checked against the shared golden fixture in `__fixtures__/`, so any change
 * here must be mirrored in Rust (and the golden regenerated with
 * `UPDATE_VAULTTASKS_GOLDEN=1 cargo test golden`).
 *
 * Regexes deliberately avoid constructs whose semantics differ between the
 * Rust `regex` crate and JavaScript: `[0-9]` instead of `\d`, `[^\n]` instead
 * of `.`, and ASCII word boundaries only.
 */
import type { VaultTaskItem, VaultTaskPriority, VaultTaskStatus } from "../../types/vaulttasks";

const TASK_RE = /^((?:[ \t]*>)*[ \t]*)(?:[-*+]|[0-9]{1,9}[.)])[ \t]+\[([^\]\r\n])\](?:[ \t]+([^\n]*?))?[ \t]*$/du;
const LIST_ITEM_RE = /^((?:[ \t]*>)*[ \t]*)(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]|$)/u;
const FENCE_RE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})([^\n]*)$/u;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+([^\n]+?)(?:[ \t]+#+)?[ \t]*$/u;
const TAG_RE = /(?:^|[ \t(])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;
const INLINE_CODE_RE = /`[^`]*`/g;
const ALPHABETIC_RE = /\p{Alphabetic}/u;

const DATE = String.raw`[0-9]{4}-[0-9]{2}-[0-9]{2}`;
/** Same alternation (and order) as `marker_regex()` in Rust. */
const MARKER_SOURCE = [
  String.raw`(?<emoji>(?<glyph>📅|📆|🗓|⏳|🛫|✅|➕|❌)\u{FE0F}?[ \t]*(?<edate>${DATE}))\b`,
  String.raw`(?<bracket>[\[(](?<bkey>due|scheduled|start|done|completion|created)::?[ \t]*(?<bdate>${DATE})[ \t]*[\])])`,
  String.raw`(?<at>@(?<akey>due|scheduled|start|done)\((?<adate>${DATE})\))`,
  String.raw`(?:^|[ \t])(?<bare>(?<key>due|scheduled|start|done)::?[ \t]*(?<date>${DATE}))\b`,
  String.raw`(?<pemoji>🔺|⏫|🔼|🔽|⏬)\u{FE0F}?`,
  String.raw`(?:^|[ \t])(?<pword>!(?<word>urgent|highest|high|medium|med|lowest|low))\b`,
  String.raw`(?:^|[ \t])(?<block>\^[a-z0-9-]+)[ \t]*$`,
].join("|");
const MARKER_RE = new RegExp(MARKER_SOURCE, "giud");

/** Kind of a metadata marker inside a task text. */
export type MarkerKind = "due" | "scheduled" | "start" | "done" | "created" | "cancelled" | "priority" | "block";
/** `emoji` (Obsidian Tasks), `text` (`due:`, `!high`) or `neutral` (block ids). */
export type MarkerSyntax = "emoji" | "text" | "neutral";

/** A marker with its UTF-16 range inside the task text. */
export interface TaskMarker {
  kind: MarkerKind;
  syntax: MarkerSyntax;
  start: number;
  end: number;
  /** Priority markers only. */
  priority?: VaultTaskPriority;
  /** Date markers only: the date and its range. */
  date?: { value: string; start: number; end: number };
}

/** A task line split into its parts (UTF-16 offsets into the line). */
export interface TaskLine {
  indent: number;
  statusAt: number;
  statusChar: string;
  textAt: number;
  text: string;
}

/** Status for a checkbox character. */
export function statusFromChar(c: string): VaultTaskStatus {
  if (c === "x" || c === "X") return "done";
  if (c === "/") return "in_progress";
  if (c === "-") return "cancelled";
  return "todo";
}

/** The checkbox character written for a status. */
export function statusMarker(status: VaultTaskStatus): string {
  switch (status) {
    case "in_progress":
      return "/";
    case "done":
      return "x";
    case "cancelled":
      return "-";
    default:
      return " ";
  }
}

/** Todo or in progress. */
export function isOpenStatus(status: VaultTaskStatus): boolean {
  return status === "todo" || status === "in_progress";
}

/** Obsidian Tasks emoji of a priority. */
export function priorityEmoji(priority: VaultTaskPriority): string | null {
  switch (priority) {
    case "urgent":
      return "🔺";
    case "high":
      return "⏫";
    case "medium":
      return "🔼";
    case "low":
      return "🔽";
    default:
      return null;
  }
}

function priorityFromEmoji(glyph: string): VaultTaskPriority {
  if (glyph === "🔺") return "urgent";
  if (glyph === "⏫") return "high";
  if (glyph === "🔼") return "medium";
  return "low";
}

function priorityFromWord(word: string): VaultTaskPriority {
  const w = word.toLowerCase();
  if (w === "urgent" || w === "highest") return "urgent";
  if (w === "high") return "high";
  if (w === "medium" || w === "med") return "medium";
  return "low";
}

function dateKeyKind(key: string): MarkerKind {
  const k = key.toLowerCase();
  if (k === "due" || k === "scheduled" || k === "start" || k === "created") return k;
  return "done";
}

function glyphKind(glyph: string): MarkerKind {
  switch (glyph) {
    case "⏳":
      return "scheduled";
    case "🛫":
      return "start";
    case "✅":
      return "done";
    case "➕":
      return "created";
    case "❌":
      return "cancelled";
    default:
      return "due";
  }
}

/** True for a real calendar date `YYYY-MM-DD` (proleptic Gregorian, like chrono). */
export function isValidIsoDate(value: string): boolean {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

/**
 * All markers of a task text, in order. Impossible dates and markers inside
 * inline code spans are ignored and stay part of the text.
 */
export function scanMarkers(text: string): TaskMarker[] {
  const code = [...text.matchAll(INLINE_CODE_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const markers: TaskMarker[] = [];
  for (const m of text.matchAll(MARKER_RE)) {
    const groups = m.groups ?? {};
    const spans = m.indices?.groups ?? {};
    let marker: TaskMarker | null = null;
    const dated = (group: string, dateGroup: string, kind: MarkerKind, syntax: MarkerSyntax): TaskMarker | null => {
      const whole = spans[group];
      const dateSpan = spans[dateGroup];
      const value = groups[dateGroup];
      if (!whole || !dateSpan || !value || !isValidIsoDate(value)) return null;
      return { kind, syntax, start: whole[0], end: whole[1], date: { value, start: dateSpan[0], end: dateSpan[1] } };
    };
    if (groups.emoji !== undefined) {
      marker = dated("emoji", "edate", glyphKind(groups.glyph ?? ""), "emoji");
    } else if (groups.bracket !== undefined) {
      marker = dated("bracket", "bdate", dateKeyKind(groups.bkey ?? ""), "text");
    } else if (groups.at !== undefined) {
      marker = dated("at", "adate", dateKeyKind(groups.akey ?? ""), "text");
    } else if (groups.bare !== undefined) {
      marker = dated("bare", "date", dateKeyKind(groups.key ?? ""), "text");
    } else if (groups.pemoji !== undefined && spans.pemoji) {
      marker = {
        kind: "priority",
        syntax: "emoji",
        start: spans.pemoji[0],
        end: (m.index ?? 0) + m[0].length,
        priority: priorityFromEmoji(groups.pemoji),
      };
    } else if (groups.pword !== undefined && spans.pword) {
      marker = {
        kind: "priority",
        syntax: "text",
        start: spans.pword[0],
        end: spans.pword[1],
        priority: priorityFromWord(groups.word ?? ""),
      };
    } else if (groups.block !== undefined && spans.block) {
      marker = { kind: "block", syntax: "neutral", start: spans.block[0], end: spans.block[1] };
    }
    if (marker) {
      const { start, end } = marker;
      if (!code.some(([s, e]) => start < e && end > s)) markers.push(marker);
    }
  }
  return markers;
}

/** Strip spaces and tabs (only) from both ends. */
export function trimBlanks(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, "");
}

function cleanText(text: string, markers: TaskMarker[]): string {
  let out = "";
  let cursor = 0;
  for (const m of markers) {
    out += text.slice(cursor, m.start) + " ";
    cursor = m.end;
  }
  out += text.slice(cursor);
  return trimBlanks(out.replace(/[ \t]+/g, " "));
}

/** Inline `#tags` (not inside code spans), de-duplicated, without `#`. */
export function extractTags(text: string): string[] {
  const prose = text.replace(INLINE_CODE_RE, " ");
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const m of prose.matchAll(TAG_RE)) {
    const tag = m[1];
    // Purely numeric "#42" is an issue reference, not a tag.
    if (!ALPHABETIC_RE.test(tag)) continue;
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;
const encoder = new TextEncoder();

/** FNV-1a 64-bit hash of the UTF-8 bytes, as 16 hex digits. */
export function fnv1a64(input: string): string {
  let hash = FNV_OFFSET;
  for (const byte of encoder.encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & U64;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Stable task id from note path, 0-based line and raw text. */
export function taskId(notePath: string, line: number, textRaw: string): string {
  return fnv1a64(`${notePath}\u0000${line}\u0000${textRaw}`);
}

/** File name without a (case-insensitive) `.md` extension. */
export function noteNameOf(notePath: string): string {
  const base = notePath.split(/[\\/]/).pop() ?? notePath;
  return /\.md$/i.test(base) ? base.slice(0, -3) : base;
}

/** Columns of leading whitespace (tab = 4) after blockquote markers. */
function indentColumns(prefix: string): number {
  const idx = prefix.lastIndexOf(">");
  let rest = prefix;
  if (idx >= 0) {
    rest = prefix.slice(idx + 1);
    if (rest.startsWith(" ")) rest = rest.slice(1);
  }
  let cols = 0;
  for (const c of rest) cols += c === "\t" ? 4 : 1;
  return cols;
}

/** Split a single line into task parts, or `null` when it is no task. */
export function parseTaskLine(line: string): TaskLine | null {
  const m = TASK_RE.exec(line);
  if (!m || m[3] === undefined || m[3] === "" || !m.indices) return null;
  const status = m.indices[2];
  const text = m.indices[3];
  if (!status || !text) return null;
  return {
    indent: indentColumns(m[1] ?? ""),
    statusAt: status[0],
    statusChar: m[2],
    textAt: text[0],
    text: m[3],
  };
}

/** `[level, title]` for an ATX heading line. */
export function headingTitle(line: string): [number, string] | null {
  const m = HEADING_RE.exec(line);
  return m ? [m[1].length, m[2]] : null;
}

/** `[fence char, run length]` when the line opens a fenced code block. */
export function fenceOpen(line: string): [string, number] | null {
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  const ch = m[1][0];
  // A backtick info string cannot contain backticks (that is inline code).
  if (ch === "`" && m[2].includes("`")) return null;
  return [ch, m[1].length];
}

/** Does the line close a fence opened with `ch` × `len`? */
export function fenceCloses(line: string, ch: string, len: number): boolean {
  const m = FENCE_RE.exec(line);
  return !!m && m[1][0] === ch && m[1].length >= len && trimBlanks(m[2]) === "";
}

/** Index of the closing line of a leading YAML frontmatter block. */
export function frontmatterEnd(lines: string[]): number | null {
  if (lines.length === 0 || lines[0].replace(/[ \t]+$/, "") !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].replace(/[ \t]+$/, "");
    if (t === "---" || t === "...") return i;
  }
  return null;
}

/** `[bom, body]` of note content. */
export function stripBom(content: string): [string, string] {
  return content.startsWith("﻿") ? ["﻿", content.slice(1)] : ["", content];
}

/** Lines split on `\n` with a trailing `\r` removed. */
export function splitLines(body: string): string[] {
  return body.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function buildItem(
  notePath: string,
  noteName: string,
  line: number,
  depth: number,
  section: string | null,
  task: TaskLine
): VaultTaskItem {
  const markers = scanMarkers(task.text);
  const firstDate = (kind: MarkerKind) => markers.find((m) => m.kind === kind)?.date?.value ?? null;
  const priority = markers.find((m) => m.kind === "priority")?.priority ?? "none";
  const status = statusFromChar(task.statusChar);
  return {
    id: taskId(notePath, line, task.text),
    note_path: notePath,
    note_name: noteName,
    line,
    indent: task.indent,
    depth,
    text_raw: task.text,
    text_clean: cleanText(task.text, markers),
    checked: status === "done",
    status_char: task.statusChar,
    status,
    due: firstDate("due"),
    scheduled: firstDate("scheduled"),
    start: firstDate("start"),
    done_date: firstDate("done"),
    priority,
    tags: extractTags(task.text),
    section,
  };
}

/** Every checkbox task in `content`, in line order. */
export function parseTasks(notePath: string, content: string): VaultTaskItem[] {
  const noteName = noteNameOf(notePath);
  const [, body] = stripBom(content);
  const lines = splitLines(body);
  const skipUntil = frontmatterEnd(lines);
  let fence: [string, number] | null = null;
  let section: string | null = null;
  const stack: number[] = [];
  const tasks: VaultTaskItem[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
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
    if (trimBlanks(line) === "") continue;
    const heading = headingTitle(line);
    if (heading) {
      section = heading[1];
      stack.length = 0;
      continue;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      const indent = indentColumns(item[1] ?? "");
      while (stack.length > 0 && stack[stack.length - 1] >= indent) stack.pop();
      const depth = stack.length;
      stack.push(indent);
      const task = parseTaskLine(line);
      if (task) tasks.push(buildItem(notePath, noteName, idx, depth, section, task));
    } else if (!line.startsWith(" ") && !line.startsWith("\t")) {
      stack.length = 0;
    }
  }
  return tasks;
}
