import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/tasks.md?raw";
import expected from "./__fixtures__/tasks.expected.json";
import {
  extractTags,
  fnv1a64,
  isValidIsoDate,
  noteNameOf,
  parseTaskLine,
  parseTasks,
  scanMarkers,
  statusFromChar,
  statusMarker,
} from "./parser";

const one = (content: string) => {
  const tasks = parseTasks("/v/Note.md", content);
  expect(tasks).toHaveLength(1);
  return tasks[0];
};

describe("golden fixture (shared with the Rust parser)", () => {
  it("produces exactly the expectation the Rust test asserts", () => {
    expect(parseTasks("/vault/Projects/Task Fixture.md", fixture)).toEqual(expected);
  });
});

describe("parseTasks", () => {
  it("recognises bullets, numbers and status characters", () => {
    const tasks = parseTasks("/v/n.md", "- [ ] dash\n* [x] star\n+ [X] plus\n1. [/] one\n2) [-] two\n- [>] fwd\n");
    expect(tasks.map((t) => [t.text_raw, t.status])).toEqual([
      ["dash", "todo"],
      ["star", "done"],
      ["plus", "done"],
      ["one", "in_progress"],
      ["two", "cancelled"],
      ["fwd", "todo"],
    ]);
    expect(tasks[5].status_char).toBe(">");
  });

  it("ignores things that only look like tasks", () => {
    expect(parseTasks("/v/n.md", "- [ ]\n- [ ]   \n- [x]no space\n- [a](link)\n- [[Wiki]]\n-[ ] tight\n[ ] bare\n")).toEqual([]);
  });

  it("skips frontmatter and fenced code", () => {
    const content = "---\n- [ ] fm\n---\n```\n- [ ] code\n```\n~~~\n```\n- [ ] tilde\n~~~\n- [ ] real\n";
    expect(parseTasks("/v/n.md", content).map((t) => t.text_raw)).toEqual(["real"]);
    expect(parseTasks("/v/n.md", "---\n- [ ] unclosed frontmatter\n")).toHaveLength(1);
  });

  it("tracks nesting depth and indent (tab = 4 columns)", () => {
    const content = "- [ ] a\n  - [ ] b\n    - [x] c\n\t- [ ] d\nParagraph\n  - [ ] e\n";
    expect(parseTasks("/v/n.md", content).map((t) => [t.indent, t.depth])).toEqual([
      [0, 0],
      [2, 1],
      [4, 2],
      [4, 2],
      [2, 0],
    ]);
  });

  it("parses every due syntax", () => {
    for (const line of [
      "- [ ] a due:2026-09-30",
      "- [ ] a (due: 2026-09-30)",
      "- [ ] a [due:: 2026-09-30]",
      "- [ ] a @due(2026-09-30)",
      "- [ ] a 📅 2026-09-30",
      "- [ ] a 🗓️ 2026-09-30",
    ]) {
      const t = one(line);
      expect(t.due, line).toBe("2026-09-30");
      expect(t.text_clean, line).toBe("a");
    }
  });

  it("maps priorities and strips them from the clean text", () => {
    expect(one("- [ ] a 🔺").priority).toBe("urgent");
    expect(one("- [ ] a !HIGH").priority).toBe("high");
    expect(one("- [ ] a !med").priority).toBe("medium");
    expect(one("- [ ] a ⏬").priority).toBe("low");
    expect(one("- [ ] a !higher").priority).toBe("none");
    expect(one("- [ ] a ⏫ b").text_clean).toBe("a b");
  });

  it("keeps markers inside inline code and impossible dates", () => {
    const t = one("- [ ] `📅 2026-01-01` and 📅 2026-02-30");
    expect(t.due).toBeNull();
    expect(t.text_clean).toBe("`📅 2026-01-01` and 📅 2026-02-30");
  });

  it("handles CRLF and a BOM", () => {
    const tasks = parseTasks("/v/n.md", "\uFEFF- [ ] first\r\n- [x] second \r\n");
    expect(tasks.map((t) => t.text_raw)).toEqual(["first", "second"]);
  });

  it("records the nearest heading", () => {
    const tasks = parseTasks("/v/n.md", "# Top\n- [ ] a\n## Sub ##\n- [ ] b\n#notaheading\n- [ ] c\n");
    expect(tasks.map((t) => t.section)).toEqual(["Top", "Sub", "Sub"]);
  });
});

describe("helpers", () => {
  it("hashes like the Rust implementation", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
  });

  it("extracts tags without code spans or numbers", () => {
    expect(extractTags("Fix #bug in `#no` (#area/sub) #42 #bug x#y #café")).toEqual(["bug", "area/sub", "café"]);
  });

  it("validates calendar dates", () => {
    expect(isValidIsoDate("2028-02-29")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("26-01-01")).toBe(false);
  });

  it("derives note names", () => {
    expect(noteNameOf("/v/dir/My Note.md")).toBe("My Note");
    expect(noteNameOf("C:\\v\\Upper.MD")).toBe("Upper");
  });

  it("splits a task line with offsets", () => {
    const line = "  - [✓] odd one";
    const parsed = parseTaskLine(line);
    expect(parsed).not.toBeNull();
    expect(line.slice(parsed!.statusAt, parsed!.statusAt + parsed!.statusChar.length)).toBe("✓");
    expect(line.slice(parsed!.textAt)).toBe("odd one");
    expect(parseTaskLine("plain text")).toBeNull();
  });

  it("round-trips status characters", () => {
    for (const s of ["todo", "in_progress", "done", "cancelled"] as const) {
      expect(statusFromChar(statusMarker(s))).toBe(s);
    }
  });

  it("reports marker ranges", () => {
    const text = "Ship ⏫ due:2026-09-30 ^id";
    const markers = scanMarkers(text);
    expect(markers.map((m) => [m.kind, text.slice(m.start, m.end)])).toEqual([
      ["priority", "⏫"],
      ["due", "due:2026-09-30"],
      ["block", "^id"],
    ]);
  });
});
