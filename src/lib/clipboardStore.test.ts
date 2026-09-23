import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipItem } from "../types";

// Route the typed IPC wrappers to the DEV mock backend.
vi.mock("./ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc/core")>();
  const mock = await import("./mock/backend");
  return {
    ...actual,
    call: (command: string, args?: Record<string, unknown>) => mock.mockInvoke(command, args ?? {}),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mock.mockEvents.listen(event, handler),
  };
});

import { mockInvoke, resetMockState, setMockLatency } from "./mock/backend";
import { mockCapture } from "./mock/clipboard";
import {
  SEARCH_DEBOUNCE_MS,
  UNDO_DELETE_MS,
  attachClipboardView,
  resetClipboardStore,
  selectedClip,
  useClipboardStore,
  visibleClips,
} from "./clipboardStore";
import { useToastStore } from "../ui/Toast";

const store = () => useClipboardStore.getState();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  setMockLatency(0);
  resetMockState();
  await resetClipboardStore();
  useToastStore.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("clipboardStore", () => {
  it("loads the first page and selects the newest clip", async () => {
    await store().refresh();
    expect(store().loaded).toBe(true);
    expect(store().items).toHaveLength(40);
    expect(store().hasMore).toBe(false);
    expect(store().selectedId).toBe(store().items[0].id);
  });

  it("moves the selection within bounds", async () => {
    await store().refresh();
    const ids = store().items.map((i) => i.id);
    store().moveSelection(1);
    expect(store().selectedId).toBe(ids[1]);
    store().moveSelection(-5);
    expect(store().selectedId).toBe(ids[0]);
    store().moveSelection(1000);
    expect(store().selectedId).toBe(ids[ids.length - 1]);
  });

  it("filters by kind and debounces the search", async () => {
    vi.useFakeTimers();
    store().setKind("code");
    await vi.runAllTimersAsync();
    expect(store().items.every((i) => i.kind === "code")).toBe(true);

    store().setKind("all");
    await vi.runAllTimersAsync();
    store().setQuery("r");
    store().setQuery("ru");
    store().setQuery("rusqlite");
    expect(store().query).toBe("rusqlite");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 5);
    expect(store().items.map((i) => i.content)).toEqual(["https://docs.rs/rusqlite/latest/rusqlite/"]);
  });

  it("copies a clip, moves it to the top and toasts", async () => {
    await store().refresh();
    const last = store().items[store().items.length - 1];
    await store().copy(last.id);
    expect(store().items[0].id).toBe(last.id);
    expect(store().items[0].copy_count).toBe(last.copy_count + 1);
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: "success", title: "Copied" });
  });

  it("toggles pins and drops unpinned clips from the pinned filter", async () => {
    store().setPinnedOnly(true);
    await flush();
    await store().refresh();
    const first = store().items[0];
    expect(first.pinned).toBe(true);
    await store().togglePin(first.id);
    expect(store().items.some((i) => i.id === first.id)).toBe(false);
  });

  it("deletes with undo and commits after the undo window", async () => {
    await store().refresh();
    vi.useFakeTimers();
    const [a, b, c] = store().items;
    store().select(a.id);
    store().deleteWithUndo(a.id);
    expect(visibleClips(store()).some((i) => i.id === a.id)).toBe(false);
    expect(store().selectedId).toBe(b.id);
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.title).toBe("Clip deleted");

    // Undo restores it.
    toast?.action?.onClick();
    expect(visibleClips(store())[0].id).toBe(a.id);
    expect(store().selectedId).toBe(a.id);
    await vi.advanceTimersByTimeAsync(UNDO_DELETE_MS + 10);
    await expect(mockInvoke("cmd_clipboard_get", { id: a.id })).resolves.toBeTruthy();

    // Without undo it is deleted for real.
    store().deleteWithUndo(c.id);
    await vi.advanceTimersByTimeAsync(UNDO_DELETE_MS + 10);
    await expect(mockInvoke("cmd_clipboard_get", { id: c.id })).rejects.toMatch(/not found/);
    expect(store().items.some((i) => i.id === c.id)).toBe(false);
    expect(store().pendingDeletes).toEqual([]);
  });

  it("pauses, clears and saves settings", async () => {
    await store().refreshStats();
    await store().togglePaused();
    expect(store().stats?.paused).toBe(true);
    await store().togglePaused();
    expect(store().stats?.paused).toBe(false);

    await store().refresh();
    const removed = await store().clear(true);
    expect(removed).toBeGreaterThan(0);
    expect(store().items.every((i) => i.pinned)).toBe(true);

    await store().loadSettings();
    const saved = await store().saveSettings({ ...store().settings!, keep_days: 0 });
    expect(saved.keep_days).toBe(0);
    await expect(store().saveSettings({ ...saved, max_items: 1 })).rejects.toThrow(/max_items/);
  });

  it("caches images and full details", async () => {
    await store().refresh();
    const image = store().items.find((i) => i.kind === "image") as ClipItem;
    const url = await store().loadImage(image.id, true);
    expect(url).toMatch(/^data:image/);
    expect(store().images[`${image.id}:thumb`]).toBe(url);
    const text = store().items.find((i) => i.kind === "text") as ClipItem;
    expect(await store().loadImage(text.id, true)).toBeNull();
    const detail = await store().loadDetail(text.id);
    expect(detail?.content).toBe(text.content);
    expect(store().details[text.id]).toBeDefined();
  });

  it("refreshes live when the backend reports a capture", async () => {
    vi.useFakeTimers();
    const detach = attachClipboardView();
    await vi.runAllTimersAsync();
    const captured = mockCapture({ kind: "text", content: "copied elsewhere" });
    await vi.advanceTimersByTimeAsync(200);
    expect(store().items[0].id).toBe(captured?.id);
    expect(store().stats?.total).toBe(41);
    detach();
  });

  it("selectedClip ignores hidden clips", async () => {
    await store().refresh();
    const first = store().items[0];
    expect(selectedClip(store())?.id).toBe(first.id);
    useClipboardStore.setState({ pendingDeletes: [first.id] });
    expect(selectedClip(store())).toBeNull();
  });
});
