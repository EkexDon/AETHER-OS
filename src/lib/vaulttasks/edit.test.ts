import { describe, expect, it } from "vitest";
import {
  appendTaskToContent,
  applyDue,
  applyPriority,
  applyStatus,
  composeTaskText,
  isStaleTaskError,
  MAX_TASK_TEXT,
  withStatus,
} from "./edit";
import { parseTasks } from "./parser";

const TODAY = "2026-09-22";
const status = (content: string, line: number, text: string, s: Parameters<typeof applyStatus>[4]) =>
  applyStatus(content, "/v/n.md", line, text, s, TODAY);

describe("applyStatus", () => {
  it("rewrites only the status character", () => {
    const content = "# Head\r\n\t* [ ] Keep   spacing  #tag   \r\nother line\n";
    const checked = status(content, 1, "Keep   spacing  #tag", "done");
    expect(checked).toBe("# Head\r\n\t* [x] Keep   spacing  #tag   \r\nother line\n");
    expect(status(checked, 1, "Keep   spacing  #tag", "todo")).toBe(content);
  });

  it("appends and removes the done date in emoji-style notes", () => {
    const content = "- [ ] Pay rent 📅 2026-09-30 ^rent\n- [ ] other\n";
    const done = status(content, 0, "Pay rent 📅 2026-09-30 ^rent", "done");
    expect(done).toBe("- [x] Pay rent 📅 2026-09-30 ✅ 2026-09-22 ^rent\n- [ ] other\n");
    expect(status(done, 0, "Pay rent 📅 2026-09-30 ✅ 2026-09-22 ^rent", "todo")).toBe(content);
  });

  it("does not add dates to plain notes", () => {
    expect(status("- [ ] plain due:2026-09-30\n", 0, "plain due:2026-09-30", "done")).toBe(
      "- [x] plain due:2026-09-30\n"
    );
  });

  it("writes progress / cancelled characters and keeps an existing X", () => {
    expect(status("1. [ ] step\n", 0, "step", "in_progress")).toBe("1. [/] step\n");
    expect(status("1. [ ] step\n", 0, "step", "cancelled")).toBe("1. [-] step\n");
    expect(status("- [X] big\n", 0, "big", "done")).toBe("- [X] big\n");
    expect(status("- [✓] odd\n", 0, "odd", "done")).toBe("- [x] odd\n");
  });

  it("rejects stale lines", () => {
    let error: unknown;
    try {
      status("- [ ] one\n- [ ] two\n", 0, "two", "done");
    } catch (e) {
      error = e;
    }
    expect(isStaleTaskError(error)).toBe(true);
    expect(() => status("- [ ] one\n", 5, "one", "done")).toThrow(/note changed, rescan/);
    expect(() => status("```\n- [ ] code\n```\n", 1, "code", "done")).toThrow(/note changed/);
  });

  it("preserves a BOM", () => {
    expect(status("﻿- [ ] a\n", 0, "a", "done")).toBe("﻿- [x] a\n");
  });
});

describe("applyDue", () => {
  const edit = (c: string, text: string, due: string | null) => applyDue(c, "/v/n.md", 0, text, due);

  it("keeps the syntax of an existing marker", () => {
    expect(edit("- [ ] a 📅 2026-09-30 #x\n", "a 📅 2026-09-30 #x", "2026-10-01")).toBe("- [ ] a 📅 2026-10-01 #x\n");
    expect(edit("- [ ] a (due: 2026-09-30)\n", "a (due: 2026-09-30)", "2026-10-01")).toBe(
      "- [ ] a (due: 2026-10-01)\n"
    );
    expect(edit("- [ ] a due:2026-09-30 b\n", "a due:2026-09-30 b", null)).toBe("- [ ] a b\n");
  });

  it("adds new markers before the done date and block ids", () => {
    expect(edit("- [ ] a\n", "a", "2026-10-01")).toBe("- [ ] a 📅 2026-10-01\n");
    expect(edit("- [x] a ✅ 2026-09-20 ^id\n", "a ✅ 2026-09-20 ^id", "2026-10-01")).toBe(
      "- [x] a 📅 2026-10-01 ✅ 2026-09-20 ^id\n"
    );
    expect(applyDue("- [ ] a\n- [ ] b due:2026-09-01\n", "/v/n.md", 0, "a", "2026-10-01")).toBe(
      "- [ ] a due:2026-10-01\n- [ ] b due:2026-09-01\n"
    );
  });
});

