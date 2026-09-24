/**
 * Visual hints for Obsidian syntax that stays plain text in the document:
 * `#tags` and `==highlights==` get a style, block quotes that start with
 * `[!type]` render as callouts. These are ProseMirror decorations only —
 * the text, and so the saved Markdown, is never changed.
 */
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** `#tag` / `#nested/tag` (not `#123`, not the `#` in `a#b` or a URL). */
const TAG = /(^|[\s([{,;:"'])#((?:[\p{L}\p{N}_\-/]*[\p{L}_\-/])[\p{L}\p{N}_\-/]*)/gu;
const HIGHLIGHT = /==(?=[^\s=])([^=\n]*[^\s=])?==/g;
const CALLOUT = /^\[!([A-Za-z][\w-]*)\][+-]?/;

/** Ranges (relative to the text) of tags and highlights in one text value. */
export function inlineSyntaxRanges(text: string): { from: number; to: number; kind: "tag" | "highlight" }[] {
  const out: { from: number; to: number; kind: "tag" | "highlight" }[] = [];
  for (const m of text.matchAll(TAG)) {
    const from = (m.index ?? 0) + m[1].length;
    out.push({ from, to: from + 1 + m[2].length, kind: "tag" });
  }
  for (const m of text.matchAll(HIGHLIGHT)) {
    const from = m.index ?? 0;
    out.push({ from, to: from + m[0].length, kind: "highlight" });
  }
  return out;
}

/** The callout type of a block quote whose first line starts with `[!type]`. */
export function calloutType(firstLine: string): string | null {
  return CALLOUT.exec(firstLine)?.[1].toLowerCase() ?? null;
}

function build(doc: PmNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code) return false;
    if (node.type.name === "blockquote") {
      const first = node.firstChild;
      const type = first?.isTextblock ? calloutType(first.textContent) : null;
      if (type && first) {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "is-callout", "data-callout": type }));
        const marker = CALLOUT.exec(first.textContent)![0];
        // The marker is the start of the first text node when it is plain text.
        const text = first.firstChild;
        if (text?.isText && text.text?.startsWith(marker)) {
          const start = pos + 2;
          decorations.push(Decoration.inline(start, start + marker.length, { class: "md-callout-marker" }));
          // The title is the rest of the first line (up to the first line break).
          let lineEnd = pos + first.nodeSize; // end of the first paragraph's content
          let found = false;
          first.forEach((child, offset) => {
            if (!found && child.type.name === "hardBreak") {
              lineEnd = start + offset;
              found = true;
            }
          });
          if (lineEnd > start + marker.length) {
            decorations.push(Decoration.inline(start + marker.length, lineEnd, { class: "md-callout-title" }));
          }
        }
      }
    }
    if (node.isText && node.text && !node.marks.some((m) => m.type.spec.code)) {
      for (const range of inlineSyntaxRanges(node.text)) {
        decorations.push(Decoration.inline(pos + range.from, pos + range.to, { class: range.kind === "tag" ? "md-tag" : "md-highlight" }));
      }
    }
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

const key = new PluginKey<DecorationSet>("obsidianDecorations");

/** The decoration extension. */
export const ObsidianDecorations = Extension.create({
  name: "obsidianDecorations",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
        },
        props: {
          decorations: (state) => key.getState(state),
        },
      }),
    ];
  },
});
