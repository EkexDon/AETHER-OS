import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/core")>();
  const mock = await import("../mock/backend");
  return {
    ...actual,
    call: (command: string, args?: Record<string, unknown>) => mock.mockInvoke(command, args ?? {}),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mock.mockEvents.listen(event, handler),
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./pickFolder", () => ({ pickFolder: vi.fn(async () => "/Users/demo/Picked"), pickBackupFile: vi.fn(async () => null) }));

import { mockInvoke, resetMockState, setMockLatency } from "../mock/backend";
import { setSyncMockDelayScale } from "../mock/sync";
import { resetSyncStore, useSyncStore } from "../syncStore";
import { runBackupNow, runSyncNow, syncCommands } from "./commands";

function ctx() {
  return {
    setView: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn(), clear: vi.fn() },
  } as unknown as Parameters<typeof runSyncNow>[0] & { setView: ReturnType<typeof vi.fn>; toast: Record<string, ReturnType<typeof vi.fn>> };
}

beforeEach(() => {
  setMockLatency(0);
  setSyncMockDelayScale(0);
  resetMockState();
  resetSyncStore();
});

describe("sync commands", () => {
  it("registers the palette commands with unique shortcuts", () => {
    expect(syncCommands.map((c) => c.id)).toEqual(["sync.now", "sync.lock", "sync.unlock", "backup.create"]);
    expect(syncCommands.map((c) => c.shortcut)).toEqual(["mod+alt+y", "mod+alt+l", undefined, "mod+alt+shift+b"]);
  });

  it("syncs when unlocked and reports the result", async () => {
    const c = ctx();
    await runSyncNow(c);
    expect(c.toast.success).toHaveBeenCalledWith("Sync finished", { description: "1 upload · 2 downloads" });
    expect(useSyncStore.getState().lastReport?.downloaded).toBe(2);
  });

  it("asks for the passphrase when locked", async () => {
    await mockInvoke("cmd_sync_lock", {});
    const c = ctx();
    await runSyncNow(c);
    expect(useSyncStore.getState().unlockOpen).toBe(true);
    expect(c.toast.success).not.toHaveBeenCalled();
  });

  it("opens the setup wizard when no folder is configured", async () => {
    await mockInvoke("cmd_sync_set_settings", { patch: { enabled: false, sync_dir: "" } });
    const c = ctx();
    await runSyncNow(c);
    expect(c.setView).toHaveBeenCalledWith("sync");
    expect(useSyncStore.getState().setupOpen).toBe(true);
  });

  it("backs up into the configured folder", async () => {
    const c = ctx();
    await runBackupNow(c);
    expect(c.toast.success).toHaveBeenCalledWith("Backup created", expect.objectContaining({ description: expect.stringMatching(/^aether-backup-.*\.aetherbak · \d+ files$/) }));
    const list = (await mockInvoke("cmd_sync_backup_list", { dir: "/Users/demo/Backups/AETHER" })) as unknown[];
    expect(list).toHaveLength(5);
  });

  it("refuses to back up while locked", async () => {
    await mockInvoke("cmd_sync_lock", {});
    const c = ctx();
    await runBackupNow(c);
    expect(c.toast.info).toHaveBeenCalledWith("Unlock first", expect.anything());
    expect(useSyncStore.getState().unlockOpen).toBe(true);
  });

  it("lock command clears conflicts and devices", async () => {
    await useSyncStore.getState().refresh();
    expect(useSyncStore.getState().conflicts).toHaveLength(1);
    const c = ctx();
    await syncCommands.find((x) => x.id === "sync.lock")!.run(c as never);
    expect(useSyncStore.getState().status?.unlocked).toBe(false);
    expect(useSyncStore.getState().conflicts).toHaveLength(0);
    expect(c.toast.success).toHaveBeenCalledWith("Sync locked", expect.anything());
  });
});
