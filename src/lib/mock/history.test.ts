import { beforeEach, describe, expect, it } from "vitest";
import type { FileDiff, HistoryActivity, HistoryRestore, HistoryStatus, NoteVersion } from "../../types";
import { mockEvents, mockInvoke, resetMockState, setMockLatency } from "./backend";
import { MOCK_VAULT_ROOT } from "./fixtures/vault";
import { mockVault } from "./vaultStore";

const invoke = <T,>(command: string, args: Record<string, unknown> = {}) => mockInvoke<T>(command, args);
const NOTE = `${MOCK_VAULT_ROOT}/01-Projects/AETHER-OS.md`;

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
});

describe("mock note history", () => {
  it("seeds a clean, realistic history for the demo vault", async () => {
    const status = await invoke<HistoryStatus>("cmd_history_status");
    expect(status).toMatchObject({ enabled: true, watching: true, branch: "main", vault_path: MOCK_VAULT_ROOT });
    expect(status.commit_count).toBeGreaterThan(20);

    const recent = await invoke<HistoryActivity[]>("cmd_history_recent", { limit: 500 });
    expect(recent.length).toBe(status.commit_count);
    expect(recent[recent.length - 1].message).toMatch(/^notes: initial snapshot/);
    expect(recent.some((a) => a.message.startsWith("restore: "))).toBe(true);
    expect(recent.some((a) => a.message === "notes: 3 files")).toBe(true);
    expect(recent.some((a) => a.files.some((f) => f.change === "deleted"))).toBe(true);
    // Newest first, and the newest version of each note equals the vault.
    expect(recent[0].time).toBeGreaterThanOrEqual(recent[1].time);
    const versions = await invoke<NoteVersion[]>("cmd_history_list", { path: NOTE });
    const latest = await invoke<string>("cmd_history_read", { path: NOTE, commitId: versions[0].id });
    expect(latest).toBe(mockVault.read(NOTE));
  });

  it("lists versions with stats and diffs them", async () => {
    const versions = await invoke<NoteVersion[]>("cmd_history_list", { path: NOTE });
    expect(versions.length).toBeGreaterThanOrEqual(4);
    expect(versions[versions.length - 1].change).toBe("added");
    expect(versions.every((v) => v.summary_added + v.summary_removed > 0)).toBe(true);

    const diff = await invoke<FileDiff>("cmd_history_diff", { path: NOTE, from: null, to: versions[0].id });
    expect(diff.old_content).not.toBe(diff.new_content);
    const vsCurrent = await invoke<FileDiff>("cmd_history_diff", { path: NOTE, from: versions[0].id, to: null });
    expect(vsCurrent.old_content).toBe(vsCurrent.new_content);
    const limited = await invoke<NoteVersion[]>("cmd_history_list", { path: NOTE, limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it("commits vault edits like the watcher and emits history-commit", async () => {
    const before = await invoke<HistoryStatus>("cmd_history_status");
    const events: HistoryActivity[] = [];
    const unlisten = mockEvents.listen<HistoryActivity>("history-commit", (a) => events.push(a));
    await invoke("cmd_write_note", { path: NOTE, content: "# AETHER-OS\n\nRewritten.\n" });

    const after = await invoke<HistoryStatus>("cmd_history_status");
    expect(after.commit_count).toBe(before.commit_count + 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ message: "note: 01-Projects/AETHER-OS.md", file_count: 1 });
    expect(events[0].files[0]).toMatchObject({ path: NOTE, change: "modified" });
    expect(await invoke("cmd_history_commit_now", { path: null })).toBeNull();
    unlisten();
  });

  it("restores an old version and records it", async () => {
    const versions = await invoke<NoteVersion[]>("cmd_history_list", { path: NOTE });
    const oldest = versions[versions.length - 1];
    const oldContent = await invoke<string>("cmd_history_read", { path: NOTE, commitId: oldest.short_id });
    const result = await invoke<HistoryRestore>("cmd_history_restore", { path: NOTE, commitId: oldest.id });
    expect(result.content).toBe(oldContent);
    expect(mockVault.read(NOTE)).toBe(oldContent);
    expect(result.commit_id).not.toBeNull();

    const next = await invoke<NoteVersion[]>("cmd_history_list", { path: NOTE });
    expect(next[0].message).toBe(`restore: 01-Projects/AETHER-OS.md to ${oldest.short_id}`);
    const again = await invoke<HistoryRestore>("cmd_history_restore", { path: NOTE, commitId: oldest.id });
    expect(again.commit_id).toBeNull();
  });

  it("brings back a deleted note", async () => {
    const path = `${MOCK_VAULT_ROOT}/00-Inbox/Scratchpad.md`;
    expect(mockVault.hasFile(path)).toBe(false);
    const versions = await invoke<NoteVersion[]>("cmd_history_list", { path });
    expect(versions[0].change).toBe("deleted");
    await expect(invoke("cmd_history_restore", { path, commitId: versions[0].id })).rejects.toMatch(/does not exist/);
    await invoke("cmd_history_restore", { path, commitId: versions[1].id });
    expect(mockVault.read(path)).toContain("compare Obsidian sync vs git");
  });

  it("stops recording while disabled", async () => {
    const off = await invoke<HistoryStatus>("cmd_history_set_enabled", { enabled: false });
    expect(off).toMatchObject({ enabled: false, watching: false });
    await invoke("cmd_write_note", { path: NOTE, content: "changed while off\n" });
    const status = await invoke<HistoryStatus>("cmd_history_status");
    expect(status.commit_count).toBe(off.commit_count);
    await expect(invoke("cmd_history_commit_now", { path: null })).rejects.toMatch(/turned off/);

    const on = await invoke<HistoryStatus>("cmd_history_set_enabled", { enabled: true });
    expect(on.commit_count).toBe(off.commit_count + 1);
  });

  it("validates paths and version ids like the backend", async () => {
    await expect(invoke("cmd_history_list", { path: "/etc/passwd" })).rejects.toMatch(/outside the vault/);
    await expect(invoke("cmd_history_list", { path: "../x.md" })).rejects.toMatch(/traversal/);
    await expect(invoke("cmd_history_list", { path: ".git/config" })).rejects.toMatch(/hidden/);
    await expect(invoke("cmd_history_read", { path: NOTE, commitId: "zz" })).rejects.toMatch(/invalid version id/);
    await expect(invoke("cmd_history_read", { path: NOTE, commitId: "ffffffff" })).rejects.toMatch(/unknown version/);
    await expect(invoke("cmd_history_list", {})).rejects.toMatch(/missing required key path/);
    const relative = await invoke<NoteVersion[]>("cmd_history_list", { path: "01-Projects/AETHER-OS.md" });
    expect(relative.length).toBeGreaterThan(0);
  });
});
