import { describe, expect, it, vi } from "vitest";
import { noteReloadSubscriberCount, requestNoteReload, subscribeNoteReload } from "./noteEditorBus";

describe("noteEditorBus", () => {
  it("delivers reload requests to every subscriber and unsubscribes cleanly", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeNoteReload(a);
    const offB = subscribeNoteReload(b);
    requestNoteReload("/vault/Note.md");
    expect(a).toHaveBeenCalledWith("/vault/Note.md");
    expect(b).toHaveBeenCalledWith("/vault/Note.md");
    offA();
    requestNoteReload("/vault/Other.md");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
    expect(noteReloadSubscriberCount()).toBe(0);
  });

  it("keeps notifying when one subscriber throws", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const offBad = subscribeNoteReload(bad);
    const offGood = subscribeNoteReload(good);
    expect(() => requestNoteReload("/vault/Note.md")).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    offBad();
    offGood();
  });
});
