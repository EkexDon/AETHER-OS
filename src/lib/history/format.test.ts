import { describe, expect, it } from "vitest";
import type { HistoryActivity, NoteVersion } from "../../types";
import {
  commitKind,
  countLabel,
  dayKey,
  dayLabel,
  describeActivity,
  groupByDay,
  isNotePath,
  matchNotes,
  noteFolder,
  noteTitle,
  relativeTime,
  relativeToVault,
  versionLabel,
} from "./format";

/** 2026-09-23 15:00 local time. */
const NOW = new Date(2026, 8, 23, 15, 0, 0).getTime();
const at = (d: Date) => Math.floor(d.getTime() / 1000);
const ago = (seconds: number) => Math.floor(NOW / 1000) - seconds;

function activity(partial: Partial<HistoryActivity>): HistoryActivity {
  return {
    commit_id: "a".repeat(40),
    short_id: "aaaaaaa",
    time: ago(60),
    message: "note: Inbox/Idea.md",
    files: [{ rel_path: "Inbox/Idea.md", path: "/v/Inbox/Idea.md", change: "modified" }],
    file_count: 1,
    ...partial,
  };
}

describe("relativeTime", () => {
  it("uses short relative labels", () => {
    expect(relativeTime(ago(10), NOW)).toBe("just now");
    expect(relativeTime(ago(-30), NOW)).toBe("just now");
    expect(relativeTime(ago(5 * 60), NOW)).toBe("5m ago");
    expect(relativeTime(ago(3 * 3600), NOW)).toBe("3h ago");
    expect(relativeTime(at(new Date(2026, 8, 22, 9, 0)), NOW)).toBe("yesterday");
    expect(relativeTime(at(new Date(2026, 8, 19, 9, 0)), NOW)).toBe("4d ago");
  });

  it("falls back to a date for older timestamps", () => {
    const label = relativeTime(at(new Date(2026, 6, 2, 9, 0)), NOW);
    expect(label).not.toMatch(/ago/);
    expect(label).toMatch(/2/);
  });
});

describe("day grouping", () => {
  it("labels today and yesterday and keeps input order", () => {
    const items = [
      { id: 1, time: ago(60) },
      { id: 2, time: ago(3600) },
      { id: 3, time: at(new Date(2026, 8, 22, 18, 0)) },
      { id: 4, time: at(new Date(2026, 8, 14, 18, 0)) },
    ];
    const groups = groupByDay(items, NOW);
    expect(groups.map((g) => g.label.split(",")[0])).toEqual(["Today", "Yesterday", expect.any(String)]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([[1, 2], [3], [4]]);
    expect(groups[0].key).toBe("2026-09-23");
    expect(dayKey(items[3].time)).toBe("2026-09-14");
    expect(dayLabel(items[3].time, NOW)).not.toMatch(/Today|Yesterday/);
  });
});

describe("paths", () => {
  it("derives titles, folders and vault-relative paths", () => {
    expect(noteTitle("01-Projects/AETHER-OS.md")).toBe("AETHER-OS");
    expect(noteTitle("/Users/me/Vault/Welcome.MD")).toBe("Welcome");
    expect(noteFolder("01-Projects/Sub/Note.md")).toBe("01-Projects/Sub");
    expect(noteFolder("Note.md")).toBe("");
    expect(relativeToVault("/Users/me/Vault/a/b.md", "/Users/me/Vault")).toBe("a/b.md");
    expect(relativeToVault("/Users/me/Vault/a/b.md", "/Users/me/Vault/")).toBe("a/b.md");
    expect(relativeToVault("/Users/me/Other/b.md", "/Users/me/Vault")).toBeNull();
    expect(relativeToVault("/Users/me/Vault2/b.md", "/Users/me/Vault")).toBeNull();
    expect(relativeToVault("/x.md", null)).toBeNull();
    expect(isNotePath("a/b.md")).toBe(true);
    expect(isNotePath("a/b.png")).toBe(false);
  });

  it("ranks note matches by name", () => {
    const notes = [
      { path: "/v/03-Resources/Rust Ownership.md", name: "Rust Ownership" },
      { path: "/v/01-Projects/Trust.md", name: "Trust" },
      { path: "/v/Rust.md", name: "Rust" },
      { path: "/v/rustacean/Notes.md", name: "Notes" },
    ];
    expect(matchNotes(notes, "rust").map((n) => n.name)).toEqual(["Rust", "Rust Ownership", "Trust", "Notes"]);
    expect(matchNotes(notes, "  ")).toEqual([]);
    expect(matchNotes(notes, "rust", 2)).toHaveLength(2);
  });
});

describe("commit descriptions", () => {
  it("classifies commit messages", () => {
    expect(commitKind("note: a.md")).toBe("note");
    expect(commitKind("notes: 3 files")).toBe("notes");
    expect(commitKind("notes: initial snapshot (12 files)")).toBe("initial");
    expect(commitKind("restore: a.md to abc1234")).toBe("restore");
    expect(commitKind("Merge branch main")).toBe("other");
  });

  it("describes single, multi-file, restore and initial commits", () => {
    expect(describeActivity(activity({}))).toEqual({ title: "Idea", detail: "Edited in Inbox" });
    expect(
      describeActivity(
        activity({ files: [{ rel_path: "Top.md", path: "/v/Top.md", change: "added" }], message: "note: Top.md" })
      )
    ).toEqual({ title: "Top", detail: "Created" });
    expect(describeActivity(activity({ message: "restore: Inbox/Idea.md to 1a2b3c4" }))).toEqual({
      title: "Restored Idea",
      detail: "to version 1a2b3c4",
    });
    expect(describeActivity(activity({ message: "notes: 3 files", file_count: 3 })).title).toBe("3 files changed");
    expect(describeActivity(activity({ message: "notes: initial snapshot (40 files)", file_count: 40 }))).toEqual({
      title: "History started",
      detail: "40 files captured",
    });
    expect(countLabel(1, "version")).toBe("1 version");
    expect(countLabel(2, "version")).toBe("2 versions");
  });

  it("labels versions", () => {
    const base: NoteVersion = {
      id: "b".repeat(40),
      short_id: "bbbbbbb",
      time: ago(10),
      message: "note: a.md",
      author: "AETHER-OS",
      change: "modified",
      summary_added: 1,
      summary_removed: 0,
    };
    expect(versionLabel(base)).toBe("Edited");
    expect(versionLabel({ ...base, change: "added" })).toBe("Created");
    expect(versionLabel({ ...base, change: "deleted" })).toBe("Deleted");
    expect(versionLabel({ ...base, message: "restore: a.md to 1234567" })).toBe("Restored");
    expect(versionLabel({ ...base, message: "notes: initial snapshot (2 files)", change: "added" })).toBe(
      "First snapshot"
    );
  });
});
