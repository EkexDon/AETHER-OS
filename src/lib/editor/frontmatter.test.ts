import { describe, expect, it } from "vitest";
import taskFixture from "../vaulttasks/__fixtures__/tasks.md?raw";
import { buildVaultFixture } from "../mock/fixtures/vault";
import {
  editFrontmatter,
  formatScalar,
  frontmatterLineCount,
  frontmatterYaml,
  isValidPropertyKey,
  joinFrontmatter,
  listProperties,
  normalizeTags,
  parseSimpleYaml,
  removeProperty,
  replaceFrontmatterYaml,
  setProperty,
  splitFrontmatter,
} from "./frontmatter";

const SAMPLES: Record<string, string> = {
  none: "# Title\n\nBody text\n",
  simple: "---\ntitle: Welcome\ntags: [start, meta]\n---\n# Welcome\n",
  gap: "---\ntags: [a]\n---\n\n\n# After blank lines\n",
  crlf: "---\r\ntitle: Windows\r\ntags:\r\n  - one\r\n  - two\r\n---\r\n\r\nBody\r\n",
  bom: "\uFEFF---\ntitle: BOM\n---\nBody",
  dots: "---\ntitle: Dots\n...\nBody\n",
  empty: "---\n---\nOnly body\n",
  onlyFrontmatter: "---\ntitle: Nothing else\n---",
  unclosed: "---\ntitle: never closed\n\n# Heading\n",
  hrFirst: "---\n\nJust a rule\n",
  comments: "---\n# a comment\ntitle: \"Quoted: title\" # trailing\nrating: 4/5\nnested:\n  child: 1\n---\nx\n",
  tasks: taskFixture,
};

describe("splitFrontmatter / joinFrontmatter", () => {
  it.each(Object.entries(SAMPLES))("round-trips %s byte-identically", (_name, md) => {
    const { frontmatter, body } = splitFrontmatter(md);
    expect(joinFrontmatter(frontmatter, body)).toBe(md);
  });

  it("round-trips every note of the demo vault", () => {
    for (const note of buildVaultFixture(new Date(2026, 8, 23))) {
      const { frontmatter, body } = splitFrontmatter(note.content);
      expect(joinFrontmatter(frontmatter, body), note.rel).toBe(note.content);
    }
  });

  it("separates the block (with its blank lines) from the body", () => {
    expect(splitFrontmatter(SAMPLES.simple)).toEqual({
      frontmatter: "---\ntitle: Welcome\ntags: [start, meta]\n---\n",
      body: "# Welcome\n",
    });
    expect(splitFrontmatter(SAMPLES.gap)).toEqual({ frontmatter: "---\ntags: [a]\n---\n\n\n", body: "# After blank lines\n" });
    expect(splitFrontmatter(SAMPLES.crlf).body).toBe("Body\r\n");
    expect(splitFrontmatter(SAMPLES.bom).frontmatter).toBe("\uFEFF---\ntitle: BOM\n---\n");
    expect(splitFrontmatter(SAMPLES.dots).body).toBe("Body\n");
    expect(splitFrontmatter(SAMPLES.empty)).toEqual({ frontmatter: "---\n---\n", body: "Only body\n" });
    expect(splitFrontmatter(SAMPLES.onlyFrontmatter)).toEqual({ frontmatter: "---\ntitle: Nothing else\n---", body: "" });
  });

  it("treats a missing closing fence or a leading rule as no front matter", () => {
    for (const md of [SAMPLES.none, SAMPLES.unclosed, SAMPLES.hrFirst, "", "---"]) {
      expect(splitFrontmatter(md)).toEqual({ frontmatter: null, body: md });
    }
  });

  it("adds a line break when a body follows a block that ended the file", () => {
    expect(joinFrontmatter("---\na: 1\n---", "Body")).toBe("---\na: 1\n---\nBody");
    expect(joinFrontmatter(null, "Body")).toBe("Body");
  });

  it("counts the lines the block occupies", () => {
    expect(frontmatterLineCount(splitFrontmatter(taskFixture).frontmatter)).toBe(5);
    expect(frontmatterLineCount(splitFrontmatter(SAMPLES.gap).frontmatter)).toBe(5);
    expect(frontmatterLineCount(null)).toBe(0);
  });
});

