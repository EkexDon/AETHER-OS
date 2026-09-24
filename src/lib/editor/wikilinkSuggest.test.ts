import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { SuggestionProps } from "@tiptap/suggestion";
import type { VaultNote } from "../../types";
import { noteEditorExtensions } from "./extensions";
import { editorMarkdown } from "./noteBody";
import type { WikilinkHost } from "./wikilinkHost";
import {
  findWikilinkMatch,
  moveIndex,
  splitLinkQuery,
  wikilinkSuggestionKey,
  wikilinkSuggestions,
  type WikilinkSuggestionItem,
} from "./wikilinkSuggest";

const ROOT = "/vault";
const note = (rel: string, mtime = 0): VaultNote => ({ path: `${ROOT}/${rel}.md`, name: rel.split("/").pop()!, mtime });
const NOTES: VaultNote[] = [
  note("01-Projects/AETHER-OS", 50),
  note("01-Projects/AETHER-OS Roadmap", 40),
  note("03-Resources/Rust Ownership", 30),
  note("03-Resources/React Patterns", 60),
  note("Welcome", 10),
  note("daily/Ideas", 5),
  note("archive/Ideas", 1),
];

describe("wikilinkSuggestions", () => {
  it("offers the most recently changed notes before anything is typed", () => {
    const items = wikilinkSuggestions("", NOTES, { vaultRoot: ROOT, limit: 3 });
    expect(items.map((i) => i.kind === "note" && i.name)).toEqual(["React Patterns", "AETHER-OS", "AETHER-OS Roadmap"]);
    expect(items.some((i) => i.kind === "create")).toBe(false);
  });

  it("ranks fuzzy matches on the name, exact and prefix first", () => {
    const names = wikilinkSuggestions("aether", NOTES, { vaultRoot: ROOT }).map((i) => (i.kind === "note" ? i.name : `+${i.name}`));
    expect(names.slice(0, 2)).toEqual(["AETHER-OS", "AETHER-OS Roadmap"]);
    expect(wikilinkSuggestions("own", NOTES, { vaultRoot: ROOT })[0]).toMatchObject({ kind: "note", name: "Rust Ownership" });
    expect(wikilinkSuggestions("rp", NOTES, { vaultRoot: ROOT })[0]).toMatchObject({ kind: "note", name: "React Patterns", folder: "03-Resources" });
  });

  it("matches folder paths too", () => {
    expect(wikilinkSuggestions("03-Resources/Rust", NOTES, { vaultRoot: ROOT })[0]).toMatchObject({ name: "Rust Ownership" });
  });

  it("ends with “Create note” unless a note has exactly that name", () => {
    const items = wikilinkSuggestions("Aether ideas", NOTES, { vaultRoot: ROOT });
    expect(items[items.length - 1]).toEqual({ kind: "create", name: "Aether ideas", insert: "Aether ideas" });
    expect(wikilinkSuggestions("welcome", NOTES, { vaultRoot: ROOT }).some((i) => i.kind === "create")).toBe(false);
    expect(wikilinkSuggestions("bad:name?", NOTES, { vaultRoot: ROOT }).some((i) => i.kind === "create")).toBe(false);
  });

  it("links an ambiguous note name by its path and keeps a typed #heading or |alias", () => {
    const ideas = wikilinkSuggestions("Ideas", NOTES, { vaultRoot: ROOT }).filter((i) => i.kind === "note");
    expect(ideas.map((i) => i.insert).sort()).toEqual(["archive/Ideas", "daily/Ideas"]);
    expect(wikilinkSuggestions("Welcome#Start", NOTES, { vaultRoot: ROOT })[0]).toMatchObject({ insert: "Welcome#Start" });
    expect(wikilinkSuggestions("Welcome|hi", NOTES, { vaultRoot: ROOT })[0]).toMatchObject({ insert: "Welcome|hi" });
    expect(splitLinkQuery("Note#H|A")).toEqual({ name: "Note", suffix: "#H|A" });
  });

  it("wraps keyboard movement", () => {
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(0);
  });
});

// ── In the editor ────────────────────────────────────────────────

function fakeHost(overrides: Partial<WikilinkHost> = {}): WikilinkHost {
  return {
    notes: () => NOTES,
    vaultRoot: () => ROOT,
    currentNotePath: () => `${ROOT}/Welcome.md`,
    open: vi.fn(),
    create: vi.fn(async (name: string) => `${ROOT}/${name}.md`),
    subscribe: () => () => {},
    ...overrides,
  };
}

type Props = SuggestionProps<WikilinkSuggestionItem, WikilinkSuggestionItem>;

