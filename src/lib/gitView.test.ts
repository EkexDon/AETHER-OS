import { describe, expect, it } from "vitest";
import {
  changeLabel,
  describeSyncState,
  fileNameOf,
  formatRelativeTime,
  groupChanges,
} from "./gitView";
import type { GitStatusEntry } from "../types";

const entry = (over: Partial<GitStatusEntry>): GitStatusEntry => ({
  path: "a.txt",
  staged: null,
  unstaged: null,
  ...over,
});

describe("gitView", () => {
  describe("groupChanges", () => {
    it("splits staged and unstaged entries", () => {
      const { staged, unstaged } = groupChanges([
        entry({ path: "staged-only.txt", staged: "modified" }),
        entry({ path: "unstaged-only.txt", unstaged: "added" }),
        entry({ path: "both.txt", staged: "modified", unstaged: "modified" }),
      ]);
      expect(staged.map((e) => e.path)).toEqual(["staged-only.txt", "both.txt"]);
      expect(unstaged.map((e) => e.path)).toEqual(["unstaged-only.txt", "both.txt"]);
    });

    it("keeps order stable", () => {
      const { staged } = groupChanges([
        entry({ path: "b.txt", staged: "added" }),
        entry({ path: "a.txt", staged: "added" }),
      ]);
      expect(staged.map((e) => e.path)).toEqual(["b.txt", "a.txt"]);
    });
  });

  describe("changeLabel", () => {
    it("maps kinds to git status letters", () => {
      expect(changeLabel("added")).toBe("A");
      expect(changeLabel("modified")).toBe("M");
      expect(changeLabel("deleted")).toBe("D");
      expect(changeLabel("renamed")).toBe("R");
      expect(changeLabel("typechange")).toBe("T");
    });
  });

  describe("formatRelativeTime", () => {
    const now = 1_700_000_000;
    it("shows seconds-old commits as now", () => {
      expect(formatRelativeTime(now - 30, now)).toBe("now");
    });
    it("shows minutes below one hour", () => {
      expect(formatRelativeTime(now - 5 * 60, now)).toBe("5m");
    });
    it("shows hours below one day", () => {
      expect(formatRelativeTime(now - 3 * 3600, now)).toBe("3h");
    });
    it("shows days below a month", () => {
      expect(formatRelativeTime(now - 2 * 86400, now)).toBe("2d");
    });
    it("falls back to a date for older commits", () => {
      expect(formatRelativeTime(now - 60 * 86400, now)).not.toBe("");
    });
  });

  describe("describeSyncState", () => {
    it("is empty when synced", () => {
      expect(describeSyncState(0, 0)).toBe("");
    });
    it("marks ahead and behind counts", () => {
      expect(describeSyncState(1, 0)).toBe("↑1");
      expect(describeSyncState(0, 2)).toBe("↓2");
      expect(describeSyncState(3, 4)).toBe("↑3 ↓4");
    });
  });

  describe("fileNameOf", () => {
    it("returns the basename of repo-relative paths", () => {
      expect(fileNameOf("src/lib/main.rs")).toBe("main.rs");
      expect(fileNameOf("README.md")).toBe("README.md");
    });
  });
});
