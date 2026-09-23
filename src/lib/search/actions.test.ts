import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/core")>();
  const mock = await import("../mock/backend");
  return {
    ...actual,
    isDesktopRuntime: () => true,
    call: (command: string, args?: Record<string, unknown>) => mock.mockInvoke(command, args ?? {}),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mock.mockEvents.listen(event, handler),
  };
});

import { mockInvoke, resetMockState, setMockLatency } from "../mock/backend";
import type { RecentHit, SearchHit } from "../../types";
import { useAetherStore } from "../store";
import { useIdeStore } from "../ideStore";
import { useShellStore } from "../../shell/shellStore";
import { useSearchStore } from "../searchStore";
import { useToastStore } from "../../ui/Toast";
import { editorLabel, openBookmark, openHit, openInIde } from "./actions";

const search = (q: string, kinds: string[]) =>
  mockInvoke<SearchHit[]>("cmd_search_query", { q, kinds, limit: 5, perKind: null, semantic: false });

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
  useToastStore.getState().clear();
  useShellStore.setState({ commandBarOpen: true });
  useAetherStore.setState({
    view: "dashboard",
    vaultPath: "/Users/demo/Documents/Second-Brain",
    selectedProjectId: null,
    selectedTaskId: null,
    taskDetailModalOpen: false,
    chatOpen: false,
  });
  useIdeStore.setState({ rootPath: null, tabs: [], activePath: null });
});

describe("openHit", () => {
  it("opens projects and files in the IDE and records a recent", async () => {
    const [project] = await search("aether", ["project"]);
    await openHit(project);
    expect(useIdeStore.getState().rootPath).toBe(project.path);
    expect(useAetherStore.getState().view).toBe("ide");
    expect(useShellStore.getState().commandBarOpen).toBe(false);

    const [file] = await search("readme", ["file"]);
    await openHit(file);
    expect(useIdeStore.getState().activePath).toBe(file.path);
    await vi.waitFor(async () => {
      const recents = await mockInvoke<RecentHit[]>("cmd_search_recents_list", { limit: 5 });
      expect(recents.map((r) => r.id)).toContain(file.id);
    });
  });

  it("opens notes in the editor, or raw in the IDE with mod+Enter", async () => {
    const [note] = await search("ownership", ["note"]);
    await openHit(note);
    expect(useAetherStore.getState()).toMatchObject({ view: "editor", selectedNotePath: note.path });
    await openHit(note, { alternate: true });
    expect(useIdeStore.getState()).toMatchObject({ rootPath: "/Users/demo/Documents/Second-Brain", activePath: note.path });
  });

  it("jumps to the calendar day, the task board and the memory view", async () => {
    const events = await mockInvoke<SearchHit[]>("cmd_search_query", { q: "a", kinds: ["event"], limit: 1, perKind: null, semantic: false });
    await openHit(events[0]);
    expect(useAetherStore.getState()).toMatchObject({ view: "calendar", calendarView: "day", calendarDate: events[0].extra?.date });

    const tasks = await mockInvoke<SearchHit[]>("cmd_search_query", { q: "a", kinds: ["task"], limit: 1, perKind: null, semantic: false });
    await openHit(tasks[0]);
    expect(useAetherStore.getState()).toMatchObject({
      view: "tasks",
      selectedProjectId: tasks[0].extra?.project_id,
      selectedTaskId: tasks[0].extra?.task_id,
      taskDetailModalOpen: true,
    });

    const [memory] = await search("berlin", ["memory"]);
    await openHit(memory);
    expect(useAetherStore.getState().view).toBe("memory");
    await openHit(memory, { alternate: true });
    expect(useSearchStore.getState()).toMatchObject({ viewSelectedId: memory.id, viewTab: "memory" });
    expect(useAetherStore.getState().view).toBe("search");
  });

  it("launches apps and surfaces failures as toasts", async () => {
    const [zed] = await search("zed", ["app"]);
    await expect(openHit(zed)).resolves.toBeUndefined();
    const broken: SearchHit = { ...zed, path: "/tmp/Evil.app", title: "Evil" };
    await expect(openHit(broken)).rejects.toThrow(/outside the application folders/);
    expect(useToastStore.getState().toasts.some((t) => t.title === "Could not open Evil")).toBe(true);
  });

  it("refuses to switch IDE folders over unsaved changes", async () => {
    useIdeStore.setState({
      rootPath: "/somewhere",
      tabs: [{ path: "/somewhere/a.ts", name: "a.ts", content: "changed", savedContent: "orig", language: "typescript" }],
      activePath: "/somewhere/a.ts",
    });
    await expect(openInIde("/Users/demo/Developer/aether-demo-app")).rejects.toThrow(/unsaved changes/);
    expect(useIdeStore.getState().rootPath).toBe("/somewhere");
  });

  it("opens bookmarks in the system browser", async () => {
    await openBookmark("https://tauri.app", "Tauri");
    expect(useToastStore.getState().toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(editorLabel("code")).toBe("VS Code");
    expect(editorLabel("zed")).toBe("zed");
  });
});
