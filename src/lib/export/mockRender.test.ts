import { describe, expect, it } from "vitest";
import {
  convertWikilinksMock,
  headingAnchor,
  parseFrontmatter,
  renderMarkdownBody,
  renderMockDocument,
  splitFrontmatter,
} from "./mockRender";

const ctx = { resolveNote: (t: string) => (["alpha", "beta"].includes(t.toLowerCase()) ? t : null) };

describe("mock export renderer", () => {
  it("parses frontmatter like the Rust side", () => {
    const { frontmatter, body } = splitFrontmatter("---\ntitle: T\ntags:\n  - a\n  - '#b'\n---\nBody");
    expect(body).toBe("Body");
    expect(parseFrontmatter(frontmatter)).toEqual({ title: "T", date: null, description: null, tags: ["a", "b"] });
    expect(parseFrontmatter("tags: [x, y]").tags).toEqual(["x", "y"]);
    expect(splitFrontmatter("# No fm").frontmatter).toBeNull();
  });

  it("renders the vault's Markdown dialect", () => {
    const out = renderMarkdownBody(
      [
        "## Part One",
        "",
        "Links [[Alpha|the alpha]], [[Ghost]] and [[#Part One]] #tag `[[code]]` **bold** _em_.",
        "",
        "- [ ] open",
        "- [x] done",
        "",
        "> quoted [[Beta]]",
        "",
        "| A | B |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "```mermaid",
        "graph TD; A-->B;",
        "```",
        "",
        "```js",
        "const x = '<b>';",
        "```",
        "",
        "![[photo.png]] ![alt](pics/x.png) [ext](https://e.com) [bad](javascript:alert(1))",
      ].join("\n"),
      ctx
    );
    expect(out.html).toContain('<h2 id="part-one">Part One</h2>');
    expect(out.html).toContain('<span class="wikilink" title="Alpha">the alpha</span>');
    expect(out.html).toContain('<span class="missing" title="Not exported: Ghost">Ghost</span>');
    expect(out.html).toContain('<a class="internal" href="#part-one">Part One</a>');
    expect(out.html).toContain('<span class="tag">#tag</span>');
    expect(out.html).toContain("<code>[[code]]</code>");
    expect(out.html).toContain("<strong>bold</strong>");
    expect(out.html).toContain('<input disabled="" type="checkbox"/>');
    expect(out.html).toContain('checked=""');
    expect(out.html).toContain("<blockquote>");
    expect(out.html).toContain("<th>A</th>");
    expect(out.html).toContain('<pre class="mermaid">graph TD; A--&gt;B;</pre>');
    expect(out.html).toContain("const x = &#39;&lt;b&gt;&#39;;");
    expect(out.html).toContain('class="embed" src="data:image/svg+xml');
    expect(out.html).toContain('<a href="https://e.com">ext</a>');
    expect(out.html).not.toContain("javascript:");
    expect(out.missing).toEqual(["Ghost"]);
    expect(out.tags).toEqual(["tag"]);
    expect(out.hasMermaid).toBe(true);
  });

  it("wraps notes in the export document with the real stylesheet", () => {
    const html = renderMockDocument({
      name: "file",
      content: "---\ntitle: Hello\ndate: 2026-01-01\ntags: [x]\n---\n# Hello\n\nBody",
      options: { include_frontmatter: true, include_backlinks: true, theme: "dark" },
      backlinks: ["Other"],
      ctx,
    });
    expect(html).toContain("<title>Hello</title>");
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('<body class="aether-doc" data-theme="dark">');
    expect(html).toContain('<time datetime="2026-01-01">');
    expect(html).toContain("Linked from");
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("converts wikilinks outside code", () => {
    const text = convertWikilinksMock("---\nx: \"[[Keep]]\"\n---\n[[Alpha]] ![[a.png]] `[[code]]` [[Gone|G]]\n```\n[[fenced]]\n```", (t) =>
      t === "Alpha" ? "Projects/Alpha.md" : t === "a.png" ? "files/a.png" : null
    );
    expect(text).toContain('x: "[[Keep]]"');
    expect(text).toContain("[Alpha](Projects/Alpha.md)");
    expect(text).toContain("![a.png](files/a.png)");
    expect(text).toContain("`[[code]]`");
    expect(text).toContain(" G\n");
    expect(text).toContain("[[fenced]]");
  });

  it("builds GitHub-style anchors", () => {
    expect(headingAnchor("Hello, World!")).toBe("hello-world");
    expect(headingAnchor("Über uns")).toBe("über-uns");
  });
});
