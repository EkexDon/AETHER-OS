/**
 * The declarative UI a plugin can render (`api.ui.panel.set(tree)`).
 *
 * Plugins never produce HTML. They send a small JSON tree of known node
 * types; {@link sanitizeViewTree} validates it on the host (unknown types,
 * wrong field types and oversized content are rejected) and returns a
 * normalised copy that `PluginPanel` renders with React text nodes and UI
 * primitives only. Markdown goes through {@link sanitizePluginMarkdown} and
 * the app's `MarkdownRenderer`, which does not render raw HTML.
 */

/** Badge colours available to plugins (mirrors the `Badge` primitive). */
export type PluginBadgeVariant = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

/** One entry of a `list` node. */
export interface PluginListItem {
  text: string;
  /** Right-aligned secondary text, e.g. a count. */
  meta: string | null;
  /** Nesting level 0–3. */
  indent: number;
}

/** A validated view tree node. */
export type PluginViewNode =
  | { type: "text"; text: string; tone: "default" | "muted" }
  | { type: "heading"; text: string; level: 1 | 2 | 3 }
  | { type: "list"; ordered: boolean; items: PluginListItem[] }
  | { type: "button"; label: string; actionId: string; variant: "secondary" | "ghost" }
  | { type: "badge"; text: string; variant: PluginBadgeVariant }
  | { type: "divider" }
  | { type: "markdown"; content: string };

/** Size limits for a panel. */
export const VIEW_TREE_LIMITS = {
  nodes: 200,
  listItems: 500,
  text: 2_000,
  label: 80,
  markdown: 20_000,
} as const;

/** Raised when a plugin sends a tree that is not allowed. */
export class ViewTreeError extends Error {
  constructor(message: string) {
    super(`invalid panel: ${message}`);
    this.name = "ViewTreeError";
  }
}