// jsdom has no layout; ProseMirror measures ranges when it scrolls the caret into view.
beforeAll(() => {
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  const proto = Range.prototype as unknown as Record<string, unknown>;
  if (!proto.getClientRects) proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = rect;
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function mount(host: WikilinkHost, content = "") {
  const events: { type: string; props?: Props }[] = [];
  let latest: Props | null = null;
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({
    element,
    content,
    extensions: noteEditorExtensions({
      wikilinks: host,
      wikilinkMenu: () => ({
        onStart: (props) => {
          latest = props;
          events.push({ type: "start", props });
        },
        onUpdate: (props) => {
          latest = props;
          events.push({ type: "update", props });
        },
        onExit: () => events.push({ type: "exit" }),
      }),
    }),
  });
  return { editor, events, latest: () => latest };
}

function caretToEnd(ed: Editor) {
  ed.view.dispatch(ed.state.tr.setSelection(TextSelection.atEnd(ed.state.doc)));
}

function type(ed: Editor, text: string) {
  const { from } = ed.state.selection;
  ed.view.dispatch(ed.state.tr.insertText(text, from));
}

describe("the [[ autocomplete in the editor", () => {
  it("opens on [[ with the typed query and closes when the link is closed", async () => {
    const { editor: ed, events, latest } = mount(fakeHost(), "Link: ");
    caretToEnd(ed);
    type(ed, "[[Aeth");
    await vi.waitFor(() => expect(latest()?.items.length).toBeGreaterThan(0));
    const state = wikilinkSuggestionKey.getState(ed.state);
    expect(state).toMatchObject({ active: true, query: "Aeth" });
    expect(latest()!.items[0]).toMatchObject({ kind: "note", name: "AETHER-OS" });
    type(ed, "]");
    await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true));
  });

  it("inserts the chosen note as a wikilink node, replacing the typed text", async () => {
    const { editor: ed, latest } = mount(fakeHost(), "See");
    caretToEnd(ed);
    type(ed, " [[rust");
    await vi.waitFor(() => expect(latest()?.items.length).toBeGreaterThan(0));
    latest()!.command(latest()!.items[0]);
    expect(editorMarkdown(ed)).toBe("See [[Rust Ownership]]");
    expect(ed.state.doc.firstChild!.lastChild!.type.name).toBe("wikiLink");
  });

  it("creates a missing note and links it at once", async () => {
    const host = fakeHost();
    const { editor: ed, latest } = mount(host, "");
    caretToEnd(ed);
    type(ed, "[[Brand new idea");
    await vi.waitFor(() => expect(latest()?.items.at(-1)?.kind).toBe("create"));
    latest()!.command(latest()!.items.at(-1)!);
    expect(editorMarkdown(ed)).toBe("[[Brand new idea]]");
    expect(host.create).toHaveBeenCalledWith("Brand new idea");
  });

  it("inserts an embed after ![[ and swallows a trailing ]]", async () => {
    const { editor: ed, latest } = mount(fakeHost(), "");
    caretToEnd(ed);
    type(ed, "![[Welc]]");
    // Put the caret before the closing brackets, as after editing an existing link.
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, ed.state.selection.from - 2)));
    await vi.waitFor(() => expect(latest()?.items.length).toBeGreaterThan(0));
    latest()!.command(latest()!.items[0]);
    expect(editorMarkdown(ed)).toBe("![[Welcome]]");
  });

  it("does not open inside code", () => {
    const { editor: ed } = mount(fakeHost(), "```\ncode\n```");
    caretToEnd(ed);
    type(ed, "[[x");
    expect(wikilinkSuggestionKey.getState(ed.state)?.active).toBe(false);
  });

  it("turns [[Note]] inserted in one input event into a link without breaking the paragraph", () => {
    const { editor: ed } = mount(fakeHost(), "Idea");
    caretToEnd(ed);
    const { from } = ed.state.selection;
    const text = " see [[Welcome]]";
    const handled = ed.view.someProp("handleTextInput", (f) => f(ed.view, from, from, text, () => ed.state.tr.insertText(text, from)));
    expect(handled).toBe(true);
    expect(ed.state.doc.childCount).toBe(1);
    expect(editorMarkdown(ed)).toBe("Idea see [[Welcome]]");
    expect(ed.state.doc.firstChild!.lastChild!.type.name).toBe("wikiLink");
  });

  it("turns a typed [[Note]] into a link", () => {
    const { editor: ed } = mount(fakeHost(), "");
    caretToEnd(ed);
    // Input rules run on text input; simulate the last keystroke.
    type(ed, "[[Welcome]");
    const { from } = ed.state.selection;
    const handled = ed.view.someProp("handleTextInput", (f) => f(ed.view, from, from, "]", () => ed.state.tr.insertText("]", from)));
    expect(handled).toBe(true);
    expect(ed.state.doc.firstChild!.firstChild!.type.name).toBe("wikiLink");
    expect(editorMarkdown(ed)).toBe("[[Welcome]]");
  });
});

describe("findWikilinkMatch", () => {
  it("matches from [[ to the caret, not across closed links or brackets", () => {
    const { editor: ed } = mount(fakeHost(), "");
    const at = (text: string) => {
      ed.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
      const $pos = ed.state.doc.resolve(1 + text.length);
      return findWikilinkMatch({ $position: $pos });
    };
    expect(at("see [[Note na")).toEqual({ range: { from: 5, to: 14 }, query: "Note na", text: "[[Note na" });
    expect(at("see ![[pic")).toMatchObject({ range: { from: 5, to: 11 }, query: "pic" });
    expect(at("see [[Note]] and")).toBeNull();
    expect(at("no link")).toBeNull();
  });
});
