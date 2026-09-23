/**
 * remark plugin for Obsidian syntax: media embeds (`![[photo.png]]`,
 * `![[photo.png|300]]`, `![[clip.mp4]]`) become ordinary image nodes so the
 * renderer's `img` component resolves and loads them like
 * `![alt](photo.png)`, and `[[Note]]` / `[[Note|alias]]` become link nodes
 * marked with `data-wikilink` that open the note. Only text nodes are
 * rewritten, so syntax inside inline code and fenced blocks stays literal.
 * Note transclusions (`![[Other note]]`) are left as text.
 */
import { mediaKindOf, parseWikiEmbed } from "./assets";

/** The mdast fields this plugin touches (avoids a direct `mdast` dependency). */
export interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/** `![[media]]` embeds and `[[note]]` / `[[note|alias]]` / `[[note#heading]]` links. */
const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;

/** Split one text value into text, image (media embeds) and link (`[[wikilinks]]`) nodes. */
export function splitEmbeds(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const match of value.matchAll(WIKI)) {
    const start = match.index ?? 0;
    let node: MdNode | null = null;
    if (match[1] === "!") {
      const embed = parseWikiEmbed(match[2]);
      if (embed.target && mediaKindOf(embed.target)) {
        const hProperties: Record<string, unknown> = { dataEmbed: "wiki" };
        if (embed.width !== null) hProperties.width = embed.width;
        if (embed.height !== null) hProperties.height = embed.height;
        node = { type: "image", url: embed.target, alt: embed.alt, title: null, data: { hProperties } };
      }
    } else {
      const [rawTarget, ...alias] = match[2].split("|");
      const target = rawTarget.split("#")[0].trim();
      const heading = rawTarget.includes("#") ? rawTarget.slice(rawTarget.indexOf("#") + 1).trim() : "";
      const label = alias.join("|").trim() || (heading ? `${target} › ${heading}` : rawTarget.trim());
      if (target) {
        node = {
          type: "link",
          url: `#wikilink`,
          title: null,
          children: [{ type: "text", value: label }],
          data: { hProperties: { dataWikilink: target } },
        };
      }
    }
    if (!node) continue;
    if (start > last) out.push({ type: "text", value: value.slice(last, start) });
    out.push(node);
    last = start + match[0].length;
  }
  if (out.length === 0) return [{ type: "text", value }];
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function transform(node: MdNode): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("[[") && node.type !== "link") {
      const parts = splitEmbeds(child.value);
      if (parts.length !== 1 || parts[0].type !== "text") changed = true;
      next.push(...parts);
    } else {
      transform(child);
      next.push(child);
    }
  }
  if (changed) node.children = next;
}

/** The unified plugin (`remarkPlugins={[remarkGfm, remarkWikiEmbeds]}`). */
export function remarkWikiEmbeds() {
  return (tree: MdNode) => {
    transform(tree);
  };
}
