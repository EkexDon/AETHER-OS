/**
 * Line diff for the note history view.
 *
 * `diffLines` implements Myers' O((N+M)·D) shortest-edit-script algorithm on
 * lines, after trimming the common prefix and suffix (the typical note edit
 * touches a few lines in the middle, so D stays tiny). The search keeps only
 * the `2d+1` live diagonals per round, so memory is O(D²); when the edit
 * distance exceeds `maxEditDistance` the middle falls back to "all removed,
 * all added", which is still a correct (just not minimal) diff.
 *
 * Helpers turn the result into display structures: collapsed unchanged
 * regions, side-by-side rows and an inline changed span for paired lines.
 */

export type DiffLineKind = "equal" | "add" | "remove";

/** One line of a unified diff. Line numbers are 1-based. */
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the old text (`null` for added lines). */
  oldNumber: number | null;
  /** Line number in the new text (`null` for removed lines). */
  newNumber: number | null;
}

/** Added / removed line counts. */
export interface DiffStats {
  added: number;
  removed: number;
}

/** A run of lines to show, or a folded run of unchanged lines. */
export type DiffSegment =
  | { type: "lines"; lines: DiffLine[] }
  | { type: "collapsed"; lines: DiffLine[]; key: string };

/** One row of the side-by-side view (`null` = empty cell). */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Changed character range of a modified line: `text.slice(start, end)`. */
export interface InlineSpan {
  start: number;
  end: number;
}

export interface DiffOptions {
  /** Upper bound for the Myers search before falling back (default 2000). */
  maxEditDistance?: number;
}

const DEFAULT_MAX_EDIT_DISTANCE = 2000;

/**
 * Split text into lines. `\r\n` and `\r` count as line breaks and a single
 * trailing newline does not create an empty last line; `null`/`""` → `[]`.
 */
export function splitLines(text: string | null | undefined): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = "equal" | "add" | "remove";

/**
 * Myers forward search. Returns, per round `d`, the diagonals `k ∈ [-d, d]`
 * as they were *before* the round (what the backtrack needs), or `null` when
 * the edit distance exceeds `maxD`.
 */
function shortestEditTrace(a: string[], b: string[], maxD: number): Int32Array[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxD);
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]; // step down: insertion
      } else {
        x = v[offset + k - 1] + 1; // step right: deletion
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return trace;
    }
  }
  return null;
}

/** Walk the trace back from (n, m) and emit the edit script in order. */
function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    if (d === 0) {
      while (x > 0 && y > 0) {
        ops.push("equal");
        x--;
        y--;
      }
      break;
    }
    const row = trace[d];
    const at = (k: number) => row[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("equal");
      x--;
      y--;
    }
    ops.push(x === prevX ? "add" : "remove");
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function editScript(a: string[], b: string[], maxD: number): Op[] {
  if (a.length === 0) return b.map(() => "add");
  if (b.length === 0) return a.map(() => "remove");
  const trace = shortestEditTrace(a, b, maxD);
  if (!trace) return [...a.map((): Op => "remove"), ...b.map((): Op => "add")];
  return backtrack(trace, a.length, b.length);
}

/** Line diff of two texts (either may be `null`, meaning "no file"). */
export function diffLines(
  oldText: string | null | undefined,
  newText: string | null | undefined,
  options: DiffOptions = {}
): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const maxD = Math.max(0, options.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: Op[] = [
    ...Array.from({ length: prefix }, (): Op => "equal"),
    ...editScript(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix), maxD),
    ...Array.from({ length: suffix }, (): Op => "equal"),
  ];

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "equal") {
      out.push({ kind: "equal", text: b[j], oldNumber: i + 1, newNumber: j + 1 });
      i++;
      j++;
    } else if (op === "remove") {
      out.push({ kind: "remove", text: a[i], oldNumber: i + 1, newNumber: null });
      i++;
    } else {
      out.push({ kind: "add", text: b[j], oldNumber: null, newNumber: j + 1 });
      j++;
    }
  }
  return out;
}

