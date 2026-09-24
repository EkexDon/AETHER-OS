/**
 * Obsidian syntax for the note editor's Markdown parser (markdown-it, via
 * tiptap-markdown).
 *
 * tiptap-markdown turns Markdown into HTML with markdown-it and parses that
 * HTML into the editor document. Out of the box markdown-it knows nothing
 * about Obsidian, so `[[links]]` arrived as plain text (and were written
 * back escaped as `\[\[links\]\]`), `$\alpha$` lost its backslash, `%%…%%`
 * and `<!-- … -->` comments were dropped and single line breaks became
 * spaces. The rules below hand every one of those constructs to the editor
 * as its own element, carrying the exact source text, so the serializer can
 * write it back byte for byte:
 *
 * | Source | Element | Editor node |
 * | --- | --- | --- |
 * | `[[Note]]`, `[[Note#Heading\|Alias]]` | `span[data-wikilink]` | `wikiLink` |
 * | `![[image.png\|300]]`, `![[Note]]` | `span[data-wikiembed]` | `wikiEmbed` |
 * | `$x^2$`, `$$x$$`, `%%note%%`, `<!-- c -->` (inline) | `span[data-md-raw]` | `rawInline` |
 * | `$$` … `$$`, `%%` … `%%`, `<!-- … -->` (blocks) | `div[data-md-raw-block]` | `rawBlock` |
 * | a single line break | `br[data-md-soft]` | `hardBreak` with `soft` |
 *
 * It also stops footnote definitions (`[^1]: text`) from being swallowed as
 * link reference definitions and records each list's bullet (`-`, `*`, `+`)
 * and number delimiter (`.`, `)`), so lists keep their markers.
 *
 * `#tags`, `==highlights==`, footnote references and callouts
 * (`> [!note]`) need no rule: they are plain text to markdown-it, and the
 * serializer does not escape them.
 */
import type MarkdownIt from "markdown-it";

// ── Pure helpers ─────────────────────────────────────────────────

/** The parts of a `[[wikilink]]` (the text between the brackets). */
export interface WikilinkParts {
  /** Linked note (name or vault path), without `#heading`; `""` for `[[#Heading]]`. */
  target: string;
  /** `#heading` / `#^block` part without the `#`, or `null`. */
  heading: string | null;
  /** Text after `|`, or `null`. */
  alias: string | null;
}

/**
 * Split the inside of `[[…]]`. Inside tables Obsidian writes the alias
 * separator as `\|`; the backslash is not part of the target.
 */
export function parseWikilink(raw: string): WikilinkParts {
  const bar = /\\?\|/.exec(raw);
  const main = bar ? raw.slice(0, bar.index) : raw;
  const alias = bar ? raw.slice(bar.index + bar[0].length).trim() : null;
  const hash = main.indexOf("#");
  const target = (hash === -1 ? main : main.slice(0, hash)).trim();
  const heading = hash === -1 ? null : main.slice(hash + 1).trim() || null;
  return { target, heading, alias: alias || null };
}

/** What a wikilink shows: the alias, else `Note › Heading`, else the note name. */
export function wikilinkLabel(raw: string): string {
  const { target, heading, alias } = parseWikilink(raw);
  if (alias) return alias;
  if (heading) return target ? `${target} › ${heading.replace(/^\^/, "")}` : heading.replace(/^\^/, "");
  return target || raw;
}

/** Whether `inner` may sit between `[[` and `]]` (non-empty, one line, no brackets). */
export function isWikilinkInner(inner: string): boolean {
  return inner.trim().length > 0 && !/[[\]\n\r]/.test(inner);
}

/**
 * End (exclusive) of an inline `$…$` math span starting at `start`, or -1.
 * Pandoc's rule, which Obsidian follows: the opening `$` is followed by a
 * non-space, the closing `$` is preceded by a non-space and not followed by
 * a digit — so "costs $5 and $10" stays text. Single-dollar math stays on
 * one line and never closes on a `$$`. `$$…$$` is display math.
 */
export function mathSpanEnd(src: string, start: number): number {
  if (src[start] !== "$") return -1;
  if (src[start + 1] === "$") {
    const close = src.indexOf("$$", start + 2);
    if (close === -1 || !src.slice(start + 2, close).trim()) return -1;
    return close + 2;
  }
  const first = src[start + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  const lineEnd = src.indexOf("\n", start);
  const limit = lineEnd === -1 ? src.length : lineEnd;
  for (let i = start + 1; i < limit; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] !== "$") continue;
    if (/\s/.test(src[i - 1]) || src[i - 1] === "$" || src[i + 1] === "$" || /\d/.test(src[i + 1] ?? "")) continue;
    return i + 1;
  }
  return -1;
}

