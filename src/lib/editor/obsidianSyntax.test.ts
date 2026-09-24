import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { commentSpanEnd, installObsidianSyntax, isWikilinkInner, mathSpanEnd, parseWikilink, wikilinkLabel } from "./obsidianSyntax";
import { calloutType, inlineSyntaxRanges } from "./obsidianDecorations";

describe("parseWikilink", () => {
  it("splits target, heading and alias", () => {
    expect(parseWikilink("Note")).toEqual({ target: "Note", heading: null, alias: null });
    expect(parseWikilink("Note#Heading")).toEqual({ target: "Note", heading: "Heading", alias: null });
    expect(parseWikilink("Note#Heading|Alias")).toEqual({ target: "Note", heading: "Heading", alias: "Alias" });
    expect(parseWikilink("folder/Note|Alias")).toEqual({ target: "folder/Note", heading: null, alias: "Alias" });
    expect(parseWikilink("#Local heading")).toEqual({ target: "", heading: "Local heading", alias: null });
    expect(parseWikilink("Note#^block-1")).toEqual({ target: "Note", heading: "^block-1", alias: null });
    // Inside tables the alias separator is escaped.
    expect(parseWikilink("Note\\|Alias")).toEqual({ target: "Note", heading: null, alias: "Alias" });
  });

  it("labels links like Obsidian", () => {
    expect(wikilinkLabel("Note")).toBe("Note");
    expect(wikilinkLabel("Note|Alias")).toBe("Alias");
    expect(wikilinkLabel("Note#Heading")).toBe("Note › Heading");
    expect(wikilinkLabel("#Heading")).toBe("Heading");
    expect(wikilinkLabel("Note#^block")).toBe("Note › block");
  });

  it("accepts only one-line targets without brackets", () => {
    expect(isWikilinkInner("Note")).toBe(true);
    expect(isWikilinkInner("  ")).toBe(false);
    expect(isWikilinkInner("a]b")).toBe(false);
    expect(isWikilinkInner("a\nb")).toBe(false);
  });
});

describe("math and comment spans", () => {
  it("follows the pandoc/Obsidian dollar rules", () => {
    const end = (src: string) => mathSpanEnd(src, 0);
    expect(end("$x^2$ rest")).toBe(5);
    expect(end("$$\\sum_k$$")).toBe(10);
    expect(end("$5 and $10")).toBe(-1);
    expect(end("$ x$")).toBe(-1);
    expect(end("$x $")).toBe(-1);
    expect(end("$a\\$b$")).toBe(6);
    expect(end("$a\nb$")).toBe(-1);
    expect(end("$a$$")).toBe(-1);
  });

  it("finds %%comments%%", () => {
    expect(commentSpanEnd("%%a%% b", 0)).toBe(5);
    expect(commentSpanEnd("%%open", 0)).toBe(-1);
  });
});

describe("installObsidianSyntax", () => {
  const md = new MarkdownIt({ html: true });
  installObsidianSyntax(md);
  installObsidianSyntax(md); // idempotent

  it("renders wikilinks and embeds as elements carrying the source", () => {
    expect(md.renderInline("See [[Note#H|A & B]] and ![[a.png|300]]")).toBe(
      'See <span data-wikilink="Note#H|A &amp; B"></span> and <span data-wikiembed="a.png|300"></span>'
    );
    expect(md.renderInline("`[[code]]` and \\[[escaped]] and [[]]")).toBe("<code>[[code]]</code> and [[escaped]] and [[]]");
  });

  it("keeps math, comments and HTML comments verbatim", () => {
    expect(md.renderInline("$a_1*b_2$ %%x *y*%% <!-- c -->")).toBe(
      '<span data-md-raw="math" data-raw="$a_1*b_2$"></span> <span data-md-raw="comment" data-raw="%%x *y*%%"></span> <span data-md-raw="html" data-raw="&lt;!-- c --&gt;"></span>'
    );
    expect(md.render("$$\nx_1\n$$\n")).toBe('<div data-md-raw-block="math" data-raw="$$&#10;x_1&#10;$$"></div>');
    expect(md.render("%%\na\n\nb\n%%\n")).toBe('<div data-md-raw-block="comment" data-raw="%%&#10;a&#10;&#10;b&#10;%%"></div>');
    expect(md.render("<!--\nc\n-->\n")).toBe('<div data-md-raw-block="html" data-raw="&lt;!--&#10;c&#10;--&gt;"></div>');
    // Unclosed delimiters stay text.
    expect(md.render("$$\nopen\n")).toContain("<p>$$");
  });

  it("keeps soft line breaks, footnote definitions and list markers", () => {
    expect(md.render("a\nb")).toBe('<p>a<br data-md-soft="true">b</p>\n');
    expect(md.render("[^1]: Footnote")).toBe("<p>[^1]: Footnote</p>\n");
    expect(md.render("* a")).toContain('<ul data-md-bullet="*">');
    expect(md.render("1) a")).toContain('<ol data-md-delim=")">');
  });
});

describe("Obsidian decorations", () => {
  it("finds tags and highlights", () => {
    const text = "#tag, (#paren) ==mark== #123 a#b https://x.com/#frag #nested/tag";
    expect(inlineSyntaxRanges(text).map((r) => [r.kind, text.slice(r.from, r.to)])).toEqual([
      ["tag", "#tag"],
      ["tag", "#paren"],
      ["tag", "#nested/tag"],
      ["highlight", "==mark=="],
    ]);
  });

  it("styles a callout's marker and title line only", async () => {
    const { Editor } = await import("@tiptap/core");
    const { noteEditorExtensions } = await import("./extensions");
    const element = document.createElement("div");
    const editor = new Editor({ element, extensions: noteEditorExtensions(), content: "" });
    editor.commands.setContent("> [!tip] Title here\n> Body line", { emitUpdate: false });
    expect(element.querySelector("blockquote")?.className).toContain("is-callout");
    expect(element.querySelector("blockquote")?.getAttribute("data-callout")).toBe("tip");
    expect(element.querySelector(".md-callout-marker")?.textContent).toBe("[!tip]");
    expect(element.querySelector(".md-callout-title")?.textContent).toBe(" Title here");
    editor.destroy();
  });

  it("recognises callouts", () => {
    expect(calloutType("[!NOTE] Title")).toBe("note");
    expect(calloutType("[!warning]- Folded")).toBe("warning");
    expect(calloutType("Plain quote")).toBeNull();
  });
});