/** Count added and removed lines. */
export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    else if (line.kind === "remove") removed++;
  }
  return { added, removed };
}

/** True when the diff contains at least one added or removed line. */
export function hasChanges(lines: DiffLine[]): boolean {
  return lines.some((l) => l.kind !== "equal");
}

/**
 * Fold long runs of unchanged lines, keeping `context` lines next to every
 * change. Runs are only folded when that hides at least `minHidden` lines.
 * A diff without changes is returned as one visible segment.
 */
export function collapseUnchanged(lines: DiffLine[], context = 3, minHidden = 4): DiffSegment[] {
  if (!hasChanges(lines)) return lines.length ? [{ type: "lines", lines }] : [];
  const segments: DiffSegment[] = [];
  let visible: DiffLine[] = [];
  const flush = () => {
    if (visible.length) segments.push({ type: "lines", lines: visible });
    visible = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "equal") {
      visible.push(lines[i]);
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].kind === "equal") end++;
    const run = lines.slice(i, end);
    const atStart = i === 0;
    const atEnd = end === lines.length;
    const keepHead = atStart ? 0 : context;
    const keepTail = atEnd ? 0 : context;
    const hidden = run.length - keepHead - keepTail;
    if (hidden >= minHidden) {
      visible.push(...run.slice(0, keepHead));
      flush();
      const folded = run.slice(keepHead, run.length - keepTail);
      segments.push({ type: "collapsed", lines: folded, key: `fold-${folded[0].newNumber ?? i}` });
      visible.push(...run.slice(run.length - keepTail));
    } else {
      visible.push(...run);
    }
    i = end;
  }
  flush();
  return segments;
}

/**
 * Pair lines for a side-by-side view: unchanged lines appear on both sides,
 * a block of removals followed by additions is laid out row by row.
 */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "equal") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "remove") removed.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") added.push(lines[i++]);
    const count = Math.max(removed.length, added.length);
    for (let r = 0; r < count; r++) {
      rows.push({ left: removed[r] ?? null, right: added[r] ?? null });
    }
  }
  return rows;
}

/**
 * The changed middle of two versions of one line (common prefix and suffix
 * excluded), for highlighting. Returns spans for the old and the new text,
 * or `null` when the lines share nothing worth highlighting.
 */
export function inlineChange(oldLine: string, newLine: string): { old: InlineSpan; new: InlineSpan } | null {
  if (oldLine === newLine) return null;
  let start = 0;
  const max = Math.min(oldLine.length, newLine.length);
  while (start < max && oldLine[start] === newLine[start]) start++;
  let end = 0;
  while (
    end < oldLine.length - start &&
    end < newLine.length - start &&
    oldLine[oldLine.length - 1 - end] === newLine[newLine.length - 1 - end]
  ) {
    end++;
  }
  // Nothing in common: the whole line changed, no inline highlight needed.
  if (start === 0 && end === 0) return null;
  return {
    old: { start, end: oldLine.length - end },
    new: { start, end: newLine.length - end },
  };
}

/**
 * For each removed line directly followed (within its block) by an added
 * line, the pair's inline change. Keyed by the index in `lines`.
 */
export function pairInlineChanges(lines: DiffLine[]): Map<number, InlineSpan> {
  const spans = new Map<number, InlineSpan>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "remove") {
      i++;
      continue;
    }
    const removedStart = i;
    while (i < lines.length && lines[i].kind === "remove") i++;
    const addedStart = i;
    while (i < lines.length && lines[i].kind === "add") i++;
    const pairs = Math.min(addedStart - removedStart, i - addedStart);
    for (let p = 0; p < pairs; p++) {
      const change = inlineChange(lines[removedStart + p].text, lines[addedStart + p].text);
      if (change) {
        spans.set(removedStart + p, change.old);
        spans.set(addedStart + p, change.new);
      }
    }
  }
  return spans;
}