/** End (exclusive) of an inline `%%comment%%` starting at `start`, or -1. */
export function commentSpanEnd(src: string, start: number): number {
  if (!src.startsWith("%%", start)) return -1;
  const close = src.indexOf("%%", start + 2);
  return close === -1 ? -1 : close + 2;
}

// ── markdown-it rules ────────────────────────────────────────────

type StateInline = MarkdownIt["inline"]["State"]["prototype"];
type StateBlock = MarkdownIt["block"]["State"]["prototype"];
type Token = ReturnType<StateInline["push"]>;

/** The kinds of raw source the editor keeps verbatim. */
export type RawKind = "math" | "comment" | "html";

function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  let pos = state.pos;
  let embed = false;
  if (src.charCodeAt(pos) === 0x21 /* ! */) {
    embed = true;
    pos++;
  }
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const close = src.indexOf("]]", pos + 2);
  if (close === -1 || close > state.posMax) return false;
  const inner = src.slice(pos + 2, close);
  if (!isWikilinkInner(inner)) return false;
  if (!silent) {
    const token = state.push(embed ? "wikiembed" : "wikilink", "", 0);
    token.content = inner;
  }
  state.pos = close + 2;
  return true;
}

function rawInlineRule(state: StateInline, silent: boolean): boolean {
  const code = state.src.charCodeAt(state.pos);
  let end = -1;
  let kind: RawKind = "math";
  if (code === 0x24 /* $ */) {
    end = mathSpanEnd(state.src, state.pos);
  } else if (code === 0x25 /* % */) {
    end = commentSpanEnd(state.src, state.pos);
    kind = "comment";
  }
  if (end === -1 || end > state.posMax) return false;
  if (!silent) {
    const token = state.push("md_raw_inline", "", 0);
    token.content = state.src.slice(state.pos, end);
    token.info = kind;
  }
  state.pos = end;
  return true;
}

/**
 * `$$` / `%%` blocks: the opening line starts with the delimiter and does
 * not close it; the block runs to the first later line containing the
 * delimiter (a comment block may span blank lines, math may not).
 * Unclosed delimiters stay text.
 */
function rawBlockRule(delim: "$$" | "%%", kind: RawKind) {
  return (state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const first = state.src.slice(start, state.eMarks[startLine]);
    if (!first.startsWith(delim) || first.indexOf(delim, 2) !== -1) return false;
    let line = startLine + 1;
    let found = false;
    for (; line < endLine; line++) {
      const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      if (kind === "math" && !text.trim()) return false;
      if (state.sCount[line] < state.blkIndent && text.trim()) return false;
      if (text.includes(delim)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
    if (silent) return true;
    const token = state.push("md_raw_block", "div", 0);
    token.block = true;
    token.map = [startLine, line + 1];
    token.info = kind;
    token.content = state.getLines(startLine, line + 1, state.blkIndent, false).replace(/\n$/, "");
    state.line = line + 1;
    return true;
  };
}

type CoreToken = Token & { children: Token[] | null };

/**
 * The editor's task lists are bullet lists; a numbered task (`1. [ ] …`,
 * valid in Obsidian) would be torn into an empty numbered item plus a
 * bullet task. Undo markdown-it-task-lists inside ordered lists: the item
 * stays a numbered item whose text starts with its `[ ]` marker.
 */
function restoreOrderedTasks(tokens: CoreToken[], src: string): void {
  const lines = src.split("\n");
  const lists: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") lists.push(token.type);
    else if (token.type === "bullet_list_close" || token.type === "ordered_list_close") lists.pop();
    if (token.type !== "list_item_open" || lists[lists.length - 1] !== "ordered_list_open") continue;
    const inline = tokens[i + 2];
    const checkbox = inline?.type === "inline" ? inline.children?.[0] : undefined;
    if (!inline || !checkbox || checkbox.type !== "html_inline" || !checkbox.content.includes("task-list-item-checkbox")) continue;
    const line = token.map ? lines[token.map[0]] ?? "" : "";
    const marker = /\[[ xX]\]/.exec(line.replace(/^[\s>]*\d{1,9}[.)]/, ""))?.[0] ?? (checkbox.content.includes("checked") ? "[x]" : "[ ]");
    inline.children!.shift();
    const text = inline.children![0];
    if (text?.type === "text") text.content = marker + text.content;
    inline.content = marker + inline.content;
    const cls = (token.attrGet("class") ?? "").replace(/\btask-list-item\b/, "").trim();
    if (cls) token.attrSet("class", cls);
    else token.attrs = (token.attrs ?? []).filter(([name]) => name !== "class");
  }
  // Ordered lists that only had such items are no task lists either.
  for (const token of tokens) {
    if (token.type === "ordered_list_open" && token.attrGet("class")?.includes("contains-task-list")) {
      token.attrs = (token.attrs ?? []).filter(([name]) => name !== "class");
    }
  }
}

