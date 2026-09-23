import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc/core")>();
  const mock = await import("./mock/backend");
  return {
    ...actual,
    call: (command: string, args?: Record<string, unknown>) => mock.mockInvoke(command, args ?? {}),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mock.mockEvents.listen(event, handler),
  };
});

import { mockEvents, resetMockState, setMockLatency } from "./mock/backend";
import { setSyncMockDelayScale } from "./mock/sync";
import { resetSyncStore, retainSyncEvents, useSyncStore } from "./syncStore";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setMockLatency(0);
  setSyncMockDelayScale(0);
  resetMockState();
  resetSyncStore();
});

describe("syncStore", () => {
  it("loads status, settings, conflicts and devices", async () => {
    await useSyncStore.getState().refresh();
    const s = useSyncStore.getState();
    expect(s.status?.unlocked).toBe(true);
    expect(s.settings?.device_name).toBe("Demo MacBook");
    expect(s.conflicts).toHaveLength(1);
    expect(s.devices).toHaveLength(2);
    expect(s.backupsDir).toBe("/Users/demo/Backups/AETHER");
  });

  it("keeps one event subscription while retained", async () => {
    const releaseA = retainSyncEvents();
    const releaseB = retainSyncEvents();
    await flush();
    expect(mockEvents.listenerCount("sync-status")).toBe(1);
    expect(mockEvents.listenerCount("sync-progress")).toBe(1);
    releaseA();
    releaseA();
    expect(mockEvents.listenerCount("sync-status")).toBe(1);
    releaseB();
    expect(mockEvents.listenerCount("sync-status")).toBe(0);
  });

  it("does not leak listeners when released before they are ready", async () => {
    const release = retainSyncEvents();
    release();
    const again = retainSyncEvents();
    await flush();
    expect(mockEvents.listenerCount("sync-status")).toBe(1);
    again();
    await flush();
    expect(mockEvents.listenerCount("sync-status")).toBe(0);
  });

  it("applies status and progress events", async () => {
    await useSyncStore.getState().refresh();
    const release = retainSyncEvents();
    await flush();
    mockEvents.emit("sync-progress", { operation: "sync", done: 2, total: 5 });
    expect(useSyncStore.getState().progress).toEqual({ operation: "sync", done: 2, total: 5 });
    const current = useSyncStore.getState().status!;
    mockEvents.emit("sync-status", { ...current, state: "locked", unlocked: false });
    expect(useSyncStore.getState().status?.state).toBe("locked");
    release();
  });

  it("refreshes conflicts after a round finishes", async () => {
    await useSyncStore.getState().refresh();
    useSyncStore.setState({ conflicts: [] });
    const current = useSyncStore.getState().status!;
    useSyncStore.getState().applyStatus({ ...current, state: "syncing" });
    useSyncStore.getState().applyStatus({ ...current, state: "idle" });
    await flush();
    await flush();
    expect(useSyncStore.getState().conflicts).toHaveLength(1);
  });

  it("resolves a conflict and updates the list", async () => {
    await useSyncStore.getState().refresh();
    const id = useSyncStore.getState().conflicts[0].id;
    await useSyncStore.getState().resolveConflict(id, "both");
    expect(useSyncStore.getState().conflicts[0].resolved).toBe(true);
    expect(useSyncStore.getState().status?.conflicts).toBe(0);
  });

  it("remembers the backups folder", async () => {
    await useSyncStore.getState().loadBackups("/Users/demo/Backups/AETHER");
    expect(useSyncStore.getState().backups).toHaveLength(4);
    expect(window.localStorage.getItem("aether-sync-backups-dir")).toBe("/Users/demo/Backups/AETHER");
    await useSyncStore.getState().loadBackups("/Users/demo/Elsewhere");
    expect(useSyncStore.getState().backups).toHaveLength(0);
  });
});
