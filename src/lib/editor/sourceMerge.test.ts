import { describe, expect, it } from "vitest";
import { diffLines, looseLineKey, merge3, mergeChars, mergeSource, type Hunk } from "./sourceMerge";

/** Apply hunks of a diff a → b to a; must give b. */
function apply(a: string[], b: string[], hunks: Hunk[]): string[] {
  const out: string[] = [];
  let pos = 0;
  for (const h of hunks) {
    out.push(...a.slice(pos, h.aStart), ...b.slice(h.bStart, h.bEnd));
    pos = h.aEnd;
  }
  return [...out, ...a.slice(pos)];
}

/** Length of the longest common subsequence (reference for Myers). */
function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  return dp[a.length][b.length];
}

function seeded(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

describe("diffLines", () => {
  it("returns no hunks for equal input and one hunk for pure insertions/deletions", () => {
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([]);
    expect(diffLines(["a"], ["a", "b", "c"])).toEqual([{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 3 }]);
    expect(diffLines(["a", "b", "c"], ["c"])).toEqual([{ aStart: 0, aEnd: 2, bStart: 0, bEnd: 0 }]);
  });

  it("produces a minimal edit script that transforms a into b", () => {
    const random = seeded(7);
    const alphabet = ["", "a", "b", "c", "- x", "## h"];
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: Math.floor(random() * 14) }, () => alphabet[Math.floor(random() * alphabet.length)]);
      const b = Array.from({ length: Math.floor(random() * 14) }, () => alphabet[Math.floor(random() * alphabet.length)]);
      const hunks = diffLines(a, b);
      expect(apply(a, b, hunks)).toEqual(b);
      const kept = a.length - hunks.reduce((n, h) => n + (h.aEnd - h.aStart), 0);
      expect(kept).toBe(lcs(a, b));
    }
  });

  it("pairs lines with the same loose key as one-line changes", () => {
    const hunks = diffLines(["P", "", "- [ ] task", "", "## H"], ["P", "  - [ ] task", "", "## H"], looseLineKey);
    expect(hunks).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 },
      { aStart: 2, aEnd: 3, bStart: 1, bEnd: 2 },
    ]);
    expect(looseLineKey("  \\# a   b ")).toBe("# a b");
  });
});

describe("merge3", () => {
  const base = ["# T", "", "- a", "- b", "", "end"];

  it("takes each side's change where only that side changed", () => {
    const ours = ["# T", "- a", "- b", "", "end"]; // the author's tight list
    const theirs = ["# T", "", "- a", "- b", "", "end!"]; // the user's edit
    expect(merge3(base, ours, theirs, "loose")).toEqual({ lines: ["# T", "- a", "- b", "", "end!"], ambiguous: false });
  });

  it("merges lines both sides changed character by character, and reports it", () => {
    const ours = ["# T", "", "* a", "* b", "", "end"];
    const theirs = ["# T", "", "- a", "- b2", "", "end"];
    const result = merge3(base, ours, theirs, "loose");
    expect(result.lines).toEqual(["# T", "", "* a", "* b2", "", "end"]);
    expect(result.ambiguous).toBe(true);
  });

  it("lets the edit win where both sides changed the same lines differently", () => {
    const ours = ["# T", "", "* a", "* b", "", "end"];
    const theirs = ["# T", "", "- a", "", "b as paragraph", "", "end"];
    expect(merge3(base, ours, theirs, "loose").lines).toEqual(["# T", "", "- a", "", "b as paragraph", "", "end"]);
  });

  it("flags edits that only touch the author's changes (loose) and joins them (strict)", () => {
    const ours = ["# T", "- a", "- b", "", "end"];
    const theirs = ["# T", "", "- a2", "- b", "", "end"];
    expect(merge3(base, ours, theirs, "loose")).toEqual({ lines: ["# T", "- a2", "- b", "", "end"], ambiguous: true });
    expect(merge3(base, ours, theirs, "strict").lines).toEqual(["# T", "", "- a2", "- b", "", "end"]);
  });

  it("merges one line character by character", () => {
    expect(mergeChars("- [x] Done", "- [X] Done", "- [x] Done edited")).toBe("- [X] Done edited");
    expect(mergeChars("- [ ] a", "- [ ] a   ", "- [x] a")).toBe("- [x] a   ");
    expect(mergeChars("- [x] a", "- [X] a", "- [ ] a")).toBeNull();
  });
});

describe("mergeSource", () => {
  const base = { source: "# T\n- a\n- b\n\nend\n", canonical: "# T\n\n- a\n- b\n\nend" };

  it("returns the original bytes when nothing changed", () => {
    expect(mergeSource(base, base.canonical)).toBe(base.source);
  });

  it("returns the serialization when the file was canonical already", () => {
    const canonical = { source: "a\n\nb", canonical: "a\n\nb" };
    expect(mergeSource(canonical, "a\n\nb!")).toBe("a\n\nb!");
  });

  it("applies an edit to the original, keeping its trailing newline", () => {
    expect(mergeSource(base, "# T\n\n- a\n- b\n\nthe end")).toBe("# T\n- a\n- b\n\nthe end\n");
  });

  it("keeps CRLF line endings", () => {
    const crlf = { source: "# T\r\n- a\r\n", canonical: "# T\n\n- a" };
    expect(mergeSource(crlf, crlf.canonical)).toBe(crlf.source);
    expect(mergeSource(crlf, "# T\n\n- a\n- b")).toBe("# T\r\n- a\r\n- b\r\n");
  });

  it("verifies ambiguous merges and falls back step by step", () => {
    const next = "# T\n\n- a2\n- b\n\nend";
    expect(mergeSource(base, next, () => true)).toBe("# T\n- a2\n- b\n\nend\n");
    const tried: string[] = [];
    const strictOnly = (candidate: string) => {
      tried.push(candidate);
      return candidate.startsWith("# T\n\n");
    };
    expect(mergeSource(base, next, strictOnly)).toBe("# T\n\n- a2\n- b\n\nend\n");
    expect(tried).toHaveLength(2);
    expect(mergeSource(base, next, () => false)).toBe(next);
  });

  it("handles an emptied note", () => {
    expect(mergeSource(base, "")).toBe("\n");
  });
});
