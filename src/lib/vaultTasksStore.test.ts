import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultTaskItem } from "../types";
import { parseTasks } from "./vaulttasks/parser";

vi.mock("./ipc", () => ({
  listVaultTasks: vi.fn(),
  rescanVaultTasks: vi.fn(),
  getVaultTaskStats: vi.fn(),
  toggleVaultTask: vi.fn(),
  setVaultTaskStatus: vi.fn(),
  setVaultTaskDue: vi.fn(),
  setVaultTaskPriority: vi.fn(),
  appendVaultTask: vi.fn(),
  dailyNote: vi.fn(),
}));

import * as ipc from "./ipc";
import { useAetherStore } from "./store";
import { STALE_MESSAGE, useVaultTasksStore } from "./vaultTasksStore";

const mocked = vi.mocked(ipc);
const NOTE = "/vault/Todo.md";
const CONTENT = "- [ ] Buy milk 📅 2026-09-30\n- [x] Done thing\n";
const tasks = (): VaultTaskItem[] => parseTasks(NOTE, CONTENT);

beforeEach(() => {
  vi.clearAllMocks();
  useVaultTasksStore.setState({
    tasks: [],
    loaded: false,
    loading: false,
    error: null,
    stats: null,
    pending: {},
    pendingLine: null,
    quickAddOpen: false,
    quickAddHosts: 0,
    query: "",
    due: "all",
    priority: "all",
    tag: null,
  });
  mocked.listVaultTasks.mockResolvedValue(tasks());
});

describe("useVaultTasksStore", () => {
  it("loads tasks and derives stats", async () => {
    await useVaultTasksStore.getState().load();
    const s = useVaultTasksStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.tasks).toHaveLength(2);
    expect(s.stats).toMatchObject({ total: 2, open: 1, done: 1 });
  });

  it("keeps the error for the view when loading fails", async () => {
    mocked.listVaultTasks.mockRejectedValueOnce(new Error("vault error: no vault path configured"));
    await expect(useVaultTasksStore.getState().load()).rejects.toThrow("no vault path");
    expect(useVaultTasksStore.getState().error).toMatch(/no vault path/);
    expect(useVaultTasksStore.getState().loading).toBe(false);
  });

  it("toggles optimistically and applies the backend result", async () => {
    await useVaultTasksStore.getState().load();
    const milk = useVaultTasksStore.getState().tasks[0];
    const confirmed = { ...milk, checked: true, status: "done" as const, status_char: "x", id: "new-id" };
    let resolve!: (t: VaultTaskItem) => void;
    mocked.toggleVaultTask.mockReturnValueOnce(new Promise((r) => (resolve = r)));

    const pending = useVaultTasksStore.getState().toggle(milk, true);
    expect(useVaultTasksStore.getState().tasks[0].checked).toBe(true);
    expect(useVaultTasksStore.getState().stats?.done).toBe(2);
    await expect(useVaultTasksStore.getState().toggle(milk, true)).rejects.toThrow(/still being saved/);

    resolve(confirmed);
    await pending;
    expect(useVaultTasksStore.getState().tasks[0].id).toBe("new-id");
    expect(mocked.toggleVaultTask).toHaveBeenCalledWith(milk, true);
  });

  it("rolls back on failure", async () => {
    await useVaultTasksStore.getState().load();
    const milk = useVaultTasksStore.getState().tasks[0];
    mocked.setVaultTaskDue.mockRejectedValueOnce(new Error("I/O error: disk full"));
    await expect(useVaultTasksStore.getState().setDue(milk, "2026-10-10")).rejects.toThrow("disk full");
    expect(useVaultTasksStore.getState().tasks[0].due).toBe("2026-09-30");
    expect(useVaultTasksStore.getState().pending).toEqual({});
  });

  it("reloads and explains stale lines", async () => {
    await useVaultTasksStore.getState().load();
    const milk = useVaultTasksStore.getState().tasks[0];
    mocked.setVaultTaskPriority.mockRejectedValueOnce(
      new Error("vault error: note changed, rescan (line 1 no longer holds this task)")
    );
    await expect(useVaultTasksStore.getState().setPriority(milk, "high")).rejects.toThrow(STALE_MESSAGE);
    await vi.waitFor(() => expect(mocked.listVaultTasks).toHaveBeenCalledTimes(2));
  });

  it("adds to the daily note and reloads", async () => {
    mocked.dailyNote.mockResolvedValue("/vault/daily/2026-09-22.md");
    const added = parseTasks("/vault/daily/2026-09-22.md", "- [ ] New\n")[0];
    mocked.appendVaultTask.mockResolvedValue(added);
    const result = await useVaultTasksStore.getState().addToDailyNote("New");
    expect(result).toEqual(added);
    expect(mocked.appendVaultTask).toHaveBeenCalledWith("/vault/daily/2026-09-22.md", "New");
    expect(mocked.listVaultTasks).toHaveBeenCalledTimes(1);
  });

  it("opens the note and hands the line to the editor once", async () => {
    await useVaultTasksStore.getState().load();
    const done = useVaultTasksStore.getState().tasks[1];
    useVaultTasksStore.getState().openTaskNote(done);
    expect(useAetherStore.getState().selectedNotePath).toBe(NOTE);
    expect(useAetherStore.getState().view).toBe("editor");
    expect(useVaultTasksStore.getState().consumePendingLine("/other.md")).toBeNull();
    expect(useVaultTasksStore.getState().consumePendingLine(NOTE)).toBe(1);
    expect(useVaultTasksStore.getState().consumePendingLine(NOTE)).toBeNull();
  });

  it("opens wikilinks by note name", () => {
    useAetherStore.setState({ vaultNotes: [{ path: "/vault/Umzug Berlin.md", name: "Umzug Berlin", mtime: 0 }] });
    expect(useVaultTasksStore.getState().openNoteByName("umzug berlin")).toBe(true);
    expect(useAetherStore.getState().selectedNotePath).toBe("/vault/Umzug Berlin.md");
    expect(useVaultTasksStore.getState().openNoteByName("Nope")).toBe(false);
  });

  it("only opens the quick-add dialog when a host is mounted", () => {
    const store = useVaultTasksStore.getState();
    expect(store.openQuickAdd()).toBe(false);
    const unregister = store.registerQuickAddHost();
    expect(useVaultTasksStore.getState().openQuickAdd()).toBe(true);
    expect(useVaultTasksStore.getState().quickAddOpen).toBe(true);
    unregister();
    expect(useVaultTasksStore.getState().quickAddHosts).toBe(0);
  });

  it("persists the layout and applies due presets", () => {
    useVaultTasksStore.getState().setMode("board");
    expect(JSON.parse(window.localStorage.getItem("aether-vaulttasks-prefs") ?? "{}").mode).toBe("board");
    useVaultTasksStore.getState().setQuery("milk");
    useVaultTasksStore.getState().showDuePreset("overdue");
    expect(useVaultTasksStore.getState()).toMatchObject({ mode: "list", due: "overdue", query: "" });
  });
});