describe("parseSimpleYaml", () => {
  it("reads scalars, flow lists and block lists", () => {
    const yaml = frontmatterYaml(splitFrontmatter(SAMPLES.crlf).frontmatter);
    expect(parseSimpleYaml(yaml)).toEqual({ title: "Windows", tags: ["one", "two"] });
    expect(parseSimpleYaml("title: Welcome\ntags: [start, meta]\n")).toEqual({ title: "Welcome", tags: ["start", "meta"] });
    expect(parseSimpleYaml("aliases:\n- First\n- 'Second, with comma'\nempty:\nlist: []\n")).toEqual({
      aliases: ["First", "Second, with comma"],
      empty: "",
      list: [],
    });
  });

  it("unquotes, drops comments and keeps colons inside values", () => {
    const yaml = frontmatterYaml(splitFrontmatter(SAMPLES.comments).frontmatter);
    const props = listProperties(yaml);
    expect(props.map((p) => p.key)).toEqual(["title", "rating", "nested"]);
    expect(parseSimpleYaml(yaml)).toMatchObject({ title: "Quoted: title", rating: "4/5" });
    expect(parseSimpleYaml('area: "[[Career]]"\nurl: https://example.com/a?b=c\ntime: 10:30\n')).toEqual({
      area: "[[Career]]",
      url: "https://example.com/a?b=c",
      time: "10:30",
    });
    expect(parseSimpleYaml('tags: ["a, b", c] # note\nsay: \'it\'\'s\'\n')).toEqual({ tags: ["a, b", "c"], say: "it's" });
  });

  it("marks unsupported YAML as read-only raw values", () => {
    const props = listProperties("nested:\n  child: 1\nblock: |\n  line one\n  line two\nmap: {a: 1}\nlinks: [[A]]\nok: yes\n");
    expect(props.map((p) => [p.key, p.style, p.editable])).toEqual([
      ["nested", "raw", false],
      ["block", "raw", false],
      ["map", "raw", false],
      ["links", "raw", false],
      ["ok", "scalar", true],
    ]);
    expect(props[0].value).toBe("child: 1");
  });

  it("records line ranges and keeps the first of duplicate keys", () => {
    const props = listProperties("a: 1\ntags:\n  - x\n\n  - y\nb: 2\na: 3\n");
    expect(props.map((p) => [p.key, p.startLine, p.endLine])).toEqual([
      ["a", 0, 1],
      ["tags", 1, 5],
      ["b", 5, 6],
      ["a", 6, 7],
    ]);
    expect(parseSimpleYaml("a: 1\na: 3\n").a).toBe("1");
  });
});

describe("editing properties", () => {
  const yaml = "# keep me\ntitle: Old\ntags: [a, b]\naliases:\n    - One\nrating: 4/5 # stars\n";

  it("rewrites only the edited property, in its own style", () => {
    expect(setProperty(yaml, "title", "New title")).toBe(yaml.replace("title: Old", "title: New title"));
    expect(setProperty(yaml, "tags", ["a", "b", "c"])).toBe(yaml.replace("tags: [a, b]", "tags: [a, b, c]"));
    expect(setProperty(yaml, "aliases", ["One", "Two"])).toBe(yaml.replace("    - One\n", "    - One\n    - Two\n"));
    expect(setProperty(yaml, "title", ["x"])).toContain("title: [x]\n");
  });

  it("appends new properties and quotes where YAML needs it", () => {
    expect(setProperty(yaml, "status", "done")).toBe(`${yaml}status: done`);
    expect(setProperty("a: 1", "note", "key: value")).toBe('a: 1\nnote: "key: value"');
    expect(setProperty("", "tags", ["x, y", "z"])).toBe('tags: ["x, y", z]');
    expect(() => setProperty(yaml, "bad: key", "v")).toThrow(/not a valid property name/);
    expect(() => setProperty("n:\n  c: 1\n", "n", "v")).toThrow(/cannot change/);
  });

  it("removes a property with its list lines", () => {
    expect(removeProperty(yaml, "aliases")).toBe("# keep me\ntitle: Old\ntags: [a, b]\nrating: 4/5 # stars\n");
    expect(removeProperty(yaml, "missing")).toBe(yaml);
    expect(removeProperty("a: 1\n", "a")).toBe("");
  });

  it("puts edited YAML back inside the original fences", () => {
    const { frontmatter } = splitFrontmatter(SAMPLES.crlf);
    const next = editFrontmatter(frontmatter, (y) => setProperty(y, "title", "Changed"));
    expect(next).toBe("---\r\ntitle: Changed\r\ntags:\r\n  - one\r\n  - two\r\n---\r\n\r\n");
    expect(editFrontmatter(null, (y) => setProperty(y, "tags", ["new"]))).toBe("---\ntags: [new]\n---\n");
    expect(editFrontmatter("---\na: 1\n---\n", (y) => removeProperty(y, "a"))).toBeNull();
    expect(replaceFrontmatterYaml("---\na: 1\n...\n\n", "b: 2\n")).toBe("---\nb: 2\n...\n\n");
  });

  it("formats scalars and validates keys", () => {
    expect(formatScalar("plain text")).toBe("plain text");
    expect(formatScalar("")).toBe('""');
    expect(formatScalar("#tag")).toBe('"#tag"');
    expect(formatScalar("true")).toBe('"true"');
    expect(formatScalar('say "hi": now')).toBe('"say \\"hi\\": now"');
    expect(formatScalar("a, b", { inFlow: true })).toBe('"a, b"');
    expect(isValidPropertyKey("due date")).toBe(true);
    expect(isValidPropertyKey(" ")).toBe(false);
    expect(isValidPropertyKey("-x")).toBe(false);
  });

  it("normalises tag values", () => {
    expect(normalizeTags(["#a", "b", "a"])).toEqual(["a", "b"]);
    expect(normalizeTags("#x, y z")).toEqual(["x", "y", "z"]);
    expect(normalizeTags(undefined)).toEqual([]);
  });
});
