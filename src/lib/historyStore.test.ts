import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryActivity, HistoryStatus } from "../types";
import { mockEvents, mockInvoke, resetMockState, setMockLatency } from "./mock/backend";
import { MOCK_VAULT_ROOT } from "./mock/fixtures/vault";
import { mockVault } from "./mock/vaultStore";

// Route IPC through the DEV mock backend (the real Tauri runtime is absent).
vi.mock("./ipc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc/core")>();
  return {
    ...actual,
    call: (command: string, args?: Record<string, unknown>) =>
      mockInvoke(command, args ?? {}).catch((reason) => {
        throw new Error(String(reason));
      }),
    listenSafe: async (event: string, handler: (payload: unknown) => void) => mockEvents.listen(event, handler),
  };
});

const { initHistorySync, useHistoryStore, waitForEditorSave } = await import("./historyStore");
const { useAetherStore } = await import("./store");

const NOTE = `${MOCK_VAULT_ROOT}/00-Inbox/Quick Capture.md`;

const initial = useHistoryStore.getState();

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
  useHistoryStore.setState({ ...initial, recent: [], recentLoaded: false, status: null, revision: 0 }, true);
  useAetherStore.setState({ selectedNotePath: null, noteDirty: false, noteContent: null, view: "history" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("history store", () => {
  it("loads status and recent activity", async () => {
    await useHistoryStore.getState().refreshStatus();
    await useHistoryStore.getState().refreshRecent();
    const s = useHistoryStore.getState();
    expect(s.status?.enabled).toBe(true);
    expect(s.recentLoaded).toBe(true);
    expect(s.recent.length).toBeGreaterThan(10);
  });

  it("merges pushed commits once and bumps the revision", async () => {
    await useHistoryStore.getState().refreshRecent();
    const activity: HistoryActivity = {
      commit_id: "c".repeat(40),
      short_id: "ccccccc",
      time: Math.floor(Date.now() / 1000),
      message: "note: a.md",
      files: [],
      file_count: 0,
    };
    useHistoryStore.getState().applyCommit(activity);
    useHistoryStore.getState().applyCommit(activity);
    const s = useHistoryStore.getState();
    expect(s.recent[0].commit_id).toBe(activity.commit_id);
    expect(s.recent.filter((a) => a.commit_id === activity.commit_id)).toHaveLength(1);
    expect(s.revision).toBe(1);
  });

  it("toggles automatic versioning and snapshots", async () => {
    const off: HistoryStatus = await useHistoryStore.getState().setEnabled(false);
    expect(off.enabled).toBe(false);
    await expect(useHistoryStore.getState().snapshotNow(null)).rejects.toThrow(/turned off/);
    await useHistoryStore.getState().setEnabled(true);
    mockVault.write(NOTE, "fresh text\n");
    // The mock "watcher" commits on the next call, so an explicit snapshot finds nothing new.
    await useHistoryStore.getState().refreshStatus();
    expect(await useHistoryStore.getState().snapshotNow(NOTE)).toBeNull();
  });

  it("restores a version and updates the open note", async () => {
    useAetherStore.setState({ selectedNotePath: NOTE, view: "history" });
    const versions = await mockInvoke<{ id: string }[]>("cmd_history_list", { path: NOTE });
    const oldest = versions[versions.length - 1];
    const result = await useHistoryStore.getState().restore(NOTE, oldest);
    expect(useAetherStore.getState().noteContent).toBe(result.content);
    expect(mockVault.read(NOTE)).toBe(result.content);
    expect(useHistoryStore.getState().revision).toBeGreaterThan(0);
    expect(useHistoryStore.getState().recent[0].message).toMatch(/^restore: /);
  });

  it("waits for the editor's autosave before restoring", async () => {
    useAetherStore.setState({ selectedNotePath: NOTE, noteDirty: true });
    let settled = false;
    const wait = waitForEditorSave(NOTE, 1000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    useAetherStore.setState({ noteDirty: false });
    await wait;
    expect(settled).toBe(true);

    useAetherStore.setState({ noteDirty: true });
    await expect(waitForEditorSave(NOTE, 20)).rejects.toThrow(/unsaved changes/);
    await expect(waitForEditorSave(`${MOCK_VAULT_ROOT}/Other.md`, 20)).resolves.toBeUndefined();
  });

  it("keeps the status live through history-commit events", async () => {
    const stop = initHistorySync();
    await vi.waitFor(() => expect(useHistoryStore.getState().status).not.toBeNull());
    const before = useHistoryStore.getState().status!.commit_count;
    mockVault.write(NOTE, "edited in the editor\n");
    await mockInvoke("cmd_history_commit_now", { path: null });
    await vi.waitFor(() => expect(useHistoryStore.getState().status!.commit_count).toBe(before + 1));
    stop();
    stop();
  });
});
