import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAetherStore } from "../store";
import { hasWikilink, linkAppendText, noteNameFromPath, reloadOpenNote, waitForCleanNote } from "./noteEdits";
import { parseTaskLine, toggleTaskLine } from "./taskLine";

beforeEach(() => {
  useAetherStore.setState({ selectedNotePath: null, noteDirty: false, openNoteTabs: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("link insertion text", () => {
  it("starts a new paragraph after prose", () => {
    expect(linkAppendText("# Note\n\nSome text.\n", "Rust")).toBe("\n[[Rust]]");
    expect(linkAppendText("Some text", "Rust")).toBe("\n[[Rust]]");
  });

  it("continues link lists and link-only lines", () => {
    expect(linkAppendText("Related:\n- [[A]]\n", "B")).toBe("- [[B]]");
    expect(linkAppendText("* [[A]]", "B")).toBe("* [[B]]");
    expect(linkAppendText("text\n\n[[A]] [[C]]\n", "B")).toBe("[[B]]");
  });

  it("needs no separator in empty notes or after a blank line", () => {
    expect(linkAppendText("", "B")).toBe("[[B]]");
    expect(linkAppendText("text\n\n", "B")).toBe("[[B]]");
  });

  it("detects existing links case-insensitively with aliases", () => {
    expect(hasWikilink("see [[rust ownership|here]]", "Rust Ownership")).toBe(true);
    expect(hasWikilink("see [[Other]]", "Rust")).toBe(false);
    expect(noteNameFromPath("/v/03-Resources/Rust Ownership.md")).toBe("Rust Ownership");
  });
});

describe("editor coordination", () => {
  it("resolves immediately for notes that are not being edited", async () => {
    useAetherStore.setState({ selectedNotePath: "/v/a.md", noteDirty: true });
    await expect(waitForCleanNote("/v/b.md")).resolves.toBeUndefined();
  });

  it("waits until the editor saved", async () => {
    useAetherStore.setState({ selectedNotePath: "/v/a.md", noteDirty: true });
    let done = false;
    const wait = waitForCleanNote("/v/a.md").then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    useAetherStore.setState({ noteDirty: false });
    await wait;
    expect(done).toBe(true);
  });

  it("gives up with a readable error", async () => {
    vi.useFakeTimers();
    useAetherStore.setState({ selectedNotePath: "/v/a.md", noteDirty: true });
    const wait = waitForCleanNote("/v/a.md", 1_000);
    vi.advanceTimersByTime(1_001);
    await expect(wait).rejects.toThrow(/unsaved changes/);
  });

  it("reloads the open note by reselecting it", async () => {
    useAetherStore.setState({ selectedNotePath: "/v/a.md", openNoteTabs: ["/v/a.md"] });
    const seen: (string | null)[] = [];
    const unsubscribe = useAetherStore.subscribe((s) => seen.push(s.selectedNotePath));
    await reloadOpenNote("/v/a.md");
    unsubscribe();
    expect(seen).toEqual([null, "/v/a.md"]);
    expect(useAetherStore.getState().openNoteTabs).toEqual(["/v/a.md"]);
    // Other notes are left alone.
    await reloadOpenNote("/v/other.md");
    expect(useAetherStore.getState().selectedNotePath).toBe("/v/a.md");
  });
});

describe("task line toggle (mirrors approvals.rs)", () => {
  const content = "# Todo\n- [ ] buy milk\n  * [x] nested done\n1. [ ] numbered\r\n- not a task\n";

  it("flips exactly one checkbox and keeps line endings", () => {
    const first = toggleTaskLine(content, 2);
    expect(first).toMatchObject({ checked: true, text: "buy milk" });
    expect(first.content).toBe("# Todo\n- [x] buy milk\n  * [x] nested done\n1. [ ] numbered\r\n- not a task\n");
    expect(toggleTaskLine(first.content, 3).content).toContain("  * [ ] nested done\n");
    expect(toggleTaskLine(content, 4).content).toContain("1. [x] numbered\r\n");
  });

  it("rejects lines that are not tasks or do not exist", () => {
    expect(() => toggleTaskLine(content, 5)).toThrow(/not a Markdown task/);
    expect(() => toggleTaskLine(content, 1)).toThrow();
    expect(() => toggleTaskLine(content, 0)).toThrow(/does not exist/);
    expect(() => toggleTaskLine(content, 99)).toThrow(/does not exist/);
    expect(parseTaskLine("- [?] odd")).toBeNull();
  });
});
