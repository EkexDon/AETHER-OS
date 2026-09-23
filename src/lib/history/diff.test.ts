import { describe, expect, it } from "vitest";
import {
  collapseUnchanged,
  diffLines,
  diffStats,
  hasChanges,
  inlineChange,
  pairInlineChanges,
  splitLines,
  toSplitRows,
  type DiffLine,
} from "./diff";

const kinds = (lines: DiffLine[]) => lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "remove" ? "-" : " "}${l.text}`);

/** Rebuild both texts from a diff (proves the edit script is complete). */
function reconstruct(lines: DiffLine[]) {
  return {
    old: lines.filter((l) => l.kind !== "add").map((l) => l.text),
    new: lines.filter((l) => l.kind !== "remove").map((l) => l.text),
  };
}

/** Deterministic pseudo-random generator for the property test. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Classic LCS length to check that Myers produces a minimal script. */
function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

describe("splitLines", () => {
  it("handles empty input, trailing newlines and CRLF", () => {
    expect(splitLines(null)).toEqual([]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(splitLines("a\r\nb\rc\n\n")).toEqual(["a", "b", "c", ""]);
  });
});

describe("diffLines", () => {
  it("reports identical texts as unchanged", () => {
    const lines = diffLines("a\nb\n", "a\nb\n");
    expect(kinds(lines)).toEqual([" a", " b"]);
    expect(hasChanges(lines)).toBe(false);
  });

  it("treats a missing side as all added / all removed", () => {
    expect(kinds(diffLines(null, "x\ny"))).toEqual(["+x", "+y"]);
    expect(kinds(diffLines("x\ny", null))).toEqual(["-x", "-y"]);
    expect(diffLines(null, null)).toEqual([]);
  });

  it("finds insertions, deletions and replacements with line numbers", () => {
    const lines = diffLines("# Plan\n- a\n- b\n- c\n", "# Plan\n- a\n- B\n- c\n- d\n");
    expect(kinds(lines)).toEqual([" # Plan", " - a", "-- b", "+- B", " - c", "+- d"]);
    expect(lines[2]).toMatchObject({ oldNumber: 3, newNumber: null });
    expect(lines[3]).toMatchObject({ oldNumber: null, newNumber: 3 });
    expect(lines[5]).toMatchObject({ oldNumber: null, newNumber: 5 });
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it("produces a minimal, complete edit script for random edits", () => {
    const random = rng(42);
    const alphabet = ["alpha", "beta", "gamma", "delta", "- [ ] task", "", "## Heading"];
    for (let round = 0; round < 60; round++) {
      const a = Array.from({ length: Math.floor(random() * 25) }, () => alphabet[Math.floor(random() * alphabet.length)]);
      const b = a.filter(() => random() > 0.25);
      for (let k = 0; k < 4; k++) b.splice(Math.floor(random() * (b.length + 1)), 0, alphabet[Math.floor(random() * alphabet.length)]);
      const lines = diffLines(a.join("\n"), b.join("\n"));
      const rebuilt = reconstruct(lines);
      // splitLines drops one trailing empty line, mirror that here.
      const norm = (x: string[]) => splitLines(x.join("\n"));
      expect(rebuilt.old).toEqual(norm(a));
      expect(rebuilt.new).toEqual(norm(b));
      const equal = lines.filter((l) => l.kind === "equal").length;
      expect(equal).toBe(lcsLength(norm(a), norm(b)));
    }
  });

  it("falls back to replace-all beyond the edit distance limit but stays correct", () => {
    const a = Array.from({ length: 40 }, (_, i) => `old ${i}`).join("\n");
    const b = Array.from({ length: 40 }, (_, i) => `new ${i}`).join("\n");
    const lines = diffLines(`head\n${a}\ntail`, `head\n${b}\ntail`, { maxEditDistance: 5 });
    expect(lines[0]).toMatchObject({ kind: "equal", text: "head" });
    expect(lines[lines.length - 1]).toMatchObject({ kind: "equal", text: "tail" });
    expect(diffStats(lines)).toEqual({ added: 40, removed: 40 });
  });
});

describe("collapseUnchanged", () => {
  const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

  it("folds long unchanged runs but keeps context around changes", () => {
    const changed = [...long];
    changed[14] = "changed";
    const segments = collapseUnchanged(diffLines(long.join("\n"), changed.join("\n")), 3);
    expect(segments.map((s) => s.type)).toEqual(["collapsed", "lines", "collapsed"]);
    const visible = segments[1].lines;
    expect(visible[0].text).toBe("line 12");
    expect(visible[visible.length - 1].text).toBe("line 18");
    expect(segments[0].lines).toHaveLength(11);
    expect(segments[2].lines).toHaveLength(12);
  });

  it("keeps short runs and diffs without changes visible", () => {
    expect(collapseUnchanged(diffLines("a\nb", "a\nc"), 3).map((s) => s.type)).toEqual(["lines"]);
    const same = collapseUnchanged(diffLines(long.join("\n"), long.join("\n")));
    expect(same).toHaveLength(1);
    expect(same[0].type).toBe("lines");
    expect(collapseUnchanged([])).toEqual([]);
  });
});

describe("side-by-side and inline changes", () => {
  it("pairs removed and added lines row by row", () => {
    const rows = toSplitRows(diffLines("a\nb\nc\nd", "a\nB\nC\nX\nd"));
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["a", "a"],
      ["b", "B"],
      ["c", "C"],
      [null, "X"],
      ["d", "d"],
    ]);
  });

  it("highlights the changed middle of a modified line", () => {
    expect(inlineChange("- [ ] Write tests", "- [x] Write tests")).toEqual({
      old: { start: 3, end: 4 },
      new: { start: 3, end: 4 },
    });
    expect(inlineChange("same", "same")).toBeNull();
    expect(inlineChange("abc", "xyz")).toBeNull();

    const lines = diffLines("keep\n- [ ] task\n", "keep\n- [x] task\n");
    const spans = pairInlineChanges(lines);
    expect(spans.get(1)).toEqual({ start: 3, end: 4 });
    expect(spans.get(2)).toEqual({ start: 3, end: 4 });
    expect(spans.has(0)).toBe(false);
  });
});
