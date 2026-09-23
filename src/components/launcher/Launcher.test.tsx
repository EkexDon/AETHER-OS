import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../../lib/ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc/core")>();
  const mock = await import("../../lib/mock/backend");
  return {
    ...actual,
    isDesktopRuntime: () => true,
    call: (command: string, args?: Record<string, unknown>) => mock.mockInvoke(command, args ?? {}),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mock.mockEvents.listen(event, handler),
  };
});

import { mockEvents, mockInvoke, resetMockState, setMockLatency } from "../../lib/mock/backend";
import type { RecentHit } from "../../types";
import { useAetherStore } from "../../lib/store";
import { useShellStore } from "../../shell/shellStore";
import { useSearchStore } from "../../lib/searchStore";
import { useToastStore } from "../../ui/Toast";
import { isMacPlatform } from "../../lib/shortcuts";
import { Launcher, alternateLabel, primaryLabel } from "./Launcher";
import { hitItems } from "../../lib/search/launcherItems";
// Registers the "Go to <view>" navigation commands, as the app does.
import "../../views/registry";

function input() {
  return screen.getByRole("combobox");
}

async function typeQuery(value: string) {
  fireEvent.change(input(), { target: { value } });
  // Debounce (60 ms) + mock latency (0) + React updates.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 90));
  });
}

function options() {
  return screen.queryAllByRole("option");
}

function activeOption() {
  return options().find((o) => o.getAttribute("aria-selected") === "true");
}

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
  localStorage.clear();
  useToastStore.getState().clear();
  useAetherStore.setState({ view: "dashboard", selectedNotePath: null, vaultPath: "/Users/demo/Documents/Second-Brain" });
  useShellStore.setState({ launcherOpen: true });
  useSearchStore.setState({ pendingQuery: null });
});

describe("Launcher", () => {
  it("browses commands when the query is empty and runs the selection", async () => {
    const onClose = vi.fn();
    render(<Launcher onClose={onClose} />);
    expect(await screen.findByText("Commands")).toBeInTheDocument();
    expect(options()[0]).toHaveTextContent("Go to Home");
    expect(screen.queryByText("Command palette")).not.toBeInTheDocument();
    fireEvent.change(input(), { target: { value: "> calendar" } });
    expect(options()[0]).toHaveTextContent("Go to Calendar");
    fireEvent.keyDown(input(), { key: "Enter" });
    await act(async () => undefined);
    expect(onClose).toHaveBeenCalled();
    expect(useAetherStore.getState().view).toBe("calendar");
  });

  it("groups backend results by section and opens notes in the editor", async () => {
    render(<Launcher onClose={() => undefined} />);
    await typeQuery("ownership");
    const notes = await screen.findByRole("group", { name: "Notes" });
    const first = within(notes).getAllByRole("option")[0];
    expect(first.querySelector("mark")).not.toBeNull();
    fireEvent.click(first);
    await waitFor(() => expect(useAetherStore.getState().view).toBe("editor"));
    expect(useAetherStore.getState().selectedNotePath).toMatch(/\.md$/);
    const recents = await mockInvoke<RecentHit[]>("cmd_search_recents_list", { limit: 5 });
    expect(recents[0].kind).toBe("note");
  });

  it("moves with the arrows and jumps sections with Tab", async () => {
    render(<Launcher onClose={() => undefined} />);
    await typeQuery("a");
    const groups = screen.getAllByRole("group");
    expect(groups.length).toBeGreaterThan(1);
    const secondGroupFirst = within(groups[1]).getAllByRole("option")[0];
    fireEvent.keyDown(input(), { key: "Tab" });
    expect(activeOption()).toBe(secondGroupFirst);
    fireEvent.keyDown(input(), { key: "Tab", shiftKey: true });
    expect(activeOption()).toBe(within(groups[0]).getAllByRole("option")[0]);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(activeOption()).toBe(options()[options().length - 1]);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(activeOption()).toBe(options()[0]);
  });

  it("restricts to files with the / prefix and opens them in the IDE", async () => {
    render(<Launcher onClose={() => undefined} />);
    await typeQuery("/readme");
    expect(screen.getByText("Files", { selector: ".launcher-prefix" })).toBeInTheDocument();
    const files = await screen.findByRole("group", { name: "Files" });
    expect(screen.queryByRole("group", { name: "Commands" })).not.toBeInTheDocument();
    fireEvent.click(within(files).getAllByRole("option")[0]);
    await waitFor(() => expect(useAetherStore.getState().view).toBe("ide"));
  });

  it("lists prefixes for ? and adopts one on Enter", async () => {
    render(<Launcher onClose={() => undefined} />);
    fireEvent.change(input(), { target: { value: "?" } });
    expect(screen.getByRole("group", { name: "Search prefixes" })).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveValue("#");
  });

  it("clears the query on Escape before closing", async () => {
    const onClose = vi.fn();
    render(<Launcher onClose={onClose} />);
    fireEvent.change(input(), { target: { value: "garden" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an empty state and a hint for unknown queries", async () => {
    render(<Launcher onClose={() => undefined} />);
    await typeQuery("zzqqxxnotathing");
    expect(screen.getByText(/No results for/)).toBeInTheDocument();
    expect(screen.getByText(/Type \? to see/)).toBeInTheDocument();
  });

  it("adopts a pending query (Go to file) and opens from the global shortcut event", async () => {
    useShellStore.setState({ launcherOpen: false });
    const { rerender } = render(<Launcher open={useShellStore.getState().launcherOpen} onClose={() => undefined} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      mockEvents.emit("launcher-open", null);
    });
    expect(useShellStore.getState().launcherOpen).toBe(true);
    useSearchStore.getState().openLauncher("/");
    rerender(<Launcher open={useShellStore.getState().launcherOpen} onClose={() => undefined} />);
    expect(input()).toHaveValue("/");
    expect(useSearchStore.getState().pendingQuery).toBeNull();
  });

  it("runs the alternate action with mod+Enter", async () => {
    render(<Launcher onClose={() => undefined} />);
    await typeQuery("@berlin");
    const memory = await screen.findByRole("group", { name: "Memory" });
    expect(within(memory).getAllByRole("option")[0]).toHaveTextContent("Berlin");
    expect(screen.getByText("Show in Search")).toBeInTheDocument();
    const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(input(), { key: "Enter", ...mod });
    await waitFor(() => expect(useAetherStore.getState().view).toBe("search"));
    expect(useSearchStore.getState()).toMatchObject({ viewTab: "memory", viewQuery: expect.stringContaining("Berlin") });
  });
});

describe("launcher labels", () => {
  it("describe the Enter and mod+Enter actions per kind", () => {
    const [note, project] = hitItems(
      [
        { id: "note:/a.md", kind: "note", title: "A", subtitle: "", path: "/a.md", snippet_html: "", score: 1, updated_at: 0, extra: {}, matched: [] },
        { id: "project:/p", kind: "project", title: "P", subtitle: "", path: "/p", snippet_html: "", score: 1, updated_at: 0, extra: {}, matched: [] },
      ],
      ""
    );
    expect(primaryLabel(note)).toBe("Open note");
    expect(alternateLabel(note, "cursor")).toBe("Open in IDE");
    expect(primaryLabel(project)).toBe("Open in IDE");
    expect(alternateLabel(project, "cursor")).toBe("Open in Cursor");
  });
});
