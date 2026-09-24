/**
 * Keep a note's own bytes when the editor saves it.
 *
 * The editor works on a document, not on text: saving serializes the whole
 * document again, and any serializer writes *its* Markdown — one blank line
 * between blocks, `-` bullets, canonical escapes — not the author's. Before
 * this module every save rewrote the entire file that way.
 *
 * Instead the editor remembers two texts when it opens a note:
 *
 * - `source` — the body exactly as it was read;
 * - `canonical` — what the serializer writes for the untouched document.
 *
 * On save, `canonical` → the new serialization is the user's edit, and
 * `canonical` → `source` is the author's formatting. A line-based three-way
 * merge applies the edit to `source` ({@link mergeSource}): every region
 * the user did not touch keeps its original bytes, so a note without edits
 * round-trips byte for byte and a small edit changes only its own lines.
 *
 * Where an edit touches a region the author formatted differently (a list
 * right under a heading, where the serializer puts a blank line), the edit
 * wins for that region. Merges that touch such a region are checked by the
 * caller (`verify`): if the merged text would not read back as the edited
 * document, a stricter merge, and finally the plain serialization, is used.
 */

/** One changed region: `base[aStart, aEnd)` became `other[bStart, bEnd)`. */
export interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** Stop diffing (treat the middle as one change) past this many edits. */
const MAX_EDIT_DISTANCE = 1500;

/**
 * Line diff of `a` → `b` (Myers' O(ND) algorithm after trimming the common
 * prefix and suffix). Hunks are sorted and never overlap.
 *
 * With `key`, lines are aligned by `key(line)`: two lines with the same key
 * but different bytes (re-indented, escaped differently) are paired as a
 * one-line change instead of letting blank lines drive the alignment.
 */
export function diffLines(a: readonly string[], b: readonly string[], key?: (line: string) => string): Hunk[] {
  const k = key ?? ((line: string) => line);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  if (start === endA || start === endB) return [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];

  // Intern the middle lines (by key) as numbers.
  const ids = new Map<string, number>();
  const intern = (line: string) => {
    const id = ids.get(k(line));
    if (id !== undefined) return id;
    ids.set(k(line), ids.size);
    return ids.size - 1;
  };
  const x = a.slice(start, endA).map(intern);
  const y = b.slice(start, endB).map(intern);
  const pairs = myersMatches(x, y);
  if (!pairs) return [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...pairs, [x.length, y.length] as [number, number]]) {
    if (mi > i || mj > j) hunks.push({ aStart: start + i, aEnd: start + mi, bStart: start + j, bEnd: start + mj });
    if (mi < x.length && a[start + mi] !== b[start + mj]) {
      hunks.push({ aStart: start + mi, aEnd: start + mi + 1, bStart: start + mj, bEnd: start + mj + 1 });
    }
    i = mi + 1;
    j = mj + 1;
  }
  return hunks;
}

