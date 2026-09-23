import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// Route the typed IPC wrappers to the DEV mock backend.
vi.mock("../../lib/ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc/core")>();
  const mock = await import("../../lib/mock/backend");
  return {
    ...actual,
    call: (command: string, args?: Record<string, unknown>) => mock.mockInvoke(command, args ?? {}),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mock.mockEvents.listen(event, handler),
  };
});

import { mockInvoke, resetMockState, setMockLatency } from "../../lib/mock/backend";
import { mockCapture } from "../../lib/mock/clipboard";
import { resetClipboardStore, useClipboardStore } from "../../lib/clipboardStore";
import { useToastStore } from "../../ui/Toast";
import { ClipboardView } from "./ClipboardView";

const lastToast = () => useToastStore.getState().toasts.at(-1);

async function renderView() {
  const utils = render(<ClipboardView />);
  const list = await screen.findByRole("listbox", { name: "Clipboard history" });
  await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(40));
  return { ...utils, list };
}

const selectedOption = (list: HTMLElement) => within(list).getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");

beforeEach(async () => {
  setMockLatency(0);
  resetMockState();
  await resetClipboardStore();
  useToastStore.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClipboardView", () => {
  it("lists the history with stats and shows the newest clip in the detail pane", async () => {
    const { list } = await renderView();
    expect(await screen.findByText(/40 clips · \d+ pinned/)).toBeInTheDocument();
    const first = within(list).getAllByRole("option")[0];
    expect(first).toHaveAttribute("aria-selected", "true");
    const detail = screen.getByRole("region", { name: "Clip details" });
    expect(within(detail).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(within(detail).getByText("github.com")).toBeInTheDocument();
  });

  it("navigates with the keyboard, copies with Enter and pins with P", async () => {
    const { list } = await renderView();
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    const second = within(list).getAllByRole("option")[1];
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(list).toHaveAttribute("aria-activedescendant", second.id);

    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(lastToast()).toMatchObject({ kind: "success", title: "Copied" }));
    // The copied clip moved to the top.
    await waitFor(() => expect(within(list).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true"));

    const detail = screen.getByRole("region", { name: "Clip details" });
    const pinnedBefore = within(detail).queryByText("Pinned") !== null;
    fireEvent.keyDown(list, { key: "p" });
    await waitFor(() => expect(within(detail).queryByText("Pinned") !== null).toBe(!pinnedBefore));
  });

  it("deletes with Backspace and restores with Undo", async () => {
    const { list } = await renderView();
    const firstLabel = within(list).getAllByRole("option")[0].textContent;
    list.focus();
    fireEvent.keyDown(list, { key: "Backspace" });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(39));
    expect(lastToast()?.title).toBe("Clip deleted");
    act(() => lastToast()?.action?.onClick());
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(40));
    expect(within(list).getAllByRole("option")[0].textContent).toBe(firstLabel);
  });

  it("searches, filters by kind and offers to clear filters", async () => {
    const { list } = await renderView();
    const search = screen.getByRole("searchbox", { name: "Search clipboard history" });
    fireEvent.change(search, { target: { value: "rusqlite" } });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(1));
    // Arrow keys in the search field move the list selection; Escape clears.
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(40));

    fireEvent.click(screen.getByRole("radio", { name: "Images" }));
    await waitFor(() => {
      const options = within(screen.getByRole("listbox")).getAllByRole("option");
      expect(options.length).toBeGreaterThan(0);
      expect(options.every((o) => o.className.includes("clip-row-image"))).toBe(true);
    });

    fireEvent.change(search, { target: { value: "zzzz-nothing" } });
    expect(await screen.findByText("No matching clips")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(40));
  });

  it("updates live when something is copied elsewhere", async () => {
    const { list } = await renderView();
    act(() => {
      mockCapture({ kind: "text", content: "Copied in another app" });
    });
    await waitFor(() => expect(within(list).getAllByRole("option")[0]).toHaveTextContent("Copied in another app"));
  });

  it("pauses and resumes capture with a clear status", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Pause capture" }));
    expect(await screen.findByText(/Capture is paused/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.queryByText(/Capture is paused/)).not.toBeInTheDocument());
  });

  it("saves the selected clip as a note", async () => {
    await renderView();
    const detail = screen.getByRole("region", { name: "Clip details" });
    fireEvent.click(within(detail).getByRole("button", { name: "Save as note" }));
    const title = await screen.findByLabelText("Title");
    expect((title as HTMLInputElement).value).toBe("Link github.com");
    fireEvent.change(title, { target: { value: "PR 42" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(lastToast()).toMatchObject({ kind: "success", title: "Saved as note" }));
    const path = String(lastToast()?.description);
    expect(path).toBe("clipboard/PR 42.md");
  });

  it("shows the empty state for an empty history", async () => {
    await mockInvoke("cmd_clipboard_clear", { keepPinned: false });
    render(<ClipboardView />);
    expect(await screen.findByText("Nothing copied yet")).toBeInTheDocument();
    expect(useClipboardStore.getState().items).toEqual([]);
  });

  it("confirms before clearing the history", async () => {
    await renderView();
    act(() => useClipboardStore.getState().requestClear(true));
    const dialog = await screen.findByRole("dialog", { name: "Clear clipboard history?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear history" }));
    await waitFor(() => expect(lastToast()?.title).toMatch(/^Removed \d+ clips$/));
    await waitFor(() => expect(screen.getAllByRole("option").every((o) => o.querySelector(".clip-row-pin"))).toBe(true));
  });
});