const BADGE_VARIANTS = new Set<PluginBadgeVariant>(["neutral", "accent", "success", "warning", "danger", "info"]);
const ACTION_ID = /^[A-Za-z0-9._:-]{1,64}$/;

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(node: Raw, field: string, where: string, max: number, required = true): string {
  const value = node[field];
  if (value === undefined || value === null) {
    if (required) throw new ViewTreeError(`${where}.${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw new ViewTreeError(`${where}.${field} must be a string`);
  if (value.length > max) throw new ViewTreeError(`${where}.${field} is longer than ${max} characters`);
  return value;
}

function allowOnly(node: Raw, where: string, fields: string[]): void {
  for (const key of Object.keys(node)) {
    if (key !== "type" && !fields.includes(key)) throw new ViewTreeError(`${where} has an unknown field "${key}"`);
  }
}

function listItem(raw: unknown, where: string): PluginListItem {
  if (typeof raw === "string") {
    if (raw.length > VIEW_TREE_LIMITS.text) throw new ViewTreeError(`${where} is longer than ${VIEW_TREE_LIMITS.text} characters`);
    return { text: raw, meta: null, indent: 0 };
  }
  if (!isObject(raw)) throw new ViewTreeError(`${where} must be a string or { text, meta?, indent? }`);
  allowOnly(raw, where, ["text", "meta", "indent"]);
  const indent = raw.indent ?? 0;
  if (typeof indent !== "number" || !Number.isInteger(indent) || indent < 0 || indent > 3) {
    throw new ViewTreeError(`${where}.indent must be an integer from 0 to 3`);
  }
  const meta = str(raw, "meta", where, VIEW_TREE_LIMITS.label, false);
  return { text: str(raw, "text", where, VIEW_TREE_LIMITS.text), meta: meta || null, indent };
}

function node(raw: unknown, where: string): PluginViewNode {
  if (!isObject(raw)) throw new ViewTreeError(`${where} must be an object with a "type"`);
  switch (raw.type) {
    case "text": {
      allowOnly(raw, where, ["text", "tone"]);
      const tone = raw.tone ?? "default";
      if (tone !== "default" && tone !== "muted") throw new ViewTreeError(`${where}.tone must be "default" or "muted"`);
      return { type: "text", text: str(raw, "text", where, VIEW_TREE_LIMITS.text), tone };
    }
    case "heading": {
      allowOnly(raw, where, ["text", "level"]);
      const level = raw.level ?? 2;
      if (level !== 1 && level !== 2 && level !== 3) throw new ViewTreeError(`${where}.level must be 1, 2 or 3`);
      return { type: "heading", text: str(raw, "text", where, VIEW_TREE_LIMITS.label * 2), level };
    }
    case "list": {
      allowOnly(raw, where, ["items", "ordered"]);
      if (!Array.isArray(raw.items)) throw new ViewTreeError(`${where}.items must be an array`);
      if (raw.items.length > VIEW_TREE_LIMITS.listItems) {
        throw new ViewTreeError(`${where}.items has more than ${VIEW_TREE_LIMITS.listItems} entries`);
      }
      if (raw.ordered !== undefined && typeof raw.ordered !== "boolean") throw new ViewTreeError(`${where}.ordered must be a boolean`);
      return {
        type: "list",
        ordered: raw.ordered === true,
        items: raw.items.map((item, i) => listItem(item, `${where}.items[${i}]`)),
      };
    }
    case "button": {
      allowOnly(raw, where, ["label", "actionId", "variant"]);
      const actionId = str(raw, "actionId", where, 64);
      if (!ACTION_ID.test(actionId)) throw new ViewTreeError(`${where}.actionId may only use letters, digits and . _ : -`);
      const variant = raw.variant ?? "secondary";
      if (variant !== "secondary" && variant !== "ghost") {
        throw new ViewTreeError(`${where}.variant must be "secondary" or "ghost"`);
      }
      return { type: "button", label: str(raw, "label", where, VIEW_TREE_LIMITS.label), actionId, variant };
    }
    case "badge": {
      allowOnly(raw, where, ["text", "variant"]);
      const variant = (raw.variant ?? "neutral") as PluginBadgeVariant;
      if (!BADGE_VARIANTS.has(variant)) throw new ViewTreeError(`${where}.variant is not a badge variant`);
      return { type: "badge", text: str(raw, "text", where, VIEW_TREE_LIMITS.label), variant };
    }
    case "divider":
      allowOnly(raw, where, []);
      return { type: "divider" };
    case "markdown":
      allowOnly(raw, where, ["content"]);
      return { type: "markdown", content: str(raw, "content", where, VIEW_TREE_LIMITS.markdown) };
    default:
      throw new ViewTreeError(`${where} has an unknown type "${String(raw.type)}"`);
  }
}

/**
 * Validate a panel tree from a plugin. Accepts one node, an array of nodes,
 * or `null` (clears the panel → `[]`). Throws {@link ViewTreeError}.
 */
export function sanitizeViewTree(input: unknown): PluginViewNode[] {
  if (input === null || input === undefined) return [];
  const nodes = Array.isArray(input) ? input : [input];
  if (nodes.length > VIEW_TREE_LIMITS.nodes) {
    throw new ViewTreeError(`a panel may contain at most ${VIEW_TREE_LIMITS.nodes} nodes`);
  }
  return nodes.map((n, i) => node(n, `node[${i}]`));
}

/**
 * Make plugin Markdown safe to render: images become their alt text (a
 * remote image URL would let a plugin leak data without the network
 * permission) and mermaid fences are shown as code instead of being
 * rendered to SVG. Raw HTML is already displayed as text by the renderer.
 */
export function sanitizePluginMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/^(\s*(?:```|~~~)\s*)mermaid\b/gim, "$1text");
}

/** Group consecutive badges so they wrap on one row. */
export function groupBadges(nodes: PluginViewNode[]): (PluginViewNode | { type: "badges"; badges: Extract<PluginViewNode, { type: "badge" }>[] })[] {
  const out: (PluginViewNode | { type: "badges"; badges: Extract<PluginViewNode, { type: "badge" }>[] })[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === "badge") {
      if (last && last.type === "badges") last.badges.push(n);
      else out.push({ type: "badges", badges: [n] });
    } else {
      out.push(n);
    }
  }
  return out;
}