/** Alignment key for the author's lines: ignores indentation, spacing and backslash escapes. */
export function looseLineKey(line: string): string {
  return line.replace(/\\(?=[!-/:-@[-`{-~])/g, "").replace(/\s+/g, " ").trim();
}

/** Matched index pairs of a shortest edit script, or `null` when it is too long. */
function myersMatches(a: number[], b: number[]): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d]: the furthest x per diagonal k in [-d-1, d+1] before step d.
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found === -1) return null;

  // Walk back from (n, m); every diagonal step is a matched pair.
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snapshot = trace[d];
    const at = (k: number) => snapshot[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  pairs.reverse();
  return pairs;
}

type Side = "ours" | "theirs";

interface Cluster {
  lo: number;
  hi: number;
  ours: Hunk[];
  theirs: Hunk[];
}

/**
 * How eagerly hunks of the two sides are combined into one region:
 * `loose` only when they share base lines (or insert at the same point),
 * `strict` also when they merely touch.
 */
export type MergePolicy = "loose" | "strict";

function clusters(ours: Hunk[], theirs: Hunk[], policy: MergePolicy): Cluster[] {
  const all: { side: Side; hunk: Hunk }[] = [
    ...ours.map((hunk) => ({ side: "ours" as const, hunk })),
    ...theirs.map((hunk) => ({ side: "theirs" as const, hunk })),
  ].sort((p, q) => p.hunk.aStart - q.hunk.aStart || p.hunk.aEnd - q.hunk.aEnd);
  const out: Cluster[] = [];
  for (const { side, hunk } of all) {
    const last = out[out.length - 1];
    const joins =
      last &&
      (policy === "strict"
        ? hunk.aStart <= last.hi
        : hunk.aStart < last.hi || (hunk.aStart === last.hi && last.lo === last.hi && hunk.aEnd === hunk.aStart));
    if (joins) {
      last.hi = Math.max(last.hi, hunk.aEnd);
      last[side].push(hunk);
    } else {
      out.push({ lo: hunk.aStart, hi: hunk.aEnd, ours: side === "ours" ? [hunk] : [], theirs: side === "theirs" ? [hunk] : [] });
    }
  }
  return out;
}

const delta = (h: Hunk) => h.bEnd - h.bStart - (h.aEnd - h.aStart);

/** Result of {@link merge3}. */
export interface Merge3Result {
  lines: string[];
  /** Some region of the edit meets (touches or overlaps) a region only the original formatted differently. */
  ambiguous: boolean;
}

/**
 * Three-way line merge: `base` → `ours` (the original file) and
 * `base` → `theirs` (the edited serialization). Regions only one side
 * changed take that side; regions both changed take `theirs`.
 */
export function merge3(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
  policy: MergePolicy,
  oursHunks: Hunk[] = diffLines(base, ours),
  theirsHunks: Hunk[] = diffLines(base, theirs),
  refine = true
): Merge3Result {
  const regions = clusters(oursHunks, theirsHunks, policy);
  const lines: string[] = [];
  let ambiguous = false;
  let pos = 0;
  let oursShift = 0;
  let theirsShift = 0;
  let previous: Cluster | null = null;
  for (const region of regions) {
    for (let i = pos; i < region.lo; i++) lines.push(base[i]);
    const oursAfter = oursShift + region.ours.reduce((n, h) => n + delta(h), 0);
    const theirsAfter = theirsShift + region.theirs.reduce((n, h) => n + delta(h), 0);
    if (region.theirs.length > 0) {
      const theirsLines = theirs.slice(region.lo + theirsShift, region.hi + theirsAfter);
      if (region.ours.length > 0) {
        ambiguous = true;
        const refined = refine ? refineLines(base, ours, theirsLines, region, oursShift) : null;
        lines.push(...(refined ?? theirsLines));
      } else {
        lines.push(...theirsLines);
      }
    } else {
      lines.push(...ours.slice(region.lo + oursShift, region.hi + oursAfter));
    }
    if (previous && previous.hi === region.lo && (previous.theirs.length > 0) !== (region.theirs.length > 0)) ambiguous = true;
    oursShift = oursAfter;
    theirsShift = theirsAfter;
    pos = region.hi;
    previous = region;
  }
  for (let i = pos; i < base.length; i++) lines.push(base[i]);
  return { lines, ambiguous };
}

/**
 * Both sides changed the same lines, but line for line (no lines added or
 * removed): merge each line character by character, so an edit keeps the
 * line's own formatting elsewhere (`[X]`, trailing blanks, escapes). `null`
 * when the region is not line-for-line or a line conflicts.
 */
function refineLines(base: readonly string[], ours: readonly string[], theirsLines: string[], region: Cluster, oursShift: number): string[] | null {
  const oneToOne = (h: Hunk) => h.aEnd - h.aStart === h.bEnd - h.bStart;
  if (!region.ours.every(oneToOne) || !region.theirs.every(oneToOne)) return null;
  if (theirsLines.length !== region.hi - region.lo) return null;
  const out: string[] = [];
  for (let i = 0; i < theirsLines.length; i++) {
    const b = base[region.lo + i];
    const o = ours[region.lo + oursShift + i];
    const t = theirsLines[i];
    if (o === b) out.push(t);
    else if (t === b) out.push(o);
    else {
      const merged = mergeChars(b, o, t);
      if (merged === null) return null;
      out.push(merged);
    }
  }
  return out;
}

/** Character-level three-way merge of one line; `null` when both sides changed the same spot. */
export function mergeChars(base: string, ours: string, theirs: string): string | null {
  const b = [...base];
  const o = [...ours];
  const t = [...theirs];
  const result = merge3(b, o, t, "strict", diffLines(b, o), diffLines(b, t), false);
  return result.ambiguous ? null : result.lines.join("");
}

/** What the editor remembers about the note it opened. */
export interface SourceBase {
  /** The body exactly as read. */
  source: string;
  /** The serializer's output for the unedited document. */
  canonical: string;
}

interface Prepared {
  eol: "\n" | "\r\n";
  trailing: string;
  sourceLines: string[];
  canonicalLines: string[];
  oursHunks: Hunk[];
}

const prepared = new WeakMap<SourceBase, Prepared>();

function prepare(base: SourceBase): Prepared {
  let entry = prepared.get(base);
  if (!entry) {
    const eol = base.source.includes("\r\n") ? "\r\n" : "\n";
    const source = eol === "\r\n" ? base.source.replace(/\r\n/g, "\n") : base.source;
    const trailing = /\n*$/.exec(source)![0];
    const sourceLines = splitLines(source.slice(0, source.length - trailing.length));
    const canonicalLines = splitLines(base.canonical.replace(/\n+$/, ""));
    entry = { eol, trailing, sourceLines, canonicalLines, oursHunks: diffLines(canonicalLines, sourceLines, looseLineKey) };
    prepared.set(base, entry);
  }
  return entry;
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/**
 * The body to save for the edited serialization `next`: `source` with the
 * edit applied (see the module comment). `verify(candidate)` must say
 * whether a merged candidate reads back as the edited document; it is only
 * called for merges where the edit meets a differently formatted region.
 */
export function mergeSource(base: SourceBase, next: string, verify: (candidate: string) => boolean = () => true): string {
  if (next === base.canonical) return base.source;
  if (base.source === base.canonical) return next;
  const p = prepare(base);
  const nextLines = splitLines(next.replace(/\n+$/, ""));
  const theirsHunks = diffLines(p.canonicalLines, nextLines);
  const finish = (lines: string[]) => {
    const text = lines.join("\n") + (lines.length > 0 || p.trailing ? p.trailing : "");
    return p.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
  };
  const loose = merge3(p.canonicalLines, p.sourceLines, nextLines, "loose", p.oursHunks, theirsHunks);
  if (!loose.ambiguous) return finish(loose.lines);
  const looseText = finish(loose.lines);
  if (verify(looseText)) return looseText;
  const strict = finish(merge3(p.canonicalLines, p.sourceLines, nextLines, "strict", p.oursHunks, theirsHunks).lines);
  if (strict !== looseText && verify(strict)) return strict;
  return next;
}
