import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke, resetMockState, setMockLatency } from "./backend";

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
});

describe("sync mock error categories", () => {
  it("reports key problems as crypto errors and state problems as sync errors, like the backend", async () => {
    vi.useFakeTimers();
    try {
      const unlock = mockInvoke("cmd_sync_unlock", { passphrase: "definitely wrong", remember: false });
      const assertion = expect(unlock).rejects.toMatch(/^crypto error: wrong passphrase$/);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    await mockInvoke("cmd_sync_lock");
    await expect(mockInvoke("cmd_sync_devices")).rejects.toMatch(/^sync error: unlock sync to see the other devices$/);
    await expect(mockInvoke("cmd_sync_now")).rejects.toMatch(/^sync error: sync is locked/);
  });

  it("keeps plain validation failures as invalid input", async () => {
    await expect(mockInvoke("cmd_sync_backup_list", { dir: "relative/path" })).rejects.toMatch(/^invalid input: /);
  });
});
