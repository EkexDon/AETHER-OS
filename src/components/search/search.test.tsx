import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../../lib/ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc/core")>();
  const mock = await import("../../lib/mock/backend");
  return {
    ...actual,
    isDesktopRuntime: () => true,
    isTauriRuntime: () => false,
    call: (command: string, args?: Record<string, unknown>) => mock.mockInvoke(command, args ?? {}),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mock.mockEvents.listen(event, handler),
  };
});

import { mockInvoke, resetMockState, setMockLatency } from "../../lib/mock/backend";
import type { SearchHit, SearchSettings as Settings } from "../../types";
import { useAetherStore } from "../../lib/store";
import { describeReport, useSearchStore } from "../../lib/searchStore";
import { useShellStore } from "../../shell/shellStore";
import { useToastStore } from "../../ui/Toast";
import { UniversalSearch, isMissingVaultIndex } from "./UniversalSearch";
import { SearchSettings, describeAccelerator } from "./SearchSettings";
import { HighlightedSnippet } from "./Highlighted";
import { relativeAge } from "./SearchResultCard";
import { searchCommands } from "../../lib/search/commands";

async function settle(ms = 200) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
  useToastStore.getState().clear();
  useAetherStore.setState({ view: "search", selectedNotePath: null, indexing: false });
  useSearchStore.setState({
    pendingQuery: null,
    viewQuery: "",
    viewTab: "all",
    viewSemantic: false,
    viewSelectedId: null,
    reindexing: false,
    progress: [],
  });
  useShellStore.setState({ launcherOpen: false });
});

describe("UniversalSearch", () => {
  it("shows the start screen with index status", async () => {
    render(<UniversalSearch />);
    expect(screen.getByRole("heading", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByText("Search everything")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/items indexed/)).toBeInTheDocument());
  });

  it("searches with category tabs, snippets and a Markdown preview", async () => {
    render(<UniversalSearch />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ownership" } });
    await settle();
    const results = screen.getByRole("listbox", { name: "Search results" });
    const cards = within(results).getAllByRole("option");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0]).toHaveAttribute("aria-selected", "true");
    expect(results.querySelector("mark")).not.toBeNull();
    const tabs = screen.getByRole("tablist", { name: "Result categories" });
    const notesTab = within(tabs).getByRole("tab", { name: /Notes/ });
    fireEvent.click(notesTab);
    await settle(20);
    expect(
      within(screen.getByRole("listbox", { name: "Search results" }))
        .getAllByRole("option")
        .every((c) => c.textContent?.includes("Note"))
    ).toBe(true);
    // Markdown preview of the selected note.
    const preview = screen.getByRole("complementary", { name: "Preview" });
    await waitFor(() => expect(preview.querySelector(".md-render")).not.toBeNull());
  });

  it("opens the selected result with Enter and moves with the arrows", async () => {
    render(<UniversalSearch />);
    const field = screen.getByRole("searchbox");
    fireEvent.change(field, { target: { value: "ownership" } });
    await settle();
    const cards = within(screen.getByRole("listbox", { name: "Search results" })).getAllByRole("option");
    if (cards.length > 1) {
      fireEvent.keyDown(field, { key: "ArrowDown" });
      expect(cards[1]).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(field, { key: "ArrowUp" });
    }
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(useAetherStore.getState().view).not.toBe("search"));
  });

  it("marks semantic matches when Semantic is on", async () => {
    useSearchStore.setState({ viewSemantic: true });
    render(<UniversalSearch />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "remember things" } });
    await settle();
    expect(screen.getAllByText("Semantic", { selector: ".ui-badge, .ui-badge *" }).length).toBeGreaterThan(0);
  });

  it("lists commands for > and prefixes for ?", async () => {
    render(<UniversalSearch />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "> reindex" } });
    expect(screen.getByRole("button", { name: /Search: reindex/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "?" } });
    expect(screen.getByRole("button", { name: /Memory facts and AI conversations/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Project files and notes by path/ }));
    expect(screen.getByRole("searchbox")).toHaveValue("/");
  });

  it("shows an empty state for no results", async () => {
    render(<UniversalSearch />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "qqqzzzxxx" } });
    await settle();
    expect(screen.getByText(/No results for/)).toBeInTheDocument();
  });

  it("reindexes with a progress toast and a summary", async () => {
    render(<UniversalSearch />);
    fireEvent.click(screen.getByRole("button", { name: /Reindex/ }));
    await waitFor(() => expect(useSearchStore.getState().reindexing).toBe(false), { timeout: 4000 });
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.title === "Search index updated")).toBe(true);
  });
});

