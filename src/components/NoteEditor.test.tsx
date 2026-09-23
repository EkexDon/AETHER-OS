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
