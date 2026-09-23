import { describe, expect, it } from "vitest";
import wordCountSource from "../../../plugins/examples/word-count/main.js?raw";
import dailyReviewSource from "../../../plugins/examples/daily-review/main.js?raw";
import randomNoteSource from "../../../plugins/examples/random-note/main.js?raw";
import { evaluatePluginModule } from "./testHarness";

type Fn<A extends unknown[], R> = (...args: A) => R;

const wordCount = evaluatePluginModule(wordCountSource);
const dailyReview = evaluatePluginModule(dailyReviewSource);
const randomNote = evaluatePluginModule(randomNoteSource);

describe("word-count example", () => {
  const countWords = wordCount.countWords as Fn<[string], number>;
  const sectionCounts = wordCount.sectionCounts as Fn<[string], { title: string; level: number; words: number }[]>;
  const formatReadingTime = wordCount.formatReadingTime as Fn<[number, number], string>;

  it("counts prose words and ignores markup, frontmatter and code", () => {
    const note = [
      "---",
      "tags: [a, b]",
      "---",
      "# Title here",
      "Some **bold** text with a [link](https://example.com) and [[Target|an alias]].",
      "- [ ] a task item",
      "```js",
      "const ignored = true;",
      "```",
      "Don't split contractions or well-known words.",
    ].join("\n");
    expect(countWords(note)).toBe(2 + 9 + 3 + 6);
    expect(countWords("")).toBe(0);
    expect(countWords("Größe und Übermaß")).toBe(3);
  });

  it("breaks a note down by heading", () => {
    const sections = sectionCounts("Intro words here\n# One\nalpha beta\n## Two\ngamma\n```\n# not a heading\n```\n");
    expect(sections).toEqual([
      { title: "Introduction", level: 0, words: 3 },
      { title: "One", level: 1, words: 2 },
      { title: "Two", level: 2, words: 1 },
    ]);
  });

  it("formats reading time", () => {
    expect(formatReadingTime(0, 230)).toBe("0 min");
    expect(formatReadingTime(100, 230)).toBe("< 1 min");
    expect(formatReadingTime(1150, 230)).toBe("5 min");
    expect(formatReadingTime(460, Number.NaN)).toBe("2 min");
  });
});

describe("daily-review example", () => {
  const upsertSection = dailyReview.upsertSection as Fn<[string, string, string], string>;
  const cleanAnswer = dailyReview.cleanAnswer as Fn<[string], string>;
  const dailyNotePath = dailyReview.dailyNotePath as Fn<[string, Date], string>;

  it("appends a review section when there is none", () => {
    expect(upsertSection("# 2026-09-22\n\n- did things\n", "Review", "- summary")).toBe(
      "# 2026-09-22\n\n- did things\n\n## Review\n\n- summary\n"
    );
  });

  it("replaces an existing review but keeps the sections after it", () => {
    const note = "# Day\n\n## Review\n\nold summary\n\n## Log\n- 10:00 thing\n";
    expect(upsertSection(note, "Review", "new summary")).toBe("# Day\n\n## Review\n\nnew summary\n\n## Log\n- 10:00 thing\n");
  });

  it("strips agent action blocks and echoed headings from the answer", () => {
    expect(cleanAnswer("## Review\n- a\n```action\n{\"action\":\"append_daily\"}\n```\n")).toBe("- a");
  });

  it("builds the daily note path from the folder setting", () => {
    const date = new Date(2026, 8, 22);
    expect(dailyNotePath("daily", date)).toBe("daily/2026-09-22.md");
    expect(dailyNotePath("/journal/days/", date)).toBe("journal/days/2026-09-22.md");
    expect(dailyNotePath("../etc", date)).toBe("etc/2026-09-22.md");
    expect(dailyNotePath("", date)).toBe("2026-09-22.md");
  });
});

describe("random-note example", () => {
  const parseFolders = randomNote.parseFolders as Fn<[string], string[]>;
  const pickRandomNote = randomNote.pickRandomNote as Fn<
    [{ path: string }[], string[], string | null, () => number],
    { path: string } | null
  >;

  it("parses the skip-folders setting", () => {
    expect(parseFolders(" daily, /Templates/ ,, ")).toEqual(["daily", "templates"]);
  });

  it("skips excluded folders and the open note", () => {
    const notes = [{ path: "daily/a.md" }, { path: "ideas/b.md" }, { path: "c.md" }, { path: "dailyish.md" }];
    const picked = new Set<string>();
    for (const r of [0, 0.34, 0.67, 0.99]) {
      picked.add(pickRandomNote(notes, ["daily"], "c.md", () => r)!.path);
    }
    expect([...picked].sort()).toEqual(["dailyish.md", "ideas/b.md"]);
    expect(pickRandomNote([{ path: "daily/a.md" }], ["daily"], null, () => 0.5)).toBeNull();
  });
});
