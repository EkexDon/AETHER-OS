/**
 * Small line diff for the sync conflict view.
 *
 * `diffLines` implements Myers' O((N+M)·D) algorithm after trimming the
 * common prefix and suffix, so typical notes with a handful of edits diff
 * instantly. Very different inputs (edit distance above `maxEdits`) fall
 * back to "everything removed, everything added" instead of stalling the UI.
 * `sideBySide` pairs removals with additions into rows for a two-column view
 * and `collapseRows` folds long unchanged stretches.
 */

/** One line-level operation. */
export interface DiffOp {
  type: "equal" | "delete" | "insert";
  text: string;
  /** 1-based line number in the left (old) text. */
  leftLine?: number;
  /** 1-based line number in the right (new) text. */
  rightLine?: number;
}

/** One cell of the side-by-side view. */
export interface DiffCell {
  line: number;
  text: string;
}

/** One row of the side-by-side view. */
export interface DiffRow {
  kind: "equal" | "change" | "delete" | "insert";
  left: DiffCell | null;
  right: DiffCell | null;
}

/** A folded stretch of unchanged rows. */
export interface DiffSkip {
  kind: "skip";
  count: number;
}

/** Counts of a diff. */
export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

/** Split text into lines (a trailing newline does not add an empty line). */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers shortest edit script on two line arrays; `null` when D > maxEdits. */
function myers(a: string[], b: string[], maxEdits: number): DiffOp["type"][] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // Backtrack through the saved V arrays.
  const ops: DiffOp["type"][] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("equal");
      x--;
      y--;
    }
    ops.push(down ? "insert" : "delete");
    if (down) y--;
    else x--;
  }
  while (x > 0 && y > 0) {
    ops.push("equal");
    x--;
    y--;
  }
  return ops.reverse();
}

/**
 * Line diff of `left` → `right`. `maxEdits` bounds the work (default 4000
 * changed lines).
 */
export function diffLines(left: string, right: string, maxEdits = 4000): DiffOp[] {
  const a = splitLines(left);
  const b = splitLines(right);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const script =
    myers(midA, midB, maxEdits) ?? [
      ...midA.map(() => "delete" as const),
      ...midB.map(() => "insert" as const),
    ];

  const ops: DiffOp[] = [];
  let li = 0;
  let ri = 0;
  const push = (type: DiffOp["type"]) => {
    if (type === "equal") {
      ops.push({ type, text: a[li], leftLine: li + 1, rightLine: ri + 1 });
      li++;
      ri++;
    } else if (type === "delete") {
      ops.push({ type, text: a[li], leftLine: li + 1 });
      li++;
    } else {
      ops.push({ type, text: b[ri], rightLine: ri + 1 });
      ri++;
    }
  };
  for (let i = 0; i < start; i++) push("equal");
  for (const type of script) push(type);
  while (li < a.length && ri < b.length) push("equal");
  return ops;
}

/** Added / removed / unchanged line counts. */
export function diffStats(ops: DiffOp[]): DiffStats {
  const stats: DiffStats = { added: 0, removed: 0, unchanged: 0 };
  for (const op of ops) {
    if (op.type === "insert") stats.added++;
    else if (op.type === "delete") stats.removed++;
    else stats.unchanged++;
  }
  return stats;
}

/** Pair each run of deletions with the following run of insertions. */
export function sideBySide(ops: DiffOp[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === "equal") {
      rows.push({
        kind: "equal",
        left: { line: op.leftLine ?? 0, text: op.text },
        right: { line: op.rightLine ?? 0, text: op.text },
      });
      i++;
      continue;
    }
    const deletes: DiffOp[] = [];
    const inserts: DiffOp[] = [];
    while (i < ops.length && ops[i].type === "delete") deletes.push(ops[i++]);
    while (i < ops.length && ops[i].type === "insert") inserts.push(ops[i++]);
    const count = Math.max(deletes.length, inserts.length);
    for (let j = 0; j < count; j++) {
      const del = deletes[j];
      const ins = inserts[j];
      rows.push({
        kind: del && ins ? "change" : del ? "delete" : "insert",
        left: del ? { line: del.leftLine ?? 0, text: del.text } : null,
        right: ins ? { line: ins.rightLine ?? 0, text: ins.text } : null,
      });
    }
  }
  return rows;
}

/** Fold unchanged stretches longer than `2 × context` into skip markers. */
export function collapseRows(rows: DiffRow[], context = 3): (DiffRow | DiffSkip)[] {
  const out: (DiffRow | DiffSkip)[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "equal") {
      out.push(rows[i++]);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === "equal") j++;
    const run = rows.slice(i, j);
    const leading = i === 0 ? 0 : context;
    const trailing = j === rows.length ? 0 : context;
    if (run.length > leading + trailing + 1) {
      out.push(...run.slice(0, leading));
      out.push({ kind: "skip", count: run.length - leading - trailing });
      out.push(...run.slice(run.length - trailing));
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}
