import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { noteEditorExtensions } from "./extensions";
import { escapeMarkdownText, formatDestination } from "./markdownSerializer";
import { editorMarkdown } from "./noteBody";
import { imageMarkdown } from "./vaultImage";

describe("escapeMarkdownText", () => {
  const esc = (text: string, startOfLine = false) => escapeMarkdownText(text, { startOfLine });

  it("leaves Obsidian syntax alone", () => {
    for (const text of ["empty [[]] and [[unclosed", "a claim[^1]", "[!note] Title", "#tag and #nested/tag", "==marked==", "%%comment%%", "$x^2$", "[single] brackets"]) {
      expect(esc(text), text).toBe(text);
    }
  });

  it("leaves ordinary punctuation alone", () => {
    for (const text of ["a -> b", "1 < 2 > 0", "AT&T", "snake_case_name", "5 * 3", "~5 GB", "C:\\Users\\demo", "(parens) and [a] (b)", "100% sure", "Q&A: yes!"]) {
      expect(esc(text), text).toBe(text);
    }
  });

  it("escapes what CommonMark would read as syntax", () => {
    expect(esc("*not emphasis*")).toBe("\\*not emphasis\\*");
    expect(esc("_under_")).toBe("\\_under\\_");
    expect(esc("use `code`")).toBe("use \\`code\\`");
    expect(esc("~~strike~~")).toBe("\\~\\~strike\\~\\~");
    expect(esc("[text](https://x.com)")).toBe("[text\\](https://x.com)");
    expect(esc("a <div> tag")).toBe("a \\<div> tag");
    expect(esc("&amp; entity")).toBe("\\&amp; entity");
    expect(esc("trailing \\")).toBe("trailing \\\\");
    expect(esc("\\*")).toBe("\\\\\\*");
    expect(esc("literal [[not a link]]")).toBe("literal \\[[not a link]]");
    expect(escapeMarkdownText("a | b", { inTable: true })).toBe("a \\| b");
  });

  it("escapes block markers only at the start of a line", () => {
    expect(esc("# not a heading", true)).toBe("\\# not a heading");
    expect(esc("#tag", true)).toBe("#tag");
    expect(esc("- not a list", true)).toBe("\\- not a list");
    expect(esc("-5 degrees", true)).toBe("-5 degrees");
    expect(esc("+ plus", true)).toBe("\\+ plus");
    expect(esc("> quote", true)).toBe("\\> quote");
    expect(esc("1. not ordered", true)).toBe("1\\. not ordered");
    expect(esc("2026. A year", true)).toBe("2026\\. A year");
    expect(esc("---", true)).toBe("\\---");
    expect(esc("[ ] not a task", true)).toBe("\\[ ] not a task");
    expect(escapeMarkdownText("[ ] numbered task", { startOfLine: true, keepTaskMarker: true })).toBe("[ ] numbered task");
    expect(esc("[ref]: https://x", true)).toBe("\\[ref]: https://x");
    expect(esc("[^1]: footnote", true)).toBe("[^1]: footnote");
    expect(esc("# heading", false)).toBe("# heading");
    // Lines after a line break start a line too.
    expect(esc("text\n- item\n===")).toBe("text\n\\- item\n\\===");
  });
});

describe("imageMarkdown", () => {
  it("writes destinations CommonMark reads back", () => {
    expect(formatDestination("a.png")).toBe("a.png");
    expect(formatDestination("my file.png")).toBe("<my file.png>");
    expect(formatDestination("a(1).png")).toBe("a(1).png");
    expect(formatDestination("a(.png")).toBe("a\\(.png");
    expect(imageMarkdown({ src: "Brötchen.png", alt: "Brot [frisch]", title: 'say "hi"' })).toBe('![Brot \\[frisch\\]](Brötchen.png "say \\"hi\\"")');
  });
});

describe("serializer round trips", () => {
  let editor: Editor;
  beforeAll(() => {
    editor = new Editor({ extensions: noteEditorExtensions(), content: "" });
  });
  afterAll(() => editor.destroy());

  const roundTrip = (markdown: string) => {
    editor.commands.setContent(markdown, { emitUpdate: false });
    return editorMarkdown(editor).replace(/\n+$/, "");
  };

  it.each([
    ["wikilinks", "See [[AETHER-OS]], [[Note#Heading|alias]] and [[folder/Note]]."],
    ["embeds", "![[photo.png|300]] and ![[Other note]]"],
    ["soft line breaks", "Line one\nline two\nline three"],
    ["hard line breaks", "Line one\\\nline two"],
    ["callouts", "> [!note] Title\n> Body with [[link]]"],
    ["footnotes", "Text[^1].\n\n[^1]: The note."],
    ["single-word footnotes", "Text[^a].\n\n[^a]: Footnote"],
    ["inline math", "Euler: $e^{i\\pi} + 1 = 0$ and $a_1 * b_2$."],
    ["math blocks", "$$\n\\frac{1}{2}\n$$"],
    ["comments", "Visible %%hidden [[x]]%% text"],
    ["comment blocks", "%%\nhidden\n\nstill hidden\n%%"],
    ["HTML comments", "Text <!-- note --> more\n\n<!--\nblock\n-->"],
    ["highlights and tags", "==marked== and #tag"],
    ["star bullets", "* one\n* two"],
    ["plus bullets", "+ one\n+ two"],
    ["parenthesis numbers", "1) one\n2) two"],
    ["numbered tasks", "1. [ ] open\n2. [x] done"],
    ["mixed lists", "- plain\n- [ ] task\n- plain again"],
    ["tables with wikilinks", "| A | B |\n| --- | --- |\n| [[Note\\|alias]] | a \\| b |"],
    ["images followed by a heading", "![Alt](a.png)\n\n## Next"],
    ["code containing fences", "````\n```\ninner\n```\n````"],
    ["unicode paths", "![Brot](bilder/Brötchen.png) and [doc](my%20file.md)"],
    ["link targets with spaces", "[doc](<my file.md> \"Title\") and ![img](<a b.png>)"],
    ["autolinks", "<https://example.com/a_b>"],
  ])("keeps %s", (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it("keeps a literal [ ] after a task marker however often the note is read", () => {
    for (let i = 0; i < 3; i++) expect(roundTrip("- [ ] [ ] literal")).toBe("- [ ] [ ] literal");
  });

  it("never invents an empty task for a list that mixes plain and task items", () => {
    const md = "- plain\n\n- [ ] task";
    expect(roundTrip(md)).toBe("- plain\n\n- [ ] task");
    let empty = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "taskItem" && node.textContent === "") empty++;
    });
    expect(empty).toBe(0);
  });

  it("keeps two lists with the same marker apart", () => {
    const json = {
      type: "doc",
      content: [
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] }] },
      ],
    };
    editor.commands.setContent(json, { emitUpdate: false });
    expect(editorMarkdown(editor)).toBe("- a\n* b");
  });

  it("escapes a literal ! in front of a wikilink so it does not become an embed", () => {
    editor.commands.setContent(
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Wow!" }, { type: "wikiLink", attrs: { raw: "Note" } }] }] },
      { emitUpdate: false }
    );
    expect(editorMarkdown(editor)).toBe("Wow\\![[Note]]");
  });
});
