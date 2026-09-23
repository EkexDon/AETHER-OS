import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockEvents, mockHandlers, mockInvoke, resetMockState, setMockLatency } from "../../lib/mock/backend";
import { MOCK_VAULT_ROOT } from "../../lib/mock/fixtures/vault";
import { mockVault } from "../../lib/mock/vaultStore";
import type { HistoryStatus } from "../../types";

// Route every IPC wrapper through the DEV mock backend.
vi.mock("../../lib/ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc/core")>();
  return {
    ...actual,
    call: (command: string, args?: Record<string, unknown>) =>
      mockInvoke(command, args ?? {}).catch((reason) => {
        throw new Error(String(reason));
      }),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mockEvents.listen(event, handler),
  };
});

const { HistoryView } = await import("./HistoryView");
const { HistoryStatusItem, historyStatusLabel } = await import("./HistoryStatusItem");
const { HistorySettings } = await import("./HistorySettings");
const { useHistoryStore } = await import("../../lib/historyStore");
const { useAetherStore } = await import("../../lib/store");
const { useIdeStore } = await import("../../lib/ideStore");
const { useShellStore } = await import("../../shell/shellStore");
const { useToastStore } = await import("../../ui");
const { historyCommands, showNoteHistory } = await import("../../lib/history/commands");

const NOTE = `${MOCK_VAULT_ROOT}/01-Projects/AETHER-OS.md`;
const initialHistory = useHistoryStore.getState();

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
  useHistoryStore.setState({ ...initialHistory, status: null, recent: [], recentLoaded: false, revision: 0 }, true);
  useToastStore.getState().clear();
  useAetherStore.setState({
    view: "history",
    vaultPath: MOCK_VAULT_ROOT,
    vaultNotes: mockVault.list(),
    selectedNotePath: null,
    noteDirty: false,
    noteContent: null,
  });
  useIdeStore.setState({ rootPath: null, tabs: [], activePath: null });
});

const toastTitles = () => useToastStore.getState().toasts.map((t) => String(t.title));

