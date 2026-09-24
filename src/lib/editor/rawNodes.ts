/**
 * Source the editor shows but never rewrites: math (`$…$`, `$$…$$`),
 * Obsidian comments (`%%…%%`) and HTML comments (`<!-- … -->`).
 *
 * markdown-it would otherwise mangle them — `$a_1*b_2$` turns into
 * emphasis, `$\{x\}$` loses its backslashes, comments vanish from the
 * document — so `obsidianSyntax.ts` hands them over verbatim and these
 * atoms keep the exact bytes in `raw`. Inline ones show as a monospace
 * chip, block ones as a labelled source box; double-click turns either
 * back into editable text (it becomes a chip again the next time the note
 * is opened).
 */
import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as PmNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { RawKind } from "./obsidianSyntax";
import type { SerializerState } from "./markdownSerializer";

const KIND_LABEL: Record<RawKind, string> = { math: "Math", comment: "Comment", html: "HTML comment" };

function kindOf(value: unknown): RawKind {
  return value === "comment" || value === "html" ? value : "math";
}

const rawAttributes = (kindAttr: string) => ({
  kind: {
    default: "math",
    parseHTML: (element: HTMLElement) => kindOf(element.getAttribute(kindAttr)),
    renderHTML: (attributes: Record<string, unknown>) => ({ [kindAttr]: kindOf(attributes.kind) }),
  },
  raw: {
    default: "",
    parseHTML: (element: HTMLElement) => element.getAttribute("data-raw") ?? "",
    renderHTML: (attributes: Record<string, unknown>) => ({ "data-raw": String(attributes.raw ?? "") }),
  },
});

/** Inline math, `%%comments%%` and `<!-- comments -->`. */
export const RawInline = Node.create({
  name: "rawInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return rawAttributes("data-md-raw");
  },

  parseHTML() {
    return [{ tag: "span[data-md-raw]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = kindOf(node.attrs.kind);
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: `md-raw md-raw-${kind}`, title: `${KIND_LABEL[kind]} — double-click to edit`, contenteditable: "false" }),
      String(node.attrs.raw),
    ];
  },

  renderText({ node }) {
    return String(node.attrs.raw);
  },

  extendNodeSchema(extension) {
    return extension.name === "rawInline" ? { leafText: (node: PmNode) => String(node.attrs.raw) } : {};
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PmNode) {
          state.text(String(node.attrs.raw), false);
        },
        parse: {},
      },
    };
  },
});

/** `$$` math blocks, multi-line `%%` comments and HTML comment blocks. */
export const RawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return rawAttributes("data-md-raw-block");
  },

  parseHTML() {
    return [{ tag: "div[data-md-raw-block]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = kindOf(node.attrs.kind);
    return [
      "div",
      mergeAttributes(HTMLAttributes, { class: `md-raw-block md-raw-block-${kind}`, title: "Double-click to edit", contenteditable: "false" }),
      ["span", { class: "md-raw-block-label" }, KIND_LABEL[kind]],
      ["pre", { class: "md-raw-block-source" }, String(node.attrs.raw)],
    ];
  },

  renderText({ node }) {
    return String(node.attrs.raw);
  },

  extendNodeSchema(extension) {
    return extension.name === "rawBlock" ? { leafText: (node: PmNode) => String(node.attrs.raw) } : {};
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PmNode) {
          state.text(String(node.attrs.raw), false);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },

  addProseMirrorPlugins() {
    return [editRawPlugin()];
  },
});

/** Inline content for source text: text with soft line breaks. */
export function sourceInline(schema: Schema, text: string): PmNode[] {
  const out: PmNode[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0 && schema.nodes.hardBreak) out.push(schema.nodes.hardBreak.create({ soft: true }));
    if (line) out.push(schema.text(line));
  });
  return out;
}

/** Double-click on a raw atom (inline or block) → its source as editable text. */
function editRawPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("editRawSource"),
    props: {
      handleDoubleClickOn(view, _pos, node, nodePos, _event, direct) {
        if (!direct || !view.editable) return false;
        const { schema } = view.state;
        const raw = String(node.attrs.raw ?? "");
        let tr = view.state.tr;
        if (node.type.name === "rawInline") {
          tr = tr.replaceWith(nodePos, nodePos + node.nodeSize, sourceInline(schema, raw));
          tr.setSelection(TextSelection.create(tr.doc, nodePos + Math.min(raw.length, 1)));
        } else if (node.type.name === "rawBlock") {
          // Paragraphs split at blank lines, soft breaks inside.
          const paragraphs = raw.split(/\n[ \t]*\n/).map((part) => schema.nodes.paragraph.create(null, sourceInline(schema, part)));
          tr = tr.replaceWith(nodePos, nodePos + node.nodeSize, paragraphs);
          tr.setSelection(TextSelection.create(tr.doc, nodePos + 1));
        } else {
          return false;
        }
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}
