import { beforeEach, describe, expect, it } from "vitest";
import type { ClipItem, ClipboardChangedEvent, ClipboardSettings, ClipboardStats } from "../../types";
import { mockEvents, mockInvoke, resetMockState, setMockLatency } from "../mock/backend";
import { mockCapture, mockMatches, mockPreview } from "../mock/clipboard";

const invoke = <T,>(command: string, args: Record<string, unknown> = {}) => mockInvoke<T>(command, args);
const list = (args: Record<string, unknown> = {}) => invoke<ClipItem[]>("cmd_clipboard_list", { pinnedOnly: false, ...args });

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
});

describe("clipboard mock", () => {
  it("seeds 40 clips of every kind, newest first", async () => {
    const items = await list({ limit: 500 });
    expect(items).toHaveLength(40);
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(["text", "url", "code", "image", "color"]));
    const times = items.map((i) => i.last_copied_at);
    expect([...times].sort().reverse()).toEqual(times);
    const stats = await invoke<ClipboardStats>("cmd_clipboard_stats");
    expect(stats).toMatchObject({ total: 40, paused: false, enabled: true, watcher_error: null });
    expect(stats.pinned).toBeGreaterThan(0);
    expect(stats.images).toBe(items.filter((i) => i.kind === "image").length);
  });

  it("filters by kind, pin state and query and pages", async () => {
    const code = await list({ kind: "code" });
    expect(code.length).toBeGreaterThan(3);
    expect(code.every((i) => i.kind === "code")).toBe(true);
    const pinned = await list({ pinnedOnly: true });
    expect(pinned.every((i) => i.pinned)).toBe(true);
    const apples = await list({ query: "apfel" });
    expect(apples.map((i) => i.preview)).toEqual([expect.stringContaining("Äpfel")]);
    expect((await list({ query: "SELECT notes" })).map((i) => i.kind)).toEqual(["code"]);
    const page = await list({ limit: 5, offset: 5 });
    expect(page).toHaveLength(5);
    expect(page[0].id).toBe((await list({ limit: 6 }))[5].id);
    await expect(list({ kind: "video" })).rejects.toBe("invalid input: unknown clip kind video");
  });

  it("copies, pins, deletes and clears with events", async () => {
    const events: ClipboardChangedEvent[] = [];
    const off = mockEvents.listen<ClipboardChangedEvent>("clipboard-changed", (e) => events.push(e));
    const items = await list({ limit: 500 });
    const last = items[items.length - 1];

    const copied = await invoke<ClipItem>("cmd_clipboard_copy", { id: last.id });
    expect(copied.copy_count).toBe(last.copy_count + 1);
    expect((await list({ limit: 1 }))[0].id).toBe(last.id);

    const pinned = await invoke<ClipItem>("cmd_clipboard_pin", { id: last.id, pinned: true });
    expect(pinned.pinned).toBe(true);

    await invoke("cmd_clipboard_delete", { id: items[0].id });
    await expect(invoke("cmd_clipboard_get", { id: items[0].id })).rejects.toMatch(/not found/);
    await expect(invoke("cmd_clipboard_get", { id: "../etc" })).rejects.toBe("invalid input: invalid clip id: ../etc");

    const pinnedCount = (await list({ pinnedOnly: true, limit: 500 })).length;
    const removed = await invoke<number>("cmd_clipboard_clear", { keepPinned: true });
    expect(removed).toBe(39 - pinnedCount);
    expect(await list({ limit: 500 })).toHaveLength(pinnedCount);
    expect(events.map((e) => e.reason)).toEqual(["copied", "updated", "deleted", "cleared"]);
    off();
  });

  it("validates and applies settings, pruning to max_items", async () => {
    const settings = await invoke<ClipboardSettings>("cmd_clipboard_get_settings");
    expect(settings).toEqual({ enabled: true, max_items: 500, keep_days: 30, capture_images: true });
    await expect(invoke("cmd_clipboard_set_settings", { settings: { ...settings, max_items: 3 } })).rejects.toBe(
      "invalid input: max_items must be between 10 and 10000"
    );
    await expect(invoke("cmd_clipboard_set_settings", { settings: { ...settings, keep_days: 9999 } })).rejects.toMatch(/keep_days/);
    await invoke("cmd_clipboard_set_settings", { settings: { ...settings, max_items: 10 } });
    const stats = await invoke<ClipboardStats>("cmd_clipboard_stats");
    expect(stats.total).toBe(10 + stats.pinned);
  });

  it("pause and disable stop the live feed", async () => {
    expect(await invoke<boolean>("cmd_clipboard_set_paused", { paused: true })).toBe(true);
    expect(mockCapture({ kind: "text", content: "while paused" })).toBeNull();
    await invoke("cmd_clipboard_set_paused", { paused: false });
    const captured = mockCapture({ kind: "text", content: "fresh copy" });
    expect(captured?.content).toBe("fresh copy");
    expect((await list({ limit: 1 }))[0].id).toBe(captured?.id);
    // Re-copying the same text bumps instead of duplicating.
    const again = mockCapture({ kind: "text", content: "fresh copy" });
    expect(again?.id).toBe(captured?.id);
    expect(again?.copy_count).toBe(2);
    // A skipped secret only increments the counter.
    expect(mockCapture(null)).toBeNull();
    expect((await invoke<ClipboardStats>("cmd_clipboard_stats")).skipped_secrets).toBe(1);
  });

  it("serves image data and saves notes into the mock vault", async () => {
    const image = (await list({ kind: "image" }))[0];
    const url = await invoke<string>("cmd_clipboard_image", { id: image.id, thumbnail: true });
    expect(url.startsWith("data:image/svg+xml")).toBe(true);
    const text = (await list({ kind: "text" }))[0];
    await expect(invoke("cmd_clipboard_image", { id: text.id, thumbnail: false })).rejects.toMatch(/not an image/);

    const path = await invoke<string>("cmd_clipboard_save_as_note", { id: text.id, title: "My: clip?" });
    expect(path.endsWith("/clipboard/My clip.md")).toBe(true);
    const content = await invoke<string>("cmd_get_note_content", { path });
    expect(content).toContain("source: clipboard");
    expect(content).toContain("# My clip");
  });

  it("copy_latest copies the newest clip", async () => {
    const newest = (await list({ limit: 1 }))[0];
    const copied = await invoke<ClipItem>("cmd_clipboard_copy_latest");
    expect(copied.id).toBe(newest.id);
    await invoke("cmd_clipboard_clear", { keepPinned: false });
    expect(await invoke("cmd_clipboard_copy_latest")).toBeNull();
  });
});

describe("mock search helpers", () => {
  it("matches prefixes, phrases and symbols", () => {
    const code = { kind: "code" as const, content: "const add = (a, b) => a + b;", preview: "" };
    expect(mockMatches(code, "con ad")).toBe(true);
    expect(mockMatches(code, "=>")).toBe(true);
    expect(mockMatches(code, "sub")).toBe(false);
    expect(mockMatches({ kind: "image", content: "/x.png", preview: "640x480" }, "image")).toBe(true);
    expect(mockPreview("\n  hello   world\nsecond")).toBe("hello world");
  });
});
