/**
 * The note editor's Markdown extension: tiptap-markdown with Obsidian
 * syntax on the way in (`obsidianSyntax.ts`) and a serializer that writes
 * text the way it was typed.
 *
 * tiptap-markdown's serializer escapes every `[`, `]`, `_`, `~`, `*` and
 * `>` it meets (prosemirror-markdown's `esc` plus an HTML escape). For an
 * Obsidian vault that is destructive: `[[AETHER-OS]]` in a text node was
 * saved as `\[\[AETHER-OS\]\]`, `[^1]` as `\[^1\]`, `> [!note]` as
 * `> \[!note\]` and `a -> b` as `a -&gt; b`. {@link escapeMarkdownText}
 * escapes only what CommonMark would otherwise read as syntax. Obsidian
 * syntax (`[[…]]`, `#tags`, `==…==`, `%%…%%`, `$…$`, `[^1]`) is left alone:
 * it means in the file what it means in Obsidian.
 *
 * The node overrides also fix what tiptap-markdown loses on the way out:
 * single line breaks (written as `\n`, not `\` + newline), bullet markers
 * and ordered-list delimiters, one Markdown list that ProseMirror split
 * into a bullet list and a task list (no blank line between them, which
 * would make the list "loose"), code fences around code that contains
 * backticks, `|` inside table cells, and link targets kept as written
 * (`Brötchen.png`, `<my file.md>`) instead of percent-encoded.
 */
import { Extension } from "@tiptap/core";
import type { Mark as PmMark, Node as PmNode } from "@tiptap/pm/model";
import { Markdown } from "tiptap-markdown";
import { installObsidianSyntax } from "./obsidianSyntax";

// ── Escaping ─────────────────────────────────────────────────────

/** Where a piece of text is written. */
export interface EscapeContext {
  /** The text starts a line (start of a block, or right after a line break). */
  startOfLine?: boolean;
  /** The text is inside a table cell (`|` must be escaped). */
  inTable?: boolean;
  /** The character written right before the text (`""` at the start). */
  before?: string;
  /**
   * The text starts a numbered item (where `[ ] ` is Obsidian's numbered
   * task marker) or follows a task checkbox: a leading `[ ] ` stays as written.
   */
  keepTaskMarker?: boolean;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const SPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;
const ENTITY = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;
/** `(dest)` / `(dest "title")` right after `]` — what would make `[text](dest)` a link. */
const LINK_DESTINATION = /^\(\s*(?:<[^<>\n]*>|[^\s()<>]*(?:\([^\s()<>]*\)[^\s()<>]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/;

/** `[[inner]]` that the parser would read as a wikilink. */
const WIKILINK_AHEAD = /^\[\[(?=[^[\]\n]*\S)[^[\]\n]+\]\]/;

const isSpace = (c: string) => c !== "" && SPACE.test(c);

function escapeLine(line: string, startOfLine: boolean, before: string, inTable: boolean, continuation: boolean, keepTaskMarker: boolean): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const p = i === 0 ? before : line[i - 1];
    const n = i + 1 < line.length ? line[i + 1] : "";
    switch (c) {
      case "\\":
        out += n === "" || ASCII_PUNCTUATION.test(n) ? "\\\\" : c;
        break;
      case "`":
        out += "\\`";
        break;
      case "*":
        out += isSpace(p) && isSpace(n) ? c : "\\*";
        break;
      case "_":
        out += (WORD.test(p) && WORD.test(n)) || (isSpace(p) && isSpace(n)) ? c : "\\_";
        break;
      case "~":
        out += p === "~" || n === "~" || n === "" ? "\\~" : c;
        break;
      case "[":
        // A literal `[[note]]` must not turn into a wikilink when the note is read again.
        out += n === "[" && WIKILINK_AHEAD.test(line.slice(i)) ? "\\[" : c;
        break;
      case "]":
        out += n === "(" && LINK_DESTINATION.test(line.slice(i + 1)) ? "\\]" : c;
        break;
      case "<":
        out += /[A-Za-z/!?]/.test(n) ? "\\<" : c;
        break;
      case "&":
        out += ENTITY.test(line.slice(i)) ? "\\&" : c;
        break;
      case "|":
        out += inTable ? "\\|" : c;
        break;
      default:
        out += c;
    }
  }
  return startOfLine ? escapeLineStart(line, out, continuation, keepTaskMarker) : out;
}

/** Escape what would start a block: headings, list markers, quotes, rules, task markers. */
function escapeLineStart(original: string, escaped: string, continuation: boolean, keepTaskMarker: boolean): string {
  const lead = /^[ \t]*/.exec(original)![0];
  const rest = original.slice(lead.length);
  const out = escaped.slice(lead.length);
  const mark = (index: number) => `${lead}${out.slice(0, index)}\\${out.slice(index)}`;
  if (out.startsWith("\\")) return escaped;
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return mark(0);
  if (/^[-+*>](?:[ \t]|$)/.test(rest) || rest.startsWith(">")) return mark(0);
  const ordered = /^(\d{1,9})[.)](?:[ \t]|$)/.exec(rest);
  if (ordered) return mark(ordered[1].length);
  if (/^([-_*])[ \t]*(?:\1[ \t]*){2,}$/.test(rest)) return mark(0);
  if (continuation && /^(?:=+|-+)[ \t]*$/.test(rest)) return mark(0);
  // `[ ] text` at the start of a bullet item would become a task; `[x]: …` a link definition.
  if ((!keepTaskMarker && /^\[[ xX]\] +\S/.test(rest)) || /^\[[^\]^\n][^\]\n]*\]:/.test(rest)) return mark(0);
  return escaped;
}