describe("applyPriority", () => {
  const edit = (c: string, text: string, p: Parameters<typeof applyPriority>[4]) =>
    applyPriority(c, "/v/n.md", 0, text, p);

  it("replaces, removes and inserts markers", () => {
    expect(edit("- [ ] a 🔼 📅 2026-09-30\n", "a 🔼 📅 2026-09-30", "urgent")).toBe("- [ ] a 🔺 📅 2026-09-30\n");
    expect(edit("- [ ] a !low\n", "a !low", "high")).toBe("- [ ] a !high\n");
    expect(edit("- [ ] a ⏫ b\n", "a ⏫ b", "none")).toBe("- [ ] a b\n");
    expect(edit("- [ ] a 📅 2026-09-30\n", "a 📅 2026-09-30", "high")).toBe("- [ ] a ⏫ 📅 2026-09-30\n");
    expect(edit("- [ ] a due:2026-09-30\n", "a due:2026-09-30", "low")).toBe("- [ ] a !low due:2026-09-30\n");
    expect(edit("- [ ] a\n", "a", "none")).toBe("- [ ] a\n");
  });
});

describe("appendTaskToContent", () => {
  it("appends under a Tasks heading", () => {
    expect(appendTaskToContent("# Day\n\n## Tasks\n- [ ] one\n\n## Notes\ntext\n", "two")).toEqual({
      content: "# Day\n\n## Tasks\n- [ ] one\n- [ ] two\n\n## Notes\ntext\n",
      line: 4,
    });
    expect(appendTaskToContent("# Day\n## tasks\n\n## Next\n", "x")).toEqual({
      content: "# Day\n## tasks\n- [ ] x\n\n## Next\n",
      line: 2,
    });
  });

  it("appends at the end otherwise", () => {
    expect(appendTaskToContent("# 2026-09-22\n\n", "new")).toEqual({ content: "# 2026-09-22\n\n- [ ] new\n", line: 2 });
    expect(appendTaskToContent("no newline", "new")).toEqual({ content: "no newline\n- [ ] new\n", line: 1 });
    expect(appendTaskToContent("", "first").content).toBe("- [ ] first\n");
    expect(appendTaskToContent("a\r\nb", "crlf").content).toBe("a\r\nb\r\n- [ ] crlf\r\n");
    expect(appendTaskToContent("```\n## Tasks\n```\n", "outside").content).toBe("```\n## Tasks\n```\n- [ ] outside\n");
  });

  it("validates the text", () => {
    expect(() => appendTaskToContent("", "   ")).toThrow("invalid input: task text is required");
    expect(() => appendTaskToContent("", "x".repeat(MAX_TASK_TEXT + 1))).toThrow(/longer than/);
    expect(appendTaskToContent("", "multi\nline").content).toBe("- [ ] multi line\n");
  });

  it("produces a parsable task at the reported line", () => {
    const { content, line } = appendTaskToContent("## Tasks\n- [ ] a", "b 📅 2026-09-30");
    const task = parseTasks("/v/n.md", content).find((t) => t.line === line);
    expect(task?.due).toBe("2026-09-30");
  });
});

describe("withStatus", () => {
  it("builds the optimistic task", () => {
    const [task] = parseTasks("/v/n.md", "- [X] a\n");
    expect(withStatus(task, "done").status_char).toBe("X");
    const reopened = withStatus(task, "todo");
    expect(reopened).toMatchObject({ status: "todo", status_char: " ", checked: false });
  });
});

describe("composeTaskText", () => {
  it("adds priority and due markers unless already typed", () => {
    expect(composeTaskText("  Call mum ", "2026-09-30", "high")).toBe("Call mum ⏫ 📅 2026-09-30");
    expect(composeTaskText("Call mum due:2026-10-01 !low", "2026-09-30", "high")).toBe("Call mum due:2026-10-01 !low");
    expect(composeTaskText("Plain", null, "none")).toBe("Plain");
  });
});
