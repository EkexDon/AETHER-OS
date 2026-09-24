/**
 * `[[` autocomplete for the note editor (TipTap's suggestion utility).
 *
 * Typing `[[` (or `![[` for an embed) opens a list of vault notes, ranked
 * with the command palette's fuzzy matcher over note names, vault paths and
 * initials; with nothing typed yet the most recently changed notes are offered. The last
 * row creates a note with the typed name when none matches exactly.
 * Enter or Tab inserts the link as a `wikiLink` node, Esc closes the list.
 * A `#heading` or `|alias` typed after the name is kept in the link.
 *
 * The list logic is pure (and tested); the popup is supplied by the caller
 * as a suggestion renderer (`components/editor/WikilinkMenu.tsx`).
 */
import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey, type EditorState } from "@tiptap/pm/state";
import Suggestion, { type SuggestionMatch, type SuggestionOptions, type Trigger } from "@tiptap/suggestion";
import type { VaultNote } from "../../types";
import { scoreFields } from "../commands/fuzzy";
import { isWikilinkInner } from "./obsidianSyntax";
import { isCreatableNoteName, storeWikilinkHost, type WikilinkHost } from "./wikilinkHost";

/** One row of the autocomplete. */
export type WikilinkSuggestionItem =
  | {
      kind: "note";
      /** Absolute note path. */
      path: string;
      name: string;
      /** Vault-relative folder (`""` at the root). */
      folder: string;
      /** Text to put between `[[` and `]]`. */
      insert: string;
    }
  | {
      kind: "create";
      /** Name of the note to create. */
      name: string;
      insert: string;
    };

/** Options of {@link wikilinkSuggestions}. */
export interface WikilinkSuggestionContext {
  vaultRoot?: string | null;
  /** Most rows (the create row comes on top of these). */
  limit?: number;
}

