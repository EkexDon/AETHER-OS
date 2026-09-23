import { beforeEach, describe, expect, it } from "vitest";
import { mockEvents, mockInvoke, resetMockState, setMockLatency } from "../mock/backend";
import { setSyncMockDelayScale } from "../mock/sync";
import type { SyncConflict, SyncProgress, SyncSettings, SyncStatus } from "../../types";

beforeEach(() => {
  setMockLatency(0);
  setSyncMockDelayScale(0);
  resetMockState();
});

describe("sync mock backend", () => {
  it("simulates two devices with one conflict", async () => {
    const status = await mockInvoke<SyncStatus>("cmd_sync_status");
    expect(status).toMatchObject({ unlocked: true, configured: true, conflicts: 1, state: "idle" });
    const devices = await mockInvoke<unknown[]>("cmd_sync_devices");
    expect(devices).toHaveLength(2);
    const conflicts = await mockInvoke<SyncConflict[]>("cmd_sync_list_conflicts");
    expect(conflicts[0].display_path).toBe("01-Projects/Local-first Sync.md");
  });

  it("streams progress during a round", async () => {
    const seen: SyncProgress[] = [];
    const off = mockEvents.listen<SyncProgress>("sync-progress", (p) => seen.push(p));
    await mockInvoke("cmd_sync_now");
    off();
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toMatchObject({ operation: "sync", done: seen.at(-1)!.total });
  });

  it("mirrors the Rust validation messages", async () => {
    await expect(mockInvoke("cmd_sync_set_settings", { patch: { interval_seconds: 5 } })).rejects.toMatch(/between 15 and 86400/);
    await expect(mockInvoke("cmd_sync_set_settings", { patch: { sync_dir: "relative" } })).rejects.toMatch(/absolute path/);
    await expect(mockInvoke("cmd_sync_resolve_conflict", { id: "x", keep: "local" })).rejects.toMatch(/conflict not found/);
    await expect(mockInvoke("cmd_sync_backup_restore", { path: "/nope", passphrase: "x", targetDir: "/tmp/x", mode: "overwrite" })).rejects.toMatch(/unknown restore mode/);
    await expect(mockInvoke("cmd_sync_change_passphrase", { oldPassphrase: "same same", newPassphrase: "same same" })).rejects.toMatch(/must be different/);
  });

  it("locks when the folder changes and requires a passphrase", async () => {
    const settings = await mockInvoke<SyncSettings>("cmd_sync_set_settings", { patch: { sync_dir: "/Users/demo/Dropbox/AETHER" } });
    expect(settings.remember_key).toBe(false);
    const status = await mockInvoke<SyncStatus>("cmd_sync_status");
    expect(status.state).toBe("locked");
    await expect(mockInvoke("cmd_sync_now")).rejects.toMatch(/locked/);
    await expect(mockInvoke("cmd_sync_unlock", { passphrase: "wrong one!", remember: false })).rejects.toMatch(/wrong passphrase/);
    await mockInvoke("cmd_sync_unlock", { passphrase: "the right one", remember: false });
    const folder = await mockInvoke<{ initialized: boolean }>("cmd_sync_inspect_folder", { path: "/Users/demo/Dropbox/AETHER" });
    expect(folder.initialized).toBe(true);
  });

  it("verifies, previews and restores backups", async () => {
    const [first] = await mockInvoke<{ path: string; files: number }[]>("cmd_sync_backup_list", { dir: "/Users/demo/Backups/AETHER" });
    await expect(mockInvoke("cmd_sync_backup_verify", { path: first.path, passphrase: "wrong!!!!" })).rejects.toMatch(/wrong passphrase for this backup/);
    const verified = await mockInvoke<{ ok: boolean }>("cmd_sync_backup_verify", { path: first.path, passphrase: "good passphrase" });
    expect(verified.ok).toBe(true);
    const preview = await mockInvoke<{ file_count: number }>("cmd_sync_backup_preview", { path: first.path, passphrase: "good passphrase" });
    expect(preview.file_count).toBeGreaterThan(0);
    const report = await mockInvoke<{ moved_existing_to: string | null }>("cmd_sync_backup_restore", {
      path: first.path,
      passphrase: "good passphrase",
      targetDir: "/Users/demo/Documents/Second-Brain",
      mode: "replace",
    });
    expect(report.moved_existing_to).toMatch(/Second-Brain\.pre-restore-/);
  });
});
