/**
 * `[[wikilinks]]` and `![[embeds]]` as editor nodes.
 *
 * Both are inline atoms that keep the exact text between the brackets in
 * `raw`, so saving writes back precisely what was read — `[[Note]]`,
 * `[[Note#Heading|Alias]]`, `![[photo.png|300]]` — and never an escaped
 * `\[\[Note\]\]`. A link shows as a chip (the alias, or `Note › Heading`)
 * that opens its note on click or Enter; a link to a missing note is shown
 * as unresolved and creates the note when followed (Obsidian's behaviour).
 * An embed of an image shows the image, loaded from the vault like
 * `![alt](path)`; other embeds (notes, video, audio, PDF) show a chip.
 *
 * Typing or pasting `[[…]]` creates a link; double-clicking a chip turns it
 * back into editable text.
 */
import { InputRule, Node, mergeAttributes, nodePasteRule, type Editor } from "@tiptap/core";
import type { Node as PmNode, NodeType, Schema } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { fileName, mediaKindOf, parseWikiEmbed, type MediaKind } from "../markdown/assets";
import { isWikilinkInner, parseWikilink, wikilinkLabel } from "./obsidianSyntax";
import type { SerializerState } from "./markdownSerializer";
import { createVaultImageView } from "./vaultImage";
import { resolveWikilink, storeWikilinkHost, type WikilinkHost } from "./wikilinkHost";

/** Options of {@link WikiLink} and {@link WikiEmbed}. */
export interface WikilinkNodeOptions {
  host: WikilinkHost;
}

function relativeName(path: string, root: string | null): string {
  const clean = path.replace(/\\/g, "/");
  const base = (root ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = base && clean.startsWith(`${base}/`) ? clean.slice(base.length + 1) : clean.split("/").pop() ?? clean;
  return rel.replace(/\.md$/i, "");
}

/** `[[raw]]` / `![[raw]]` for the serializer; `|` is escaped inside tables. */
function writeWikilink(state: SerializerState, raw: string, embed: boolean): void {
  state.write("");
  // A literal "!" right before `[[…]]` would turn the link into an embed.
  if (!embed && /(^|[^\\])!$/.test(state.out)) state.out = `${state.out.slice(0, -1)}\\!`;
  const inner = state.inTable ? raw.replace(/(^|[^\\])\|/g, "$1\\|") : raw;
  state.out += `${embed ? "!" : ""}[[${inner}]]`;
}

const rawAttribute = (dataAttr: string) => ({
  raw: {
    default: "",
    parseHTML: (element: HTMLElement) => element.getAttribute(dataAttr) ?? "",
    renderHTML: (attributes: Record<string, unknown>) => ({ [dataAttr]: String(attributes.raw ?? "") }),
  },
});

/** Replace an atom with its source text so it can be edited (double-click). */
export function unwrapToText(editor: Editor, pos: number, node: PmNode, text: string, caretFromEnd = 2): boolean {
  const { state, view } = editor;
  const tr = state.tr.replaceWith(pos, pos + node.nodeSize, state.schema.text(text));
  tr.setSelection(TextSelection.create(tr.doc, pos + text.length - caretFromEnd));
  view.dispatch(tr);
  view.focus();
  return true;
}

/**
 * Typing the closing `]]` of `[[Note]]` turns it into a link. TipTap's range
 * assumes the typed text lies inside the match; when one input event
 * inserts more (IME, text replacement, automation: " [[Note]]" at once) the
 * range is inverted, so the text before the match is inserted separately.
 */
function linkInputRule(link: NodeType, embed: NodeType | undefined): InputRule {
  return new InputRule({
    find: /(!?)\[\[([^[\]\n]+)\]\]$/,
    handler: ({ state, range, match }) => {
      const inner = match[2];
      const type = match[1] === "!" ? embed : link;
      if (!type || !isWikilinkInner(inner)) return null;
      const node = type.create({ raw: inner });
      const extra = range.from - range.to;
      if (extra <= 0) {
        state.tr.replaceWith(range.from, range.to, node);
        return;
      }
      if (!state.selection.empty) return null;
      const start = match.index ?? 0;
      const prefix = (match.input ?? "").slice(start - extra, start);
      state.tr.insertText(prefix, range.to);
      state.tr.insert(range.to + prefix.length, node);
    },
  });
}

/** The `[[wikilink]]` node. */
export const WikiLink = Node.create<WikilinkNodeOptions>({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { host: storeWikilinkHost };
  },

  addAttributes() {
    return rawAttribute("data-wikilink");
  },

  parseHTML() {
    return [{ tag: "span[data-wikilink]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "wikilink" }), wikilinkLabel(String(node.attrs.raw))];
  },

  renderText({ node }) {
    return `[[${node.attrs.raw}]]`;
  },

  extendNodeSchema(extension) {
    return extension.name === "wikiLink" ? { leafText: (node: PmNode) => String(node.attrs.raw) } : {};
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PmNode) {
          writeWikilink(state, String(node.attrs.raw), false);
        },
        parse: {},
      },
    };
  },

  addNodeView() {
    const host = this.options.host;
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("span");
      dom.className = "wikilink";
      dom.contentEditable = "false";
      const label = document.createElement("span");
      label.className = "wikilink-label";
      dom.append(label);
      let raw = "";

      const refresh = () => {
        const note = resolveWikilink(host, raw);
        const { target } = parseWikilink(raw);
        dom.dataset.state = note ? "resolved" : "unresolved";
        dom.title = note
          ? `${relativeName(note.path, host.vaultRoot())} — click to open`
          : `“${target}” does not exist yet — click to create it`;
      };
      const render = (n: PmNode) => {
        raw = String(n.attrs.raw);
        dom.dataset.wikilink = raw;
        label.textContent = wikilinkLabel(raw);
        refresh();
      };
      render(node);
      const unsubscribe = host.subscribe(refresh);

      dom.addEventListener("mousedown", (event) => {
        if (event.button === 0) event.preventDefault();
      });
      dom.addEventListener("click", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        host.open(parseWikilink(raw));
      });
      dom.addEventListener("dblclick", (event) => {
        event.preventDefault();
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (typeof pos === "number" && editor.isEditable) unwrapToText(editor, pos, editor.state.doc.nodeAt(pos) ?? node, `[[${raw}]]`);
      });

      return {
        dom,
        update: (updated) => {
          if (updated.type !== node.type) return false;
          render(updated);
          return true;
        },
        ignoreMutation: () => true,
        stopEvent: (event) => event.type === "mousedown" || event.type === "click" || event.type === "dblclick",
        destroy: unsubscribe,
      };
    };
  },

  addInputRules() {
    return [linkInputRule(this.type, this.editor.schema.nodes.wikiEmbed)];
  },

  addPasteRules() {
    return [
      nodePasteRule({
        find: /(?<!!)\[\[([^[\]\n]+)\]\]/g,
        type: this.type,
        getAttributes: (match) => ({ raw: match[1] }),
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { selection } = editor.state;
        if (!(selection instanceof NodeSelection) || selection.node.type.name !== this.name) return false;
        this.options.host.open(parseWikilink(String(selection.node.attrs.raw)));
        return true;
      },
    };
  },
});