function escapeAttr(md: MarkdownIt, value: string): string {
  return md.utils.escapeHtml(value).replace(/\n/g, "&#10;");
}

const installed = new WeakSet<MarkdownIt>();

/** Add the Obsidian rules to a markdown-it instance (idempotent). */
export function installObsidianSyntax(md: MarkdownIt): void {
  if (installed.has(md)) return;
  installed.add(md);

  // tiptap-markdown calls `md.use(taskLists)` on every parse, which adds one
  // more copy of the same core rule each time (a second copy eats a literal
  // "[ ] " after the task marker). Adding a rule whose name exists is a no-op.
  const core = md.core.ruler as unknown as { __rules__?: { name: string }[]; after: (...args: unknown[]) => void };
  const after = core.after.bind(core);
  core.after = (afterName: unknown, ruleName: unknown, ...rest: unknown[]) => {
    if (core.__rules__?.some((rule) => rule.name === ruleName)) return;
    after(afterName, ruleName, ...rest);
  };

  md.inline.ruler.before("link", "wikilink", wikilinkRule);
  md.inline.ruler.before("escape", "md_raw_inline", rawInlineRule);
  const alt = { alt: ["paragraph", "reference", "blockquote", "list"] };
  md.block.ruler.before("fence", "md_math_block", rawBlockRule("$$", "math"), alt);
  md.block.ruler.before("fence", "md_comment_block", rawBlockRule("%%", "comment"), alt);

  // `[^1]: text` is a footnote definition, not a link reference definition.
  const rules = (md.block.ruler as unknown as { __rules__?: { name: string; fn: (...args: unknown[]) => boolean }[] }).__rules__;
  const reference = rules?.find((r) => r.name === "reference")?.fn;
  if (reference) {
    md.block.ruler.at("reference", (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
      const pos = state.bMarks[startLine] + state.tShift[startLine];
      if (state.src.charCodeAt(pos) === 0x5b && state.src.charCodeAt(pos + 1) === 0x5e) return false;
      return reference(state, startLine, endLine, silent);
    });
  }

  // Keep list markers: `data-md-bullet` / `data-md-delim` on the list elements.
  md.core.ruler.push("md_list_markup", (state) => {
    for (const token of state.tokens) {
      if (token.type === "bullet_list_open" && token.markup) token.attrSet("data-md-bullet", token.markup);
      else if (token.type === "ordered_list_open" && token.markup) token.attrSet("data-md-delim", token.markup);
    }
    restoreOrderedTasks(state.tokens, state.src);
  });

  const rendered = md.renderer.rules;
  rendered.wikilink = (tokens: Token[], idx: number) => `<span data-wikilink="${escapeAttr(md, tokens[idx].content)}"></span>`;
  rendered.wikiembed = (tokens: Token[], idx: number) => `<span data-wikiembed="${escapeAttr(md, tokens[idx].content)}"></span>`;
  rendered.md_raw_inline = (tokens: Token[], idx: number) =>
    `<span data-md-raw="${escapeAttr(md, tokens[idx].info)}" data-raw="${escapeAttr(md, tokens[idx].content)}"></span>`;
  rendered.md_raw_block = (tokens: Token[], idx: number) =>
    `<div data-md-raw-block="${escapeAttr(md, tokens[idx].info)}" data-raw="${escapeAttr(md, tokens[idx].content)}"></div>`;
  rendered.softbreak = () => `<br data-md-soft="true">`;

  // HTML comments (the browser DOM would drop them) become raw nodes.
  const htmlBlock = rendered.html_block;
  rendered.html_block = (tokens: Token[], idx: number, options, env, self) => {
    const content = tokens[idx].content;
    if (content.trimStart().startsWith("<!--")) {
      return `<div data-md-raw-block="html" data-raw="${escapeAttr(md, content.replace(/\n$/, ""))}"></div>`;
    }
    return htmlBlock ? htmlBlock(tokens, idx, options, env, self) : content;
  };
  const htmlInline = rendered.html_inline;
  rendered.html_inline = (tokens: Token[], idx: number, options, env, self) => {
    const content = tokens[idx].content;
    if (content.startsWith("<!--")) return `<span data-md-raw="html" data-raw="${escapeAttr(md, content)}"></span>`;
    return htmlInline ? htmlInline(tokens, idx, options, env, self) : content;
  };
}
