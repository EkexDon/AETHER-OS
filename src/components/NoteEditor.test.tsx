import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  getNoteContent: vi.fn(),
  writeNote: vi.fn(),
  getBacklinks: vi.fn(),
  getVaultNotes: vi.fn(),
  createNote: vi.fn(),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ...ipc,
}));

import { NoteEditor } from "./NoteEditor";
import { useAetherStore } from "../lib/store";
import { useVaultTasksStore } from "../lib/vaultTasksStore";
import { LINE_FLASH_CLASS } from "../lib/editor/lineFlash";

const PATH = "/vault/Projects/Review.md";
const NOTE = `---
title: Review
tags: [weekly]
---

# Review

Intro paragraph.

- [ ] First task
- [ ] Second task
`;

function open() {
  act(() => {
    useAetherStore.setState({ selectedNotePath: PATH, openNoteTabs: [PATH] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.getNoteContent.mockResolvedValue(NOTE);
  ipc.writeNote.mockResolvedValue(undefined);
  ipc.getBacklinks.mockResolvedValue([]);
  ipc.getVaultNotes.mockResolvedValue([]);
  useAetherStore.setState({ selectedNotePath: null, openNoteTabs: [], vaultNotes: [], noteDirty: false, view: "editor" });
  useVaultTasksStore.setState({ pendingLine: null });
  window.localStorage.clear();
  // jsdom has no layout: scrolling is a no-op we can observe.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("NoteEditor front matter", () => {
  it("shows front matter as properties, not as canvas text, and keeps the title from the file name", async () => {
    const { container } = render(<NoteEditor />);
    open();
    expect(await screen.findByLabelText("title")).toHaveValue("Review");
    await waitFor(() => expect(container.querySelector(".ProseMirror h1")?.textContent).toBe("Review"));
    const canvas = container.querySelector(".ProseMirror") as HTMLElement;
    expect(canvas.textContent).not.toContain("title:");
    expect(canvas.textContent).not.toContain("weekly");
    expect(container.querySelector(".ProseMirror hr")).toBeNull();
    expect(container.querySelector(".note-title")?.textContent).toBe("Review");
    expect(screen.getByText("#weekly")).toBeInTheDocument();
  });

  it("saves a property edit with the body bytes untouched", async () => {
    render(<NoteEditor />);
    open();
    const tags = await screen.findByLabelText("Add to tags");
    fireEvent.change(tags, { target: { value: "review" } });
    fireEvent.keyDown(tags, { key: "Enter" });
    expect(useAetherStore.getState().noteDirty).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(ipc.writeNote).toHaveBeenCalled());
    expect(ipc.writeNote).toHaveBeenLastCalledWith(PATH, NOTE.replace("tags: [weekly]", "tags: [weekly, review]"));
  });

  it("re-attaches the front matter when the body is edited", async () => {
    const { container } = render(<NoteEditor />);
    open();
    await waitFor(() => expect(container.querySelector(".ProseMirror h1")).not.toBeNull());
    const editor = (container.querySelector(".ProseMirror") as HTMLElement & { editor?: { commands: { insertContentAt: (p: number, c: string) => void } } }).editor;
    expect(editor).toBeDefined();
    act(() => editor!.commands.insertContentAt(1, "Weekly "));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(ipc.writeNote).toHaveBeenCalled());
    const saved = ipc.writeNote.mock.calls.at(-1)![1] as string;
    expect(saved.startsWith("---\ntitle: Review\ntags: [weekly]\n---\n\n# Weekly Review")).toBe(true);
    expect(saved).toContain("- [ ] Second task");
  });
});

describe("NoteEditor pending line", () => {
  it("scrolls to and flashes the task a Note Tasks click asked for", async () => {
    // Line 10 (0-based) of the file is "- [ ] Second task".
    useVaultTasksStore.setState({ pendingLine: { notePath: PATH, line: 10 } });
    const { container } = render(<NoteEditor />);
    open();
    await waitFor(() => expect(container.querySelector(`.${LINE_FLASH_CLASS}`)).not.toBeNull());
    const flashed = container.querySelector(`.${LINE_FLASH_CLASS}`) as HTMLElement;
    expect(flashed.textContent).toContain("Second task");
    expect(flashed.textContent).not.toContain("First task");
    expect(flashed.scrollIntoView).toHaveBeenCalled();
    expect(useVaultTasksStore.getState().pendingLine).toBeNull();
  });

  it("handles a pending line for the note that is already open", async () => {
    const { container } = render(<NoteEditor />);
    open();
    await waitFor(() => expect(container.querySelector(".ProseMirror h1")).not.toBeNull());
    act(() => useVaultTasksStore.setState({ pendingLine: { notePath: PATH, line: 9 } }));
    await waitFor(() => expect(container.querySelector(`.${LINE_FLASH_CLASS}`)?.textContent).toContain("First task"));
  });

  it("ignores pending lines of other notes", async () => {
    useVaultTasksStore.setState({ pendingLine: { notePath: "/vault/Other.md", line: 3 } });
    const { container } = render(<NoteEditor />);
    open();
    await waitFor(() => expect(container.querySelector(".ProseMirror h1")).not.toBeNull());
    expect(container.querySelector(`.${LINE_FLASH_CLASS}`)).toBeNull();
    expect(useVaultTasksStore.getState().pendingLine).toEqual({ notePath: "/vault/Other.md", line: 3 });
  });
});

// ── Wikilinks ────────────────────────────────────────────────────

const LINKED_PATH = "/vault/Projects/Local-first Sync.md";
const LINKED = `---
tags: [project, sync]
---
# Local-first Sync

Options:
1. Git-based sync
2. CRDT

Leaning towards option 1 because [[AETHER-OS]] already ships git support.

Why it matters :: Your data stays usable offline.

- [ ] Compare [[Automerge]] vs. Yjs 📅 2026-10-06 #sync
`;
const VAULT_NOTES = [
  { path: "/vault/Projects/AETHER-OS.md", name: "AETHER-OS", mtime: 3 },
  { path: "/vault/Projects/AETHER-OS Roadmap.md", name: "AETHER-OS Roadmap", mtime: 2 },
  { path: LINKED_PATH, name: "Local-first Sync", mtime: 1 },
];

type TestEditor = {
  state: { doc: { descendants: (f: (node: { type: { name: string }; textContent: string; nodeSize: number; isText?: boolean; text?: string }, pos: number) => boolean | void) => void }; selection: { from: number }; tr: { insertText: (t: string, from: number) => unknown } };
  view: { dispatch: (tr: unknown) => void; dom: HTMLElement };
  commands: { insertContentAt: (p: number, c: string) => void; setTextSelection: (p: number) => void };
};

async function openLinked() {
  ipc.getNoteContent.mockResolvedValue(LINKED);
  ipc.getVaultNotes.mockResolvedValue(VAULT_NOTES);
  useAetherStore.setState({ vaultNotes: VAULT_NOTES, vaultPath: "/vault" });
  const utils = render(<NoteEditor />);
  act(() => {
    useAetherStore.setState({ selectedNotePath: LINKED_PATH, openNoteTabs: [LINKED_PATH] });
  });
  await waitFor(() => expect(utils.container.querySelector(".ProseMirror .wikilink")).not.toBeNull());
  const editor = (utils.container.querySelector(".ProseMirror") as HTMLElement & { editor?: TestEditor }).editor!;
  return { ...utils, editor };
}

describe("NoteEditor wikilinks", () => {
  beforeEach(() => {
    const proto = Range.prototype as unknown as Record<string, unknown>;
    if (!proto.getClientRects) proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
    if (!proto.getBoundingClientRect) proto.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  });

  it("shows links as chips and saves an edit without escaping them or touching other lines", async () => {
    const { container, editor } = await openLinked();
    expect([...container.querySelectorAll(".ProseMirror .wikilink")].map((c) => c.textContent)).toEqual(["AETHER-OS", "Automerge"]);
    let end = -1;
    editor.state.doc.descendants((node, pos) => {
      if (end === -1 && node.type.name === "paragraph" && node.textContent.startsWith("Leaning")) end = pos + node.nodeSize - 1;
    });
    act(() => editor.commands.insertContentAt(end, " Decided."));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(ipc.writeNote).toHaveBeenCalled());
    const saved = ipc.writeNote.mock.calls.at(-1)![1] as string;
    expect(saved).toBe(LINKED.replace("already ships git support.", "already ships git support. Decided."));
  });

  it("opens the linked note when a chip is clicked", async () => {
    const { container } = await openLinked();
    fireEvent.click(container.querySelector(".ProseMirror .wikilink")!);
    expect(useAetherStore.getState().selectedNotePath).toBe("/vault/Projects/AETHER-OS.md");
    expect(useAetherStore.getState().openNoteTabs).toContain("/vault/Projects/AETHER-OS.md");
  });

  it("autocompletes [[ by keyboard and inserts the link", async () => {
    const { editor } = await openLinked();
    let end = -1;
    editor.state.doc.descendants((node, pos) => {
      if (end === -1 && node.type.name === "paragraph" && node.textContent.startsWith("Why")) end = pos + node.nodeSize - 1;
    });
    act(() => {
      editor.commands.setTextSelection(end);
      editor.view.dispatch(editor.state.tr.insertText(" See [[aeth", end));
    });
    const menu = await screen.findByRole("listbox", { name: "Link to note" });
    await waitFor(() => expect(menu.querySelectorAll('[role="option"]').length).toBe(3));
    const options = [...menu.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual(["AETHER-OSProjects", "AETHER-OS RoadmapProjects", "Create note “aeth”"]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(editor.view.dom, { key: "ArrowDown" });
    await waitFor(() => expect(menu.querySelectorAll('[role="option"]')[1].getAttribute("aria-selected")).toBe("true"));
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Link to note" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(ipc.writeNote).toHaveBeenCalled());
    const saved = ipc.writeNote.mock.calls.at(-1)![1] as string;
    expect(saved).toBe(LINKED.replace("usable offline.", "usable offline. See [[AETHER-OS Roadmap]]"));
  });

  it("closes the autocomplete with Escape and offers to create a missing note", async () => {
    ipc.createNote.mockResolvedValue("/vault/Brand new.md");
    const { editor } = await openLinked();
    let end = -1;
    editor.state.doc.descendants((node, pos) => {
      if (end === -1 && node.type.name === "paragraph" && node.textContent.startsWith("Why")) end = pos + node.nodeSize - 1;
    });
    act(() => {
      editor.commands.setTextSelection(end);
      editor.view.dispatch(editor.state.tr.insertText(" [[Brand new", end));
    });
    await screen.findByRole("listbox", { name: "Link to note" });
    fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Link to note" })).toBeNull());
    // A dismissed [[ stays closed while typing on…
    act(() => editor.view.dispatch(editor.state.tr.insertText(" idea", editor.state.selection.from)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("listbox", { name: "Link to note" })).toBeNull();
    // …a new one opens again; its only row creates the note.
    act(() => editor.view.dispatch(editor.state.tr.insertText(" [[Brand new idea", editor.state.selection.from)));
    const menu = await screen.findByRole("listbox", { name: "Link to note" });
    await waitFor(() => expect(menu.textContent).toContain("Create note “Brand new idea”"));
    fireEvent.keyDown(editor.view.dom, { key: "Tab" });
    await waitFor(() => expect(ipc.createNote).toHaveBeenCalledWith("Brand new idea", "# Brand new idea\n\n"));
  });
});

describe("NoteEditor note switching", () => {
  it("saves keystrokes typed while another note loads into the note they were typed in", async () => {
    const other = "/vault/Projects/Other.md";
    let resolveOther: (content: string) => void = () => {};
    ipc.getNoteContent.mockImplementation((path: string) =>
      path === other ? new Promise<string>((resolve) => (resolveOther = resolve)) : Promise.resolve(NOTE)
    );
    const { container } = render(<NoteEditor />);
    open();
    await waitFor(() => expect(container.querySelector(".ProseMirror h1")?.textContent).toBe("Review"));
    const editor = (container.querySelector(".ProseMirror") as HTMLElement & { editor?: TestEditor }).editor!;
    // Switch notes; the canvas still shows Review until Other has loaded…
    act(() => {
      useAetherStore.setState({ selectedNotePath: other, openNoteTabs: [PATH, other] });
    });
    // …and the user keeps typing in it.
    act(() => editor.commands.insertContentAt(1, "Late "));
    act(() => resolveOther("# Other\n\nUntouched.\n"));
    await waitFor(() => expect(container.querySelector(".ProseMirror h1")?.textContent).toBe("Other"));
    // Other is untouched (nothing to save); Review's keystrokes are autosaved into Review.
    expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();
    await waitFor(() => expect(ipc.writeNote.mock.calls.some(([path]) => path === PATH)).toBe(true), { timeout: 2500 });
    expect(ipc.writeNote.mock.calls.some(([path]) => path === other)).toBe(false);
    expect(ipc.writeNote).toHaveBeenLastCalledWith(PATH, NOTE.replace("# Review", "# Late Review"));
  });
});