const MEDIA_LABEL: Record<MediaKind, string> = { image: "Image", video: "Video", audio: "Audio", pdf: "PDF" };

/** The `![[embed]]` node. */
export const WikiEmbed = Node.create<WikilinkNodeOptions>({
  name: "wikiEmbed",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { host: storeWikilinkHost };
  },

  addAttributes() {
    return rawAttribute("data-wikiembed");
  },

  parseHTML() {
    return [{ tag: "span[data-wikiembed]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "wikiembed" }), `![[${node.attrs.raw}]]`];
  },

  renderText({ node }) {
    return `![[${node.attrs.raw}]]`;
  },

  extendNodeSchema(extension) {
    return extension.name === "wikiEmbed" ? { leafText: (node: PmNode) => String(node.attrs.raw) } : {};
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PmNode) {
          writeWikilink(state, String(node.attrs.raw), true);
        },
        parse: {},
      },
    };
  },

  addNodeView() {
    const host = this.options.host;
    return ({ node, editor, getPos }) => {
      const raw = String(node.attrs.raw);
      const embed = parseWikiEmbed(raw.replace(/\\\|/g, "|"));
      const kind = mediaKindOf(embed.target);
      let destroy = () => {};
      let dom: HTMLElement;

      if (kind === "image") {
        const view = createVaultImageView();
        view.dom.classList.add("is-embed");
        view.render(embed.target, embed.alt);
        if (embed.width !== null) view.img.style.width = `${embed.width}px`;
        if (embed.height !== null) view.img.style.height = `${embed.height}px`;
        dom = view.dom;
        destroy = view.destroy;
      } else {
        dom = document.createElement("span");
        dom.className = "wikilink wikiembed-chip";
        dom.contentEditable = "false";
        const badge = document.createElement("span");
        badge.className = "wikiembed-kind";
        badge.textContent = kind ? MEDIA_LABEL[kind] : "Embed";
        const label = document.createElement("span");
        label.className = "wikilink-label";
        label.textContent = kind ? fileName(embed.target) : wikilinkLabel(raw);
        dom.append(badge, label);
        if (kind) {
          dom.dataset.state = "media";
          dom.title = `${embed.target} — shown in the rendered note`;
        } else {
          const refresh = () => {
            const note = resolveWikilink(host, raw);
            dom.dataset.state = note ? "resolved" : "unresolved";
            dom.title = note ? `Embedded note ${relativeName(note.path, host.vaultRoot())} — click to open` : `“${embed.target}” does not exist yet`;
          };
          refresh();
          destroy = host.subscribe(refresh);
          dom.addEventListener("mousedown", (event) => {
            if (event.button === 0) event.preventDefault();
          });
          dom.addEventListener("click", (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            host.open(parseWikilink(raw));
          });
        }
      }
      dom.dataset.wikiembed = raw;
      dom.addEventListener("dblclick", (event) => {
        event.preventDefault();
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (typeof pos === "number" && editor.isEditable) unwrapToText(editor, pos, editor.state.doc.nodeAt(pos) ?? node, `![[${raw}]]`);
      });

      const isChip = kind !== "image";
      return {
        dom,
        // Any change of the source rebuilds the view (image and chip differ).
        update: (updated) => updated.type === node.type && updated.attrs.raw === raw,
        ignoreMutation: () => true,
        // Chips handle their own clicks; images stay selectable like `![alt](src)` images.
        stopEvent: (event) => isChip && (event.type === "mousedown" || event.type === "click" || event.type === "dblclick"),
        destroy: () => destroy(),
      };
    };
  },

  addPasteRules() {
    return [
      nodePasteRule({
        find: /!\[\[([^[\]\n]+)\]\]/g,
        type: this.type,
        getAttributes: (match) => ({ raw: match[1] }),
      }),
    ];
  },
});

/** Build a link or embed node for `raw` (used by the autocomplete). */
export function wikilinkNode(schema: Schema, raw: string, embed = false): PmNode | null {
  const type = schema.nodes[embed ? "wikiEmbed" : "wikiLink"];
  return type ? type.create({ raw }) : null;
}
