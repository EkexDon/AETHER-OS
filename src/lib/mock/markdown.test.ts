import { describe, expect, it } from "vitest";
import {
  buildIndexEntry,
  extractCards,
  extractTags,
  extractTasks,
  extractWikilinks,
  firstSentence,
  lineLinksTo,
  parseFrontmatter,
  wordCount,
} from "./markdown";

const NOTE = `---
title: Demo
tags: [alpha, "beta"]
---
# Heading #notatag

Intro sentence with [[Target Note|alias]] and [[Other#Section]]. More text.

- [ ] Open task 📅 2026-10-01 #work
- [x] Done task due:2026-09-01
* [ ] Star task

\`\`\`md
[[Ignored Link]] #ignoredtag
- [ ] ignored task
\`\`\`

Issue #42 is not a tag, but #real/nested is.
Question :: Answer
`;

describe("mock markdown extraction", () => {
  it("parses flat frontmatter", () => {
    expect(parseFrontmatter(NOTE)).toEqual({ title: "Demo", tags: '[alpha, "beta"]' });
    expect(parseFrontmatter("no frontmatter")).toEqual({});
  });

  it("collects frontmatter and inline tags but skips headings, code and numbers", () => {
    expect(extractTags(NOTE)).toEqual(["alpha", "beta", "work", "real/nested"]);
  });

  it("extracts wikilink targets without alias or heading, ignoring code", () => {
    expect(extractWikilinks(NOTE)).toEqual(["Target Note", "Other"]);
  });

  it("extracts tasks with 1-based lines, state, due dates and tags", () => {
    const tasks = extractTasks(NOTE, "/v/demo.md");
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ line: 9, checked: false, due: "2026-10-01", tags: ["work"] });
    expect(tasks[1]).toMatchObject({ checked: true, due: "2026-09-01" });
    expect(tasks[2]).toMatchObject({ text: "Star task", due: null });
  });

  it("extracts cards, counts words and builds an index entry", () => {
    expect(extractCards(NOTE, "/v/demo.md")).toEqual([
      expect.objectContaining({ front: "Question", back: "Answer", card_type: "basic" }),
    ]);
    expect(wordCount("---\na: b\n---\none two\n```\nskip me\n```\nthree")).toBe(3);
    const entry = buildIndexEntry("/v/demo.md", NOTE, 42);
    expect(entry).toMatchObject({ path: "/v/demo.md", mtime: 42, wikilinks: ["Target Note", "Other"] });
    expect(entry.tasks).toHaveLength(3);
  });

  it("matches wikilinks case-insensitively and alias-aware", () => {
    expect(lineLinksTo("see [[Target Note|x]]", "target note")).toBe(true);
    expect(lineLinksTo("see [[Target]]", "target note")).toBe(false);
  });

  it("finds the first prose sentence", () => {
    expect(firstSentence(NOTE)).toBe("Intro sentence with alias and Other#Section.");
  });
});