describe("HistoryView", () => {
  it("shows the activity timeline, the note's versions and a diff", async () => {
    useAetherStore.setState({ selectedNotePath: NOTE });
    render(<HistoryView />);

    const activity = await screen.findByRole("region", { name: "Activity" });
    await within(activity).findByText("Today");
    expect(within(activity).getByText("History started")).toBeInTheDocument();

    const list = await screen.findByRole("listbox", { name: "Versions of AETHER-OS" });
    const options = within(list).getAllByRole("option");
    expect(options.length).toBeGreaterThanOrEqual(4);
    expect(within(options[0]).getByText("Latest")).toBeInTheDocument();
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    const changes = screen.getByRole("region", { name: "Changes" });
    await within(changes).findByRole("table");
    expect(within(changes).getAllByRole("row").length).toBeGreaterThan(0);

    // Keyboard navigation moves the selection.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    await waitFor(() => expect(within(list).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true"));
  });

  it("restores a version after confirmation", async () => {
    useAetherStore.setState({ selectedNotePath: NOTE });
    render(<HistoryView />);
    const list = await screen.findByRole("listbox", { name: "Versions of AETHER-OS" });
    const options = within(list).getAllByRole("option");
    fireEvent.click(options[options.length - 1]);

    fireEvent.click(screen.getByRole("button", { name: /Restore this version/ }));
    const dialog = await screen.findByRole("dialog", { name: "Restore this version?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(toastTitles()).toContain("Note restored"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const versions = await mockInvoke<{ message: string }[]>("cmd_history_list", { path: NOTE });
    expect(versions[0].message).toMatch(/^restore: 01-Projects\/AETHER-OS\.md to /);
    await waitFor(() =>
      expect(within(screen.getByRole("listbox", { name: "Versions of AETHER-OS" })).getAllByRole("option")).toHaveLength(
        options.length + 1
      )
    );
  });

  it("picks notes from the search field and from the timeline", async () => {
    render(<HistoryView />);
    expect(await screen.findByText("Pick a note")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a note" }), { target: { value: "quick cap" } });
    fireEvent.click(await screen.findByRole("option", { name: /Quick Capture/ }));
    expect(await screen.findByRole("listbox", { name: "Versions of Quick Capture" })).toBeInTheDocument();
    expect(useHistoryStore.getState().selectedPath).toBe(`${MOCK_VAULT_ROOT}/00-Inbox/Quick Capture.md`);

    const activity = screen.getByRole("region", { name: "Activity" });
    const restored = await within(activity).findByText(/^Restored /);
    fireEvent.click(restored.closest("button")!);
    await screen.findByRole("listbox", { name: "Versions of Masterarbeit" });
    const selected = within(screen.getByRole("listbox", { name: "Versions of Masterarbeit" }))
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveTextContent("Restored");
  });

  it("offers to turn automatic versioning back on", async () => {
    await mockInvoke("cmd_history_set_enabled", { enabled: false });
    render(<HistoryView />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(useHistoryStore.getState().status?.enabled).toBe(true));
  });

  it("asks for a vault when none is connected", async () => {
    const original = mockHandlers.cmd_history_status;
    mockHandlers.cmd_history_status = () => ({
      enabled: true,
      vault_path: null,
      repo_path: null,
      branch: null,
      commit_count: 0,
      last_commit_at: null,
      watching: false,
      last_error: null,
    });
    try {
      useAetherStore.setState({ vaultPath: null });
      render(<HistoryView />);
      expect(await screen.findByText("No vault connected")).toBeInTheDocument();
    } finally {
      mockHandlers.cmd_history_status = original;
    }
  });
});

describe("HistoryStatusItem and drawer", () => {
  it("shows the last snapshot and opens the history view", async () => {
    useAetherStore.setState({ view: "dashboard" });
    render(<HistoryStatusItem />);
    const button = await screen.findByRole("button", { name: /Note history:/ });
    expect(button).toHaveTextContent(/ago|just now/);
    fireEvent.click(button);
    expect(useAetherStore.getState().view).toBe("history");
  });

  it("formats the label for off and empty histories", () => {
    const base: HistoryStatus = {
      enabled: true,
      vault_path: "/v",
      repo_path: "/v",
      branch: "main",
      commit_count: 0,
      last_commit_at: null,
      watching: true,
      last_error: null,
    };
    expect(historyStatusLabel(base, Date.now())).toBe("No snapshots");
    expect(historyStatusLabel({ ...base, enabled: false }, Date.now())).toBe("History off");
    expect(historyStatusLabel({ ...base, last_commit_at: Math.floor(Date.now() / 1000) - 120 }, Date.now())).toBe("2m ago");
  });

  it("opens the drawer for the note in the editor (⌘⇧H) and the view elsewhere", async () => {
    render(<HistoryStatusItem />);
    useAetherStore.setState({ view: "editor", selectedNotePath: NOTE });
    act(() => showNoteHistory({ view: "editor", setView: (v) => useAetherStore.getState().setView(v) }));
    const drawer = await screen.findByRole("dialog", { name: "AETHER-OS" });
    expect(await within(drawer).findByRole("listbox", { name: "Versions of AETHER-OS" })).toBeInTheDocument();

    // Escape closes the drawer even when focus was lost to <body>.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    act(() => showNoteHistory({ view: "editor", setView: (v) => useAetherStore.getState().setView(v) }));
    const reopened = await screen.findByRole("dialog", { name: "AETHER-OS" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Open in History view" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useAetherStore.getState().view).toBe("history");
    expect(useHistoryStore.getState().selectedPath).toBe(NOTE);

    useHistoryStore.setState({ selectedPath: null });
    act(() => showNoteHistory({ view: "dashboard", setView: (v) => useAetherStore.getState().setView(v) }));
    expect(useHistoryStore.getState().drawerPath).toBeNull();
    expect(useHistoryStore.getState().selectedPath).toBe(NOTE);
    expect(historyCommands.map((c) => c.shortcut)).toEqual(["mod+shift+h", "mod+alt+s", undefined]);
  });
});

describe("HistorySettings", () => {
  it("toggles versioning and opens the vault repository in the IDE", async () => {
    useShellStore.setState({ settingsOpen: true });
    render(<HistorySettings />);
    const toggle = await screen.findByRole("switch", { name: "Version notes automatically" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText(MOCK_VAULT_ROOT)).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(toastTitles()).toContain("Automatic versioning is off");

    fireEvent.click(screen.getByRole("button", { name: "Open in IDE" }));
    expect(useIdeStore.getState().rootPath).toBe(MOCK_VAULT_ROOT);
    expect(useAetherStore.getState().view).toBe("ide");
    expect(useShellStore.getState().settingsOpen).toBe(false);
  });

  it("refuses to switch the IDE while it has unsaved files", async () => {
    useIdeStore.setState({
      rootPath: "/Users/demo/Developer/app",
      tabs: [{ path: "/a.ts", name: "a.ts", content: "x", savedContent: "", language: "typescript" }],
      activePath: "/a.ts",
    });
    render(<HistorySettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Open in IDE" }));
    expect(useIdeStore.getState().rootPath).toBe("/Users/demo/Developer/app");
    expect(toastTitles()).toContain("Cannot open the vault in the IDE");
  });
});
