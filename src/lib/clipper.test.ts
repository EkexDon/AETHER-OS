import { describe, it, expect } from "vitest";
import { htmlToMarkdown, buildClipNote, clipNoteName, parseAgentActions, describeAction } from "./clipper";
import type { ClippedPage } from "../types";

describe("clipper", () => {
  describe("htmlToMarkdown", () => {
    it("converts basic HTML to Markdown", () => {
      const html = "<h1>Title</h1><p>Hello <strong>world</strong></p>";
      const md = htmlToMarkdown(html);
      expect(md).toContain("# Title");
      expect(md).toContain("Hello");
      expect(md).toContain("**world**");
    });

    it("converts links", () => {
      const html = '<a href="https://example.com">Example</a>';
      const md = htmlToMarkdown(html);
      expect(md).toContain("[Example](https://example.com)");
    });

    it("converts lists", () => {
      const html = "<ul><li>One</li><li>Two</li></ul>";
      const md = htmlToMarkdown(html);
      expect(md).toContain("-   One");
      expect(md).toContain("-   Two");
    });

    it("removes script and style tags", () => {
      const html = "<script>alert(1)</script><style>.x{}</style><p>Text</p>";
      const md = htmlToMarkdown(html);
      expect(md).not.toContain("alert");
      expect(md).not.toContain(".x{}");
      expect(md).toContain("Text");
    });

    it("handles empty input", () => {
      expect(htmlToMarkdown("")).toBe("");
    });
  });

  describe("buildClipNote", () => {
    it("builds a complete clip note with metadata", () => {
      const page: ClippedPage = {
        url: "https://example.com/article",
        title: "Test Article",
        content_html: "<p>Article content</p>",
        excerpt: "Article content",
      };
      const now = new Date("2025-01-15T10:30:00");
      const note = buildClipNote(page, now);

      expect(note).toContain("# Test Article");
      expect(note).toContain("https://example.com/article");
      expect(note).toContain("Article content");
      expect(note).toContain("[Source](https://example.com/article)");
      expect(note).toContain("#clipped");
    });

    it("uses fallback title when empty", () => {
      const page: ClippedPage = {
        url: "https://example.com",
        title: "",
        content_html: "<p>Content</p>",
        excerpt: "Content",
      };
      const note = buildClipNote(page, new Date());
      expect(note).toContain("# Web Clip");
    });
  });

  describe("clipNoteName", () => {
    it("creates safe filename from title", () => {
      const name = clipNoteName("Hello / World: Test?", new Date());
      expect(name).toBe("Hello World Test.md");
    });

    it("truncates long titles", () => {
      const longTitle = "A".repeat(200);
      const name = clipNoteName(longTitle, new Date());
      expect(name.length).toBeLessThan(90);
    });

    it("uses fallback for empty title", () => {
      const name = clipNoteName("", new Date("2025-01-15T10:30:00"));
      expect(name).toMatch(/Clip 2025-01-15 1030\.md/);
    });
  });

  describe("parseAgentActions", () => {
    it("parses a single action from fenced code block", () => {
      const output = 'Here is your note:\n\n```action\n{"action":"create_note","title":"Ideas","content":"# Hello"}\n```\nDone.';
      const actions = parseAgentActions(output);
      expect(actions).toHaveLength(1);
      expect(actions[0].action).toBe("create_note");
    });

    it("parses multiple actions", () => {
      const output = [
        '```action\n{"action":"create_note","title":"A","content":"a"}\n```',
        '```action\n{"action":"append_daily","content":"reminder"}\n```',
      ].join("\n\n");
      const actions = parseAgentActions(output);
      expect(actions).toHaveLength(2);
      expect(actions[0].action).toBe("create_note");
      expect(actions[1].action).toBe("append_daily");
    });

    it("ignores malformed JSON", () => {
      const output = '```action\n{invalid json}\n```';
      const actions = parseAgentActions(output);
      expect(actions).toHaveLength(0);
    });

    it("returns empty for no action blocks", () => {
      expect(parseAgentActions("just text")).toEqual([]);
    });
  });

  describe("describeAction", () => {
    it("describes create_note", () => {
      const desc = describeAction({ action: "create_note", title: "My Note", content: "" });
      expect(desc).toContain("Create note");
      expect(desc).toContain("My Note");
    });

    it("describes append_note", () => {
      const desc = describeAction({ action: "append_note", path: "vault/note.md", content: "" });
      expect(desc).toContain("note.md");
    });

    it("describes append_daily", () => {
      const desc = describeAction({ action: "append_daily", content: "Remember to buy milk" });
      expect(desc).toContain("Remember to buy milk");
    });

    it("describes open_url", () => {
      const desc = describeAction({ action: "open_url", url: "https://example.com" });
      expect(desc).toContain("https://example.com");
    });

    it("describes clip_url", () => {
      const desc = describeAction({ action: "clip_url", url: "https://example.com" });
      expect(desc).toContain("Clip");
      expect(desc).toContain("https://example.com");
    });
  });
});
