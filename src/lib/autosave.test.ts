import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosaveScheduler } from "./autosave";

describe("createAutosaveScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves the content for the note it was scheduled with, not the current one", async () => {
    const save = vi.fn(async () => {});
    const s = createAutosaveScheduler({ delayMs: 1200, save });
    s.schedule("/vault/A.md", "text for A");
    // The user switches to B before the timer fires; the editor flushes.
    await s.flushIfNot("/vault/B.md");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("/vault/A.md", "text for A");
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1); // timer was cleared by the flush
  });

  it("debounces repeated edits of the same note", async () => {
    const save = vi.fn(async () => {});
    const s = createAutosaveScheduler({ delayMs: 500, save });
    s.schedule("/vault/A.md", "1");
    s.schedule("/vault/A.md", "12");
    s.schedule("/vault/A.md", "123");
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("/vault/A.md", "123");
    expect(s.pending()).toBeNull();
  });

  it("flushIfNot is a no-op when the pending save belongs to the current note", async () => {
    const save = vi.fn(async () => {});
    const s = createAutosaveScheduler({ delayMs: 500, save });
    s.schedule("/vault/A.md", "draft");
    await s.flushIfNot("/vault/A.md");
    expect(save).not.toHaveBeenCalled();
    expect(s.pending()?.content).toBe("draft");
  });

  it("cancel drops the pending save and flush without pending does nothing", async () => {
    const save = vi.fn(async () => {});
    const s = createAutosaveScheduler({ delayMs: 500, save });
    s.schedule("/vault/A.md", "draft");
    s.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    await s.flush();
    expect(save).not.toHaveBeenCalled();
  });
});