/**
 * Escape `text` for a Markdown text position. Only characters CommonMark
 * would read as syntax are escaped (see the module comment).
 */
export function escapeMarkdownText(text: string, context: EscapeContext = {}): string {
  return text
    .split("\n")
    .map((line, i) =>
      escapeLine(line, i === 0 ? !!context.startOfLine : true, i === 0 ? (context.before ?? "") : "\n", !!context.inTable, i > 0, i === 0 && !!context.keepTaskMarker)
    )
    .join("\n");
}

// ── Serializer overrides ─────────────────────────────────────────

/** The parts of prosemirror-markdown's serializer state the overrides use. */
export interface SerializerState {
  out: string;
  delim: string;
  closed: PmNode | null;
  inTable?: boolean;
  inAutolink?: boolean;
  atBlockStart: boolean;
  write(content?: string): void;
  text(text: string, escape?: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: PmNode): void;
  flushClose(size?: number): void;
  repeat(str: string, n: number): string;
  renderList(node: PmNode, delim: string, firstDelim: (index: number) => string): void;
}

type NodeSerializer = (state: SerializerState, node: PmNode, parent: PmNode, index: number) => void;

/** Escape context for text about to be written by `state`. */
export function textContext(state: SerializerState): EscapeContext {
  return {
    startOfLine: state.atBlockStart || state.out === "" || state.out.endsWith("\n"),
    inTable: !!state.inTable,
    before: state.out.slice(-1),
    keepTaskMarker: /(^|\n)[ \t>]*(?:\d{1,9}[.)]|[-*+] \[[ xX]\]) $/.test(state.out),
  };
}

const LISTS = new Set(["bulletList", "taskList", "orderedList"]);

function previousSibling(parent: PmNode | undefined, index: number): PmNode | null {
  return parent && index > 0 && index <= parent.childCount ? parent.child(index - 1) : null;
}

const bulletMarker = (node: PmNode): string => {
  const bullet = node.attrs.bullet;
  return bullet === "*" || bullet === "+" ? bullet : "-";
};

const orderedDelimiter = (node: PmNode): string => (node.attrs.delimiter === ")" ? ")" : ".");

/** The list written right before `node` (nothing in between), if any. */
function adjacentList(state: SerializerState, parent: PmNode | undefined, index: number): PmNode | null {
  const prev = previousSibling(parent, index);
  return prev && state.closed === prev && LISTS.has(prev.type.name) ? prev : null;
}

/**
 * Two lists in a row need no blank line between them when both are tight:
 * one Markdown list ProseMirror split into a bullet and a task list stays
 * one list, and lists with different markers stay apart on their own. A
 * loose list keeps its blank line.
 */
