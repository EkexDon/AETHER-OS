import { describe, expect, it } from "vitest";
import { collapseRows, diffLines, diffStats, sideBySide, splitLines, type DiffOp } from "./diff";

/** Length of the longest common subsequence (reference for minimality). */
function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Rebuild both sides from a diff; they must equal the inputs. */
function reconstruct(ops: DiffOp[]): { left: string[]; right: string[] } {
  const left: string[] = [];
  const right: string[] = [];
  for (const op of ops) {
    if (op.type !== "insert") left.push(op.text);
    if (op.type !== "delete") right.push(op.text);
  }
  return { left, right };
}

describe("splitLines", () => {
  it("handles empty text, CRLF and a trailing newline", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
  });
});

describe("diffLines", () => {
  it("returns only equal ops for identical text", () => {
    const ops = diffLines("a\nb\nc", "a\nb\nc");
    expect(ops.every((o) => o.type === "equal")).toBe(true);
    expect(diffStats(ops)).toEqual({ added: 0, removed: 0, unchanged: 3 });
  });

  it("finds a minimal edit for a changed line", () => {
    const ops = diffLines("# Plan\nship it\ndone", "# Plan\nship it today\ndone");
    expect(ops.map((o) => o.type)).toEqual(["equal", "delete", "insert", "equal"]);
    expect(ops[1]).toMatchObject({ text: "ship it", leftLine: 2 });
    expect(ops[2]).toMatchObject({ text: "ship it today", rightLine: 2 });
  });

  it("handles pure insertions and deletions", () => {
    expect(diffStats(diffLines("", "a\nb"))).toEqual({ added: 2, removed: 0, unchanged: 0 });
    expect(diffStats(diffLines("a\nb", ""))).toEqual({ added: 0, removed: 2, unchanged: 0 });
    const ops = diffLines("a\nc", "a\nb\nc");
    expect(ops.map((o) => o.type)).toEqual(["equal", "insert", "equal"]);
  });

  it("always reconstructs both inputs (randomised)", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 200; round++) {
      const pick = () => Array.from({ length: Math.floor(rand() * 12) }, () => "abcde"[Math.floor(rand() * 5)]);
      const a = pick();
      const b = pick();
      const ops = diffLines(a.join("\n"), b.join("\n"));
      const rebuilt = reconstruct(ops);
      expect(rebuilt.left).toEqual(a);
      expect(rebuilt.right).toEqual(b);
      // Myers is minimal: the unchanged lines form a longest common subsequence.
      expect(diffStats(ops).unchanged).toBe(lcs(a, b));
    }
  });

  it("falls back to a full replacement beyond the edit budget", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join("\n");
    const ops = diffLines(a, b, 10);
    expect(diffStats(ops)).toEqual({ added: 50, removed: 50, unchanged: 0 });
    const rebuilt = reconstruct(ops);
    expect(rebuilt.left.length).toBe(50);
  });
});

describe("sideBySide", () => {
  it("pairs removals with additions", () => {
    const rows = sideBySide(diffLines("x\nold 1\nold 2\ny", "x\nnew 1\ny\nz"));
    expect(rows.map((r) => r.kind)).toEqual(["equal", "change", "delete", "equal", "insert"]);
    expect(rows[1].left?.text).toBe("old 1");
    expect(rows[1].right?.text).toBe("new 1");
    expect(rows[2].right).toBeNull();
    expect(rows[4].left).toBeNull();
    expect(rows[4].right).toEqual({ line: 4, text: "z" });
  });
});

describe("collapseRows", () => {
  it("folds long unchanged stretches but keeps context", () => {
    const left = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const right = [...left];
    right[10] = "changed";
    const rows = collapseRows(sideBySide(diffLines(left.join("\n"), right.join("\n"))), 2);
    const kinds = rows.map((r) => r.kind);
    expect(kinds[0]).toBe("skip");
    expect(kinds.filter((k) => k === "change")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "skip")).toHaveLength(2);
    const visible = rows.filter((r) => r.kind !== "skip");
    expect(visible).toHaveLength(5);
  });

  it("leaves short runs alone", () => {
    const rows = collapseRows(sideBySide(diffLines("a\nb\nc", "a\nx\nc")), 3);
    expect(rows.some((r) => r.kind === "skip")).toBe(false);
  });
});
