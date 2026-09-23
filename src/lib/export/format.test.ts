import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatRelative, kindLabel, phaseLabel, plural, progressPercent } from "./format";

describe("export formatting", () => {
  it("formats sizes and durations", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(412_880)).toBe("403 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatDuration(420)).toBe("420 ms");
    expect(formatDuration(3400)).toBe("3.4 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });

  it("formats relative times", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    expect(formatRelative("2026-09-22T11:59:40Z", now)).toBe("just now");
    expect(formatRelative("2026-09-22T11:30:00Z", now)).toBe("30 min ago");
    expect(formatRelative("2026-09-22T07:00:00Z", now)).toBe("5 h ago");
    expect(formatRelative("2026-09-21T10:00:00Z", now)).toBe("yesterday");
    expect(formatRelative("2026-09-18T12:00:00Z", now)).toBe("4 days ago");
    expect(formatRelative("not a date", now)).toBe("");
  });

  it("computes progress and labels", () => {
    expect(progressPercent(null)).toBe(0);
    expect(progressPercent({ done: 1, total: 4, current: "", phase: "pages" })).toBe(25);
    expect(progressPercent({ done: 9, total: 4, current: "", phase: "pages" })).toBe(100);
    expect(progressPercent({ done: 1, total: 0, current: "", phase: "pages" })).toBe(0);
    expect(phaseLabel("attachments")).toBe("Copying attachments");
    expect(phaseLabel("something-new")).toBe("Exporting");
    expect(kindLabel("site")).toBe("Static site");
    expect(plural(1, "note")).toBe("1 note");
    expect(plural(3, "note")).toBe("3 notes");
  });
});
