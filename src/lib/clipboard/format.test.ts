import { describe, expect, it } from "vitest";
import type { ClipItem } from "../../types";
import {
  displayPreview,
  formatBytes,
  imageDimensions,
  kindLabel,
  lineCount,
  relativeTime,
  rowDescription,
  statsSummary,
  suggestNoteTitle,
  urlHost,
  urlHref,
  wordCount,
} from "./format";

const clip = (patch: Partial<ClipItem>): ClipItem => ({
  id: "00000000-0000-4000-8000-000000000001",
  kind: "text",
  content: "hello",
  preview: "hello",
  byte_len: 5,
  pinned: false,
  source_app: null,
  copy_count: 1,
  created_at: "2026-09-22T10:00:00.000Z",
  last_copied_at: "2026-09-22T10:00:00.000Z",
  truncated: false,
  ...patch,
});

describe("relativeTime", () => {
  const now = new Date(2026, 8, 22, 15, 0, 0);
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("uses compact units for today", () => {
    expect(relativeTime(ago(20_000), now)).toBe("now");
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5m");
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe("3h");
  });

  it("uses Yesterday, weekdays and dates further back", () => {
    expect(relativeTime(new Date(2026, 8, 21, 23, 0).toISOString(), now)).toBe("Yesterday");
    expect(relativeTime(new Date(2026, 8, 18, 12, 0).toISOString(), now)).toBe("Fri");
    expect(relativeTime(new Date(2026, 7, 3, 12, 0).toISOString(), now)).toBe("3 Aug");
    expect(relativeTime(new Date(2025, 11, 24, 12, 0).toISOString(), now)).toBe("24 Dec 2025");
  });

  it("returns an empty string for invalid dates", () => {
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("formatBytes", () => {
  it("formats binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(25 * 1024)).toBe("25 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
    expect(formatBytes(-1)).toBe("0 B");
  });
});

describe("previews and descriptions", () => {
  it("renders image dimensions", () => {
    expect(imageDimensions("1440x900")).toEqual({ width: 1440, height: 900 });
    expect(imageDimensions("oops")).toBeNull();
    expect(displayPreview(clip({ kind: "image", preview: "1440x900" }))).toBe("1440 × 900");
    expect(displayPreview(clip({ kind: "text", preview: "1440x900" }))).toBe("1440x900");
  });

  it("describes rows by kind", () => {
    expect(rowDescription(clip({ kind: "code", content: "a\nb\nc\n", copy_count: 3 }))).toBe("Code · 3 lines · copied 3×");
    expect(rowDescription(clip({ content: "  hi  " }))).toBe("Text · 2 chars");
    expect(rowDescription(clip({ kind: "url", content: "https://github.com/x" }))).toBe("Link · github.com");
    expect(rowDescription(clip({ kind: "image", byte_len: 2048 }))).toBe("Image · 2.0 KB");
    expect(rowDescription(clip({ kind: "color", content: "#fff" }))).toBe("Color");
    expect(kindLabel("url")).toBe("Link");
  });

  it("counts lines and words", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("one")).toBe(1);
    expect(lineCount("one\ntwo\n")).toBe(2);
    expect(wordCount("  hello   big world ")).toBe(3);
    expect(wordCount("   ")).toBe(0);
  });

  it("summarises stats", () => {
    expect(statsSummary(null)).toBe("Loading history…");
    expect(statsSummary({ total: 0, pinned: 0, bytes: 0 })).toBe("No clips yet");
    expect(statsSummary({ total: 1, pinned: 0, bytes: 100 })).toBe("1 clip · 100 B");
    expect(statsSummary({ total: 1204, pinned: 3, bytes: 2048 })).toBe("1,204 clips · 3 pinned · 2.0 KB");
  });
});

describe("urls", () => {
  it("extracts hosts and safe hrefs", () => {
    expect(urlHost("https://docs.rs/rusqlite")).toBe("docs.rs");
    expect(urlHost("www.rust-lang.org")).toBe("www.rust-lang.org");
    expect(urlHost("not a url")).toBeNull();
    expect(urlHref("www.rust-lang.org/learn")).toBe("https://www.rust-lang.org/learn");
    expect(urlHref("mailto:a@b.de")).toBe("mailto:a@b.de");
    expect(urlHref("javascript:alert(1)")).toBeNull();
    expect(urlHref("file:///etc/passwd")).toBeNull();
  });
});

describe("suggestNoteTitle", () => {
  it("derives a filesystem-safe title per kind", () => {
    expect(suggestNoteTitle(clip({ preview: "Meeting: Q3/Q4 plan #work" }))).toBe("Meeting Q3 Q4 plan work");
    expect(suggestNoteTitle(clip({ kind: "url", content: "https://github.com/a/b", preview: "https://github.com/a/b" }))).toBe(
      "Link github.com"
    );
    expect(suggestNoteTitle(clip({ kind: "image", preview: "640x480" }))).toBe("Image 640 × 480");
    expect(suggestNoteTitle(clip({ kind: "color", content: "#3fb0a3" }))).toBe("Color 3fb0a3");
    expect(suggestNoteTitle(clip({ preview: "///" }))).toBe("Clipboard snippet");
    expect(suggestNoteTitle(clip({ preview: "x".repeat(200) })).length).toBe(80);
  });
});