function vaultRelative(path: string, root: string | null | undefined): string {
  const clean = path.replace(/\\/g, "/");
  const base = (root ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return (base && clean.startsWith(`${base}/`) ? clean.slice(base.length + 1) : clean.split("/").pop() ?? clean).replace(/\.md$/i, "");
}

/** First letters of a name's words (`React Patterns` → `rp`), so initials find a note too. */
function initials(name: string): string {
  return name
    .split(/[\s/._-]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .toLowerCase();
}

/** Split what was typed after `[[` into the note part and a `#heading` / `|alias` suffix. */
export function splitLinkQuery(query: string): { name: string; suffix: string } {
  const cut = query.search(/[#|]/);
  return cut === -1 ? { name: query, suffix: "" } : { name: query.slice(0, cut), suffix: query.slice(cut) };
}

/**
 * The rows for `query` (the text typed after `[[`): matching notes, best
 * first, then "Create note" when no note has exactly that name. A note
 * whose name exists more than once is linked by its vault path.
 */
export function wikilinkSuggestions(query: string, notes: readonly VaultNote[], context: WikilinkSuggestionContext = {}): WikilinkSuggestionItem[] {
  const limit = context.limit ?? 8;
  const { name, suffix } = splitLinkQuery(query);
  const wanted = name.trim();
  const names = new Map<string, number>();
  for (const note of notes) names.set(note.name.toLowerCase(), (names.get(note.name.toLowerCase()) ?? 0) + 1);

  let ranked: VaultNote[];
  if (!wanted) {
    ranked = [...notes].sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name)).slice(0, limit);
  } else {
    ranked = notes
      .map((note) => ({ note, rel: vaultRelative(note.path, context.vaultRoot), score: 0 }))
      .map((entry) => ({ ...entry, score: scoreFields(wanted, entry.note.name, [entry.rel, initials(entry.note.name)]) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.rel.length - b.rel.length || a.note.name.localeCompare(b.note.name))
      .slice(0, limit)
      .map((entry) => entry.note);
  }

  const items: WikilinkSuggestionItem[] = ranked.map((note) => {
    const rel = vaultRelative(note.path, context.vaultRoot);
    const slash = rel.lastIndexOf("/");
    const ambiguous = (names.get(note.name.toLowerCase()) ?? 0) > 1;
    return { kind: "note", path: note.path, name: note.name, folder: slash === -1 ? "" : rel.slice(0, slash), insert: `${ambiguous ? rel : note.name}${suffix}` };
  });

  const lower = wanted.toLowerCase().replace(/\.md$/i, "");
  const exists = notes.some((n) => n.name.toLowerCase() === lower || vaultRelative(n.path, context.vaultRoot).toLowerCase() === lower);
  if (wanted && !exists && isCreatableNoteName(wanted)) {
    items.push({ kind: "create", name: wanted.replace(/\.md$/i, ""), insert: `${wanted.replace(/\.md$/i, "")}${suffix}` });
  }
  return items;
}

/** Index after moving `delta` rows through `count` rows, wrapping around. */
export function moveIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * The open `[[` before the cursor in the current text node: from `[[` (or
 * `![[`) to the cursor, as long as it holds no bracket or line break.
 */
export function findWikilinkMatch(config: Pick<Trigger, "$position">): SuggestionMatch {
  const { $position } = config;
  const before = $position.nodeBefore;
  const text = before?.isText ? before.text : null;
  if (!text) return null;
  const open = text.lastIndexOf("[[");
  if (open === -1) return null;
  const query = text.slice(open + 2);
  if (/[[\]\n\r]/.test(query) || query.length > 200) return null;
  const embed = open > 0 && text[open - 1] === "!";
  const start = open - (embed ? 1 : 0);
  const from = $position.pos - text.length + start;
  return { range: { from, to: $position.pos }, query, text: text.slice(start) };
}

function inCode(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  if ($pos.parent.type.spec.code) return true;
  return ($pos.nodeAfter ?? $pos.nodeBefore)?.marks.some((m) => m.type.spec.code) ?? false;
}

/**
 * Replace the typed `[[query` (plus a `]]` right after it, if any) with the
 * chosen link. "Create note" inserts the link at once and creates the note
 * in the background; the chip resolves when the note list refreshes.
 */
export function insertWikilink(editor: Editor, range: Range, item: WikilinkSuggestionItem, host: Pick<WikilinkHost, "create">): boolean {
  const { state } = editor;
  const embed = state.doc.textBetween(range.from, Math.min(range.from + 1, range.to)) === "!";
  let to = range.to;
  if (state.doc.textBetween(to, Math.min(to + 2, state.doc.content.size)) === "]]") to += 2;
  if (!isWikilinkInner(item.insert)) return false;
  const inserted = editor
    .chain()
    .focus()
    .insertContentAt({ from: range.from, to }, [{ type: embed ? "wikiEmbed" : "wikiLink", attrs: { raw: item.insert } }])
    .run();
  if (inserted && item.kind === "create") void host.create(item.name);
  return inserted;
}

/** Plugin key of the autocomplete (to read its state in tests). */
export const wikilinkSuggestionKey = new PluginKey("wikilinkSuggestion");

/** Options of {@link WikilinkSuggestion}. */
export interface WikilinkSuggestionOptions {
  host: WikilinkHost;
  /** The popup; without one the suggestion state still works (tests, headless). */
  render?: SuggestionOptions<WikilinkSuggestionItem, WikilinkSuggestionItem>["render"];
}

/** The `[[` autocomplete extension. */
export const WikilinkSuggestion = Extension.create<WikilinkSuggestionOptions>({
  name: "wikilinkSuggestion",

  addOptions() {
    return { host: storeWikilinkHost, render: undefined };
  },

  addProseMirrorPlugins() {
    const host = this.options.host;
    return [
      Suggestion<WikilinkSuggestionItem, WikilinkSuggestionItem>({
        editor: this.editor,
        pluginKey: wikilinkSuggestionKey,
        char: "[[",
        allowSpaces: true,
        allowedPrefixes: null,
        decorationClass: "wikilink-suggestion",
        findSuggestionMatch: findWikilinkMatch,
        allow: ({ state, range }) => !inCode(state, range.from),
        items: ({ query }) => wikilinkSuggestions(query, host.notes(), { vaultRoot: host.vaultRoot() }),
        command: ({ editor, range, props }) => {
          insertWikilink(editor, range, props, host);
        },
        render: this.options.render,
      }),
    ];
  },
});