describe("SearchSettings", () => {
  it("toggles kinds, validates the shortcut and manages file folders", async () => {
    render(<SearchSettings />);
    const notes = await screen.findByRole("checkbox", { name: /Notes/ });
    expect(notes).toBeChecked();
    fireEvent.click(notes);
    await waitFor(async () =>
      expect((await mockInvoke<Settings>("cmd_search_get_settings")).kinds).not.toContain("note")
    );

    const shortcut = screen.getByLabelText("Shortcut");
    fireEvent.change(shortcut, { target: { value: "Shift+K" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/needs Alt, Ctrl or Cmd/)).toBeInTheDocument();
    fireEvent.change(shortcut, { target: { value: "Ctrl+Alt+Space" } });
    fireEvent.keyDown(shortcut, { key: "Enter" });
    await waitFor(async () =>
      expect((await mockInvoke<Settings>("cmd_search_get_settings")).global_shortcut).toBe("Ctrl+Alt+Space")
    );

    const folder = screen.getByLabelText("Add folder");
    fireEvent.change(folder, { target: { value: "/Users/demo/Developer/aether-demo-app" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("/Users/demo/Developer/aether-demo-app")).toBeInTheDocument();
    fireEvent.change(folder, { target: { value: "relative/path" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/absolute path: relative/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop indexing /Users/demo/Developer/aether-demo-app" }));
    await waitFor(async () => expect((await mockInvoke<Settings>("cmd_search_get_settings")).file_roots).toEqual([]));
  });

  it("clears recents", async () => {
    await mockInvoke("cmd_search_recents_record", { id: "command:app.settings", kind: "command", title: "Settings" });
    render(<SearchSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /Clear recents/ }));
    await waitFor(async () => expect(await mockInvoke<unknown[]>("cmd_search_recents_list", { limit: 5 })).toEqual([]));
  });
});

describe("search helpers", () => {
  it("renders snippets without injecting HTML", () => {
    const { container } = render(<HighlightedSnippet html={'<img src=x onerror="alert(1)"> <mark>hit</mark> &amp;'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("mark")?.textContent).toBe("hit");
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("formats ages, accelerators, reports and index errors", () => {
    const now = 1_800_000_000_000;
    expect(relativeAge(0, now)).toBe("");
    expect(relativeAge(now / 1000 - 30, now)).toBe("just now");
    expect(relativeAge(now / 1000 - 7200, now)).toBe("2 h ago");
    expect(describeAccelerator("CommandOrControl+Shift+Space")).toBe("Cmd/Ctrl + Shift + Space");
    expect(isMissingVaultIndex('Semantic search needs the vault index. Run "Index vault" first')).toBe(true);
    expect(isMissingVaultIndex("network error")).toBe(false);
    expect(
      describeReport({
        kinds: [
          { kind: "note", count: 12, changed: 1, removed: 0, ms: 5, truncated: false, error: null },
          { kind: "file", count: 3, changed: 0, removed: 0, ms: 5, truncated: true, error: null },
          { kind: "app", count: 0, changed: 0, removed: 0, ms: 1, truncated: false, error: "boom" },
        ],
        total: 15,
        ms: 1500,
      })
    ).toBe("12 notes · 3 files (file limit reached) — failed: Apps · 1.5 s");
  });

  it("search commands open the launcher in the right mode", async () => {
    const byId = (id: string) => searchCommands.find((c) => c.id === id)!;
    const ctx = { setView: vi.fn() } as never;
    await byId("search.goToFile").run(ctx);
    expect(useShellStore.getState().launcherOpen).toBe(true);
    expect(useSearchStore.getState().pendingQuery).toBe("/");
    await byId("search.commandMode").run(ctx);
    expect(useSearchStore.getState().pendingQuery).toBe(">");
    await byId("search.view").run(ctx);
    expect((ctx as unknown as { setView: ReturnType<typeof vi.fn> }).setView).toHaveBeenCalledWith("search");
    // ⌘K belongs to the core "Command palette" command; the launcher entry
    // itself carries no shortcut so the overlay lists ⌘K once.
    expect(byId("search.launcher").shortcut).toBeUndefined();
    expect(searchCommands.map((c) => c.shortcut).filter(Boolean)).toEqual(["mod+shift+k", "mod+p", "mod+shift+p"]);
  });

  it("types stay in sync with the mock payloads", async () => {
    const hits = await mockInvoke<SearchHit[]>("cmd_search_query", { q: "garden", kinds: null, limit: 5, perKind: null, semantic: false });
    for (const h of hits) {
      expect(Object.keys(h).sort()).toEqual(
        ["extra", "id", "kind", "matched", "path", "score", "snippet_html", "subtitle", "title", "updated_at"].sort()
      );
    }
  });
});
