import { describe, expect, it } from "vitest";
import {
  addTagToContent,
  buildDocTerms,
  extractTags,
  extractWikilinks,
  frontmatterTags,
  normalizeTag,
  rankByKeywords,
  rankTags,
  splitFrontmatter,
  tokenize,
} from "./keywords";

const doc = (path: string, name: string, content: string) => buildDocTerms(path, name, content);

describe("tokenizer (mirrors suggestions.rs)", () => {
  it("drops short words, numbers and stopwords", () => {
    expect(tokenize("The Rust borrow-checker: 2024 & lifetimes, über Äpfel!")).toEqual([
      "rust",
      "borrow",
      "checker",
      "lifetimes",
      "äpfel",
    ]);
    expect(tokenize("and the for mit und")).toEqual([]);
  });

  it("splits frontmatter and extracts tags and links", () => {
    expect(splitFrontmatter("---\ntags: [a]\n---\n# Body\n")).toEqual({ frontmatter: "tags: [a]", body: "# Body\n" });
    expect(splitFrontmatter("# none\n").frontmatter).toBeNull();
    const content =
      "---\ntags:\n  - rust\n  - \"learning\"\n---\n# Title\nSome #inline and #nested/tag.\n`#code` and #123\n```\n#fenced\n```\nurl.com/#anchor #Rust";
    expect(extractTags(content)).toEqual(["rust", "learning", "inline", "nested/tag"]);
    expect(frontmatterTags("tags: a, b")).toEqual(["a", "b"]);
    const links = extractWikilinks("See [[Rust Ownership]], [[Berlin|the move]] and [[Thesis#Plan]].");
    expect([...links].sort()).toEqual(["berlin", "rust ownership", "thesis"]);
  });
});

describe("keyword ranking", () => {
  it("prefers notes sharing distinctive terms and excludes the note itself", () => {
    const docs = [
      doc("/v/Rust Ownership.md", "Rust Ownership", "Borrowing, lifetimes and the borrow checker in Rust."),
      doc("/v/Berlin Move.md", "Berlin Move", "Book a moving van, register at the Bürgeramt in Berlin."),
      doc("/v/Pasta.md", "Pasta", "Boil water, add salt, cook pasta for ten minutes."),
      doc("/v/Lifetimes.md", "Lifetimes", "x"),
    ];
    const ranked = rankByKeywords(
      "Understanding lifetimes: the borrow checker rejects dangling references in Rust.",
      docs,
      "/v/Lifetimes.md",
      5
    );
    expect(ranked[0].name).toBe("Rust Ownership");
    expect(ranked[0].kind).toBe("keywords");
    expect(ranked[0].reason).toMatch(/^keywords: /);
    expect(ranked.some((s) => s.path === "/v/Lifetimes.md")).toBe(false);
    expect(ranked.some((s) => s.name === "Pasta")).toBe(false);
  });

  it("explains shared tags and flags linked notes", () => {
    const docs = [
      doc("/v/a.md", "Alpha", "Planning notes #thesis about evaluation metrics."),
      doc("/v/b.md", "Beta", "Evaluation metrics for retrieval systems."),
    ];
    const ranked = rankByKeywords("Draft on evaluation metrics #thesis", docs, null, 5);
    expect(ranked[0]).toMatchObject({ name: "Alpha", kind: "tags", reason: "shares #thesis", linked: false });
    const linked = rankByKeywords("Evaluation metrics, see [[Beta]]", docs, null, 5);
    expect(linked.find((s) => s.name === "Beta")?.linked).toBe(true);
    expect(linked.find((s) => s.name === "Alpha")?.linked).toBe(false);
  });

  it("returns nothing for empty queries", () => {
    const docs = [doc("/v/a.md", "Alpha", "Evaluation metrics.")];
    expect(rankByKeywords("", docs, null, 5)).toEqual([]);
    expect(rankByKeywords("and the", docs, null, 5)).toEqual([]);
    expect(rankByKeywords("metrics", [], null, 5)).toEqual([]);
  });

  it("ranks tags by evidence and skips tags already present", () => {
    const docs = [
      doc("/v/a.md", "Rust Ownership", "#rust borrow checker lifetimes"),
      doc("/v/b.md", "Move", "#berlin moving van apartment"),
      doc("/v/c.md", "Traits", "#rust traits generics"),
      doc("/v/d.md", "Borrowing", "#rust borrow checker errors"),
    ];
    expect(rankTags("Notes on lifetimes and the borrow checker", docs, 5)[0]).toBe("rust");
    expect(rankTags("lifetimes and the borrow checker #rust", docs, 5)).not.toContain("rust");
    expect(rankTags("Looking for an apartment in berlin", docs, 3)).toEqual(["berlin"]);
  });
});

describe("tag insertion (mirrors add_tag_to_content)", () => {
  it("validates tags", () => {
    expect(normalizeTag("#rust")).toBe("rust");
    expect(() => normalizeTag("two words")).toThrow(/invalid tag/);
    expect(() => normalizeTag("2024")).toThrow();
    expect(() => normalizeTag("#")).toThrow();
  });

  it("merges into frontmatter lists in their existing style", () => {
    expect(addTagToContent("---\ntags: [a, b]\n---\n# X\n", "c").content).toBe("---\ntags: [a, b, c]\n---\n# X\n");
    expect(addTagToContent("---\ntags: [a, c]\n---\n", "#C").changed).toBe(false);
    expect(addTagToContent("---\ntags: a, b\n---\n", "c").content).toBe("---\ntags: a, b, c\n---\n");
    expect(addTagToContent("---\ntags: a\n---\n", "c").content).toBe("---\ntags: [a, c]\n---\n");
    expect(addTagToContent("---\ntags:\n    - a\nstatus: x\n---\nbody", "c").content).toBe(
      "---\ntags:\n    - a\n    - c\nstatus: x\n---\nbody"
    );
    expect(addTagToContent("---\ntitle: T\n---\nbody", "new").content).toBe("---\ntitle: T\ntags: [new]\n---\nbody");
  });

  it("appends inline tags without frontmatter", () => {
    const first = addTagToContent("# Note\n\nSome text.\n", "rust");
    expect(first.content).toBe("# Note\n\nSome text.\n\n#rust\n");
    expect(addTagToContent(first.content, "learning").content).toBe("# Note\n\nSome text.\n\n#rust #learning\n");
    expect(addTagToContent(first.content, "Rust").changed).toBe(false);
    expect(addTagToContent("", "x").content).toBe("#x\n");
    expect(addTagToContent("line\r\n", "x").content).toBe("line\r\n\r\n#x\r\n");
  });
});