function joinTightLists(state: SerializerState, prev: PmNode | null, node: PmNode): void {
  if (!prev || prev.attrs.tight === false || node.attrs.tight === false) return;
  if (!node.firstChild?.textContent.trim()) return; // an empty first item cannot follow directly
  state.flushClose(1);
}

const bulletList: NodeSerializer = (state, node, parent, index) => {
  const prev = adjacentList(state, parent, index);
  let marker = bulletMarker(node);
  // Two separate lists of the same kind need different markers to stay apart.
  if (prev && prev.type === node.type && bulletMarker(prev) === marker) marker = marker === "-" ? "*" : "-";
  joinTightLists(state, prev, node);
  state.renderList(node, "  ", () => `${marker} `);
};

const orderedList: NodeSerializer = (state, node, parent, index) => {
  const start = typeof node.attrs.start === "number" ? node.attrs.start : 1;
  const prev = adjacentList(state, parent, index);
  let delim = orderedDelimiter(node);
  if (prev && prev.type === node.type && orderedDelimiter(prev) === delim) delim = delim === "." ? ")" : ".";
  joinTightLists(state, prev, node);
  const width = String(start + node.childCount - 1).length;
  state.renderList(node, state.repeat(" ", width + 2), (i) => `${start + i}${delim} `);
};

const text: NodeSerializer = (state, node) => {
  const value = node.text ?? "";
  if (state.inAutolink) {
    state.text(value, false);
    return;
  }
  state.text(escapeMarkdownText(value, textContext(state)), false);
};

const hardBreak: NodeSerializer = (state, node, parent, index) => {
  for (let i = index + 1; i < parent.childCount; i++) {
    if (parent.child(i).type !== node.type) {
      state.write(state.inTable ? "<br>" : node.attrs.soft ? "\n" : "\\\n");
      return;
    }
  }
};

const codeBlock: NodeSerializer = (state, node) => {
  const code = node.textContent;
  const runs = code.match(/`{3,}/g);
  const fence = runs ? "`".repeat(Math.max(...runs.map((r) => r.length)) + 1) : "```";
  state.write(`${fence}${node.attrs.language ?? ""}\n`);
  state.text(code, false);
  state.ensureNewLine();
  state.write(fence);
  state.closeBlock(node);
};

const NODE_OVERRIDES: Record<string, NodeSerializer> = {
  text,
  hardBreak,
  codeBlock,
  bulletList,
  taskList: bulletList,
  orderedList,
};

interface MarkSpec {
  open: string | ((state: SerializerState, mark: PmMark, parent: PmNode, index: number) => string);
  close: string | ((state: SerializerState, mark: PmMark, parent: PmNode, index: number) => string);
  [key: string]: unknown;
}

interface TiptapMarkdownSerializer {
  nodes: Record<string, NodeSerializer>;
  marks: Record<string, MarkSpec>;
}

/** Link targets are kept as written, so one with spaces is written back in `<…>`. */
function linkMark(base: MarkSpec | undefined): MarkSpec | undefined {
  if (!base || typeof base.close !== "function") return base;
  const close = base.close;
  return {
    ...base,
    close: (state, mark, parent, index) => {
      if (state.inAutolink) return close(state, mark, parent, index);
      const href = String(mark.attrs.href ?? "");
      const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/["\\]/g, "\\$&")}"` : "";
      state.inAutolink = undefined;
      return `](${formatDestination(href)}${title})`;
    },
  };
}

function getterOf(serializer: object, name: string): (() => Record<string, unknown>) | undefined {
  let proto: object | null = Object.getPrototypeOf(serializer);
  while (proto) {
    const getter = Object.getOwnPropertyDescriptor(proto, name)?.get;
    if (getter) return getter as () => Record<string, unknown>;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

function patchSerializer(serializer: TiptapMarkdownSerializer): void {
  const nodes = getterOf(serializer, "nodes");
  if (nodes) {
    Object.defineProperty(serializer, "nodes", {
      configurable: true,
      get: () => ({ ...nodes.call(serializer), ...NODE_OVERRIDES }),
    });
  }
  const marks = getterOf(serializer, "marks");
  if (marks) {
    Object.defineProperty(serializer, "marks", {
      configurable: true,
      get: () => {
        const all = marks.call(serializer) as Record<string, MarkSpec>;
        return { ...all, link: linkMark(all.link) };
      },
    });
  }
}

/** Link destination as CommonMark reads it back: `<…>` around spaces, escapes for unbalanced parentheses. */
export function formatDestination(src: string): string {
  if (src === "" || /[\s<>]/.test(src)) return `<${src.replace(/[<>\\]/g, "\\$&")}>`;
  let depth = 0;
  let balanced = true;
  for (const c of src) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) balanced = false;
  }
  return balanced && depth === 0 ? src : src.replace(/[()]/g, "\\$&");
}

