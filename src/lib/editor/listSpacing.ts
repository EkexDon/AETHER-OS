/**
 * Keep a note's list spacing when the editor re-serialises it.
 *
 * tiptap-markdown (prosemirror-markdown) always writes a blank line
 * between blocks, so a note written Obsidian-style —
 *
 * ```md
 * ## Tasks
 * - [ ] one
 * ```
 *
 * — gains a blank line after the heading on the first edit, which shows up
 * as noise in note history. Both forms parse to the same document
 * (CommonMark lets a bullet list interrupt a paragraph), so the editor
 * remembers which style the file used when it was opened
 * ({@link prefersTightLists}) and, for tight files, removes that blank
 * line again after serialising ({@link tightenListSpacing}).
 *
 * Only top-level transitions are touched: never inside code fences, block
 * quotes, tables, HTML or indented content, and never before an ordered
 * list that does not start at 1 after a paragraph (CommonMark would read
 * it as paragraph text).
 */

const FENCE = /^(?:```|~~~)/;
const BULLET = /^[-*+] (?:\[[ xX]\] )?\S/;
const ORDERED = /^(\d{1,9})[.)] \S/;

function isListLine(line: string): boolean {
  return BULLET.test(line) || ORDERED.test(line);
}

/** A top-level line that ends a block a list may directly follow. */
function isBlockLine(line: string): boolean {
  if (!line.trim() || /^\s/.test(line)) return false;
  if (isListLine(line)) return false;
  // Quotes, tables, HTML, thematic breaks, setext underlines and fences need their blank line.
  if (/^(?:>|\||<|---+\s*$|\*\*\*+\s*$|___+\s*$|===+\s*$|```|~~~)/.test(line)) return false;
  return true;
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

/** May a list starting with `listLine` follow `prev` without a blank line? */
function canJoin(prev: string, listLine: string): boolean {
  if (!isBlockLine(prev)) return false;
  const ordered = ORDERED.exec(listLine);
  if (ordered && Number(ordered[1]) !== 1 && !isHeading(prev)) return false;
  return true;
}

/** Lines of `markdown` with a flag for "inside a fenced code block". */
function scan(markdown: string): { line: string; fenced: boolean }[] {
  let inFence = false;
  return markdown.split("\n").map((line) => {
    const fence = FENCE.test(line.trimStart()) && !/^\s{4}/.test(line);
    const fenced = inFence || fence;
    if (fence) inFence = !inFence;
    return { line, fenced };
  });
}

/**
 * Does the note put lists directly under headings / paragraphs (no blank
 * line) at least as often as it separates them?
 */
export function prefersTightLists(markdown: string): boolean {
  const lines = scan(markdown);
  let tight = 0;
  let loose = 0;
  for (let i = 1; i < lines.length; i++) {
    const cur = lines[i];
    if (cur.fenced || !isListLine(cur.line)) continue;
    const prev = lines[i - 1];
    if (!prev.fenced && canJoin(prev.line, cur.line)) {
      tight += 1;
    } else if (i >= 2 && !prev.line.trim() && !lines[i - 2].fenced && canJoin(lines[i - 2].line, cur.line)) {
      loose += 1;
    }
  }
  return tight > 0 && tight >= loose;
}

/** Remove the blank line between a heading / paragraph and a list that directly follows it. */
export function tightenListSpacing(markdown: string): string {
  const lines = scan(markdown);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { line, fenced } = lines[i];
    const next = lines[i + 1];
    const prev = out[out.length - 1];
    if (
      !fenced &&
      !line.trim() &&
      next &&
      !next.fenced &&
      isListLine(next.line) &&
      prev !== undefined &&
      !lines[i - 1].fenced &&
      canJoin(prev, next.line)
    ) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
