/**
 * Map a Markdown source line to the block that shows it in the TipTap
 * canvas — used to scroll to a task opened from Note Tasks.
 *
 * `tiptap-markdown` renders the body with markdown-it and parses the HTML,
 * so markdown-it's top-level block tokens line up with the document's
 * top-level nodes. {@link lineToBlock} finds that block (plus the list-item
 * path inside it and the line's plain text); {@link locateBlock} resolves it
 * in a ProseMirror document and confirms it by text, which also covers the
 * few cases where ProseMirror splits a block markdown-it keeps together
 * (e.g. a list mixing task and plain items).
 */
import MarkdownIt from "markdown-it";
import type { Node as PMNode } from "@tiptap/pm/model";

/** Where a Markdown line lives in the block structure. */
export interface BlockTarget {
  /** Index of the top-level block (child of the document) containing the line. */
  index: number;
  /** For lines inside lists: the list-item index at each nesting level, outermost first. */
  itemPath: number[];
  /** The line's inline text without quote, list, task or heading markers. */
  text: string;
}

/** A resolved block: its document position and node. */
export interface LocatedBlock {
  pos: number;
  node: PMNode;
}

let parser: MarkdownIt | null = null;

/** Same block rules as the editor's Markdown extension (`html: true`). */
function markdown(): MarkdownIt {
  parser ??= new MarkdownIt({ html: true });
  return parser;
}

/** Strip block markers (`> `, `- [ ] `, `1. `, `## `) from a source line. */
export function lineText(line: string): string {
  let t = line.replace(/^\s*(?:>\s?)+/, "");
  t = t.replace(/^\s*(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/, "");
  t = t.replace(/^\[[^\]]\](?:\s+|$)/, "");
  t = t.replace(/^\s*#{1,6}(?:\s+|$)/, "");
  return t.trim();
}

/** Loose text key for comparing source text with rendered text. */
export function textKey(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`#>[\]()!|\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The block containing the 0-based `line` of `markdown` (the body the
 * editor shows, without front matter). A blank line between blocks maps to
 * the next block (or the last one at the end). `null` when there are no
 * blocks or the line is out of range.
 */
export function lineToBlock(body: string, line: number): BlockTarget | null {
  if (!Number.isInteger(line) || line < 0) return null;
  const lines = body.split(/\r\n|\n|\r/);
  if (line >= lines.length) return null;
  const tokens = markdown().parse(body, {});

  // Top-level blocks: [token index of the opener, closer index].
  const blocks: { open: number; close: number; start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.level !== 0 || t.nesting === -1 || !t.block || !t.map) continue;
    let close = i;
    if (t.nesting === 1) {
      let depth = 0;
      for (let j = i; j < tokens.length; j++) {
        depth += tokens[j].nesting;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    blocks.push({ open: i, close, start: t.map[0], end: t.map[1] });
    i = close;
  }
  if (blocks.length === 0) return null;

  let index = blocks.findIndex((b) => line >= b.start && line < b.end);
  if (index === -1) {
    index = blocks.findIndex((b) => b.start > line);
    if (index === -1) index = blocks.length - 1;
  }
  const block = blocks[index];

  // List items containing the line, outermost first.
  const itemPath: number[] = [];
  const counters: number[] = [];
  for (let i = block.open; i <= block.close; i++) {
    const t = tokens[i];
    if (t.type === "bullet_list_open" || t.type === "ordered_list_open") counters.push(-1);
    else if (t.type === "bullet_list_close" || t.type === "ordered_list_close") counters.pop();
    else if (t.type === "list_item_open" && counters.length > 0) {
      counters[counters.length - 1] += 1;
      if (t.map && line >= t.map[0] && line < t.map[1] && counters.length === itemPath.length + 1) {
        itemPath.push(counters[counters.length - 1]);
      }
    }
  }

  const inBlock = line >= block.start && line < block.end;
  return { index, itemPath, text: inBlock ? lineText(lines[line]) : "" };
}

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
const ITEM_TYPES = new Set(["listItem", "taskItem"]);

/** Text of a node itself — for list items only their first paragraph. */
function ownText(node: PMNode): string {
  if (ITEM_TYPES.has(node.type.name)) return node.firstChild?.textContent ?? "";
  return node.textContent;
}

function matches(node: PMNode, key: string): boolean {
  if (!key) return false;
  const own = textKey(ownText(node));
  return own === key || own.startsWith(key) || (key.length >= 8 && own.includes(key.slice(0, 48)));
}

/** Follow `itemPath` into nested lists below the top-level node at `pos`. */
function descend(node: PMNode, pos: number, itemPath: number[]): LocatedBlock {
  let current: LocatedBlock = { pos, node };
  let list: LocatedBlock | null = LIST_TYPES.has(node.type.name) ? current : null;
  for (const itemIndex of itemPath) {
    if (!list || itemIndex >= list.node.childCount) break;
    let childPos = list.pos + 1;
    for (let i = 0; i < itemIndex; i++) childPos += list.node.child(i).nodeSize;
    current = { pos: childPos, node: list.node.child(itemIndex) };
    // The nested list of this item (if the path continues).
    list = null;
    let innerPos = current.pos + 1;
    for (let i = 0; i < current.node.childCount; i++) {
      const child = current.node.child(i);
      if (LIST_TYPES.has(child.type.name)) {
        list = { pos: innerPos, node: child };
        break;
      }
      innerPos += child.nodeSize;
    }
  }
  return current;
}

/** First node inside `top` (or `top` itself) whose own text matches `key`. */
function firstMatch(top: LocatedBlock, key: string): LocatedBlock | null {
  if (!LIST_TYPES.has(top.node.type.name) && matches(top.node, key)) return top;
  let found: LocatedBlock | null = null;
  top.node.descendants((child, offset) => {
    if (found) return false;
    if ((ITEM_TYPES.has(child.type.name) || child.isTextblock) && matches(child, key)) {
      found = { pos: top.pos + 1 + offset, node: child };
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Resolve a {@link BlockTarget} in the editor document: the structural
 * guess when its text matches, otherwise the nearest block whose own text
 * matches, otherwise the structural guess. ProseMirror splits some blocks
 * markdown-it keeps together (so the real block tends to sit *after* the
 * guessed index) and drops a few others (HTML comments), so blocks after
 * the guess are preferred over equally distant ones before it.
 */
export function locateBlock(doc: PMNode, target: BlockTarget): LocatedBlock | null {
  if (doc.childCount === 0) return null;
  const index = Math.min(Math.max(target.index, 0), doc.childCount - 1);
  const tops: LocatedBlock[] = [];
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    tops.push({ pos, node: doc.child(i) });
    pos += doc.child(i).nodeSize;
  }
  const structural = descend(tops[index].node, tops[index].pos, target.itemPath);
  const key = textKey(target.text);
  if (!key || matches(structural.node, key)) return structural;

  let best: LocatedBlock | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < tops.length; i++) {
    const score = i >= index ? i - index : (index - i) * 3;
    if (score >= bestScore) continue;
    const hit = firstMatch(tops[i], key);
    if (hit) {
      best = hit;
      bestScore = score;
    }
  }
  return best ?? structural;
}