interface MarkdownStorageShape {
  parser: {
    md: Parameters<typeof installObsidianSyntax>[0];
    parse: (content: string) => string;
    normalizeDOM: (node: HTMLElement, options: unknown) => HTMLElement;
  };
  serializer: TiptapMarkdownSerializer;
}

/**
 * One Markdown list can mix plain items and `[ ]` items; the editor has a
 * bullet list and a task list. Handed a task list that starts with plain
 * items, ProseMirror invents an empty task to fill it (saved as a stray
 * `- [ ] ` line). Split such lists into runs of one kind first; the
 * serializer writes adjacent runs back as one list.
 */
export function splitMixedTaskLists(root: HTMLElement): void {
  const lists = [...root.querySelectorAll<HTMLElement>('ul[data-type="taskList"]')].reverse();
  for (const list of lists) {
    const items = [...list.children].filter((c): c is HTMLElement => c.tagName === "LI");
    const isTask = (li: HTMLElement) => li.getAttribute("data-type") === "taskItem";
    if (items.every(isTask)) continue;
    const runs: { task: boolean; items: HTMLElement[] }[] = [];
    for (const li of items) {
      const task = isTask(li);
      const last = runs[runs.length - 1];
      if (last && last.task === task) last.items.push(li);
      else runs.push({ task, items: [li] });
    }
    for (const run of runs) {
      const part = list.cloneNode(false) as HTMLElement;
      if (!run.task) {
        part.removeAttribute("data-type");
        part.classList.remove("contains-task-list");
        if (!part.getAttribute("class")) part.removeAttribute("class");
      }
      part.append(...run.items);
      list.before(part);
    }
    list.remove();
  }
}

/** tiptap-markdown with the Obsidian parser rules and the faithful serializer. */
export const FaithfulMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event);
    const storage = (this.editor.storage as unknown as { markdown?: MarkdownStorageShape }).markdown;
    if (!storage) return;
    const md = storage.parser.md;
    installObsidianSyntax(md);
    // Keep link targets as written (`Brötchen.png`, `my file.md`); validation still applies.
    md.normalizeLink = (url: string) => url;
    patchSerializer(storage.serializer);
    const parser = storage.parser;
    const normalizeDOM = parser.normalizeDOM.bind(parser);
    parser.normalizeDOM = (node, parseOptions) => {
      splitMixedTaskLists(node);
      return normalizeDOM(node, parseOptions);
    };
    // The parent parsed the initial content before the rules existed.
    const options = this.editor.options as { content: unknown; initialContent?: unknown };
    if (typeof options.initialContent === "string" && options.initialContent) {
      options.content = storage.parser.parse(options.initialContent);
    }
  },
});

/**
 * Attributes the faithful serializer needs on StarterKit's nodes: soft line
 * breaks, bullet markers and ordered-list delimiters as they were written.
 */
export const MarkdownSourceAttributes = Extension.create({
  name: "markdownSourceAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["hardBreak"],
        attributes: {
          soft: {
            default: false,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => element.getAttribute("data-md-soft") === "true",
            renderHTML: (attributes: Record<string, unknown>) => (attributes.soft ? { "data-md-soft": "true" } : {}),
          },
        },
      },
      {
        types: ["bulletList", "taskList"],
        attributes: {
          bullet: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute("data-md-bullet"),
            renderHTML: (attributes: Record<string, unknown>) => (attributes.bullet ? { "data-md-bullet": String(attributes.bullet) } : {}),
          },
        },
      },
      {
        types: ["orderedList"],
        attributes: {
          delimiter: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute("data-md-delim"),
            renderHTML: (attributes: Record<string, unknown>) => (attributes.delimiter ? { "data-md-delim": String(attributes.delimiter) } : {}),
          },
        },
      },
    ];
  },
});
