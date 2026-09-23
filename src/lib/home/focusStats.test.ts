import { describe, expect, it } from "vitest";
import type { FocusSession, FocusSessionKind } from "../../types";
import { computeFocusStats, dateKey, formatMinutes, sessionDateKey, shiftDateKey, streakDays } from "./focusStats";

const session = (started_at: string, minutes: number, kind: FocusSessionKind = "work"): FocusSession => ({
  id: `${started_at}-${minutes}`,
  started_at,
  ended_at: started_at,
  minutes,
  kind,
  note_path: null,
});

describe("date keys", () => {
  it("formats local dates and shifts across month/year/DST boundaries", () => {
    expect(dateKey(new Date(2026, 8, 2))).toBe("2026-09-02");
    expect(shiftDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDateKey("2026-02-28", 1)).toBe("2026-03-01");
    expect(shiftDateKey("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftDateKey("2026-10-25", -7)).toBe("2026-10-18");
  });

  it("uses the recorded offset's calendar day", () => {
    expect(sessionDateKey({ started_at: "2026-09-21T23:30:00-04:00" })).toBe("2026-09-21");
    expect(sessionDateKey({ started_at: "garbage" })).toBeNull();
    expect(sessionDateKey({ started_at: "2026-13-45T99:00:00Z" })).toBeNull();
  });
});

// Same scenarios as the Rust tests in engine/focus_log.rs.
describe("streakDays", () => {
  it("counts consecutive days ending today", () => {
    expect(streakDays(new Set(["2026-09-20", "2026-09-21", "2026-09-22"]), "2026-09-22")).toBe(3);
  });

  it("keeps yesterday's streak until today is logged", () => {
    expect(streakDays(new Set(["2026-09-20", "2026-09-21"]), "2026-09-22")).toBe(2);
  });

  it("breaks on gaps", () => {
    const active = new Set(["2026-09-15", "2026-09-16", "2026-09-18", "2026-09-19"]);
    expect(streakDays(active, "2026-09-19")).toBe(2);
    expect(streakDays(active, "2026-09-21")).toBe(0);
  });

  it("crosses year boundaries", () => {
    expect(streakDays(new Set(["2025-12-30", "2025-12-31", "2026-01-01"]), "2026-01-01")).toBe(3);
  });
});

describe("computeFocusStats", () => {
  it("aggregates work minutes per day and ignores breaks", () => {
    const stats = computeFocusStats(
      [
        session("2026-09-22T09:00:00+02:00", 25),
        session("2026-09-22T09:30:00+02:00", 25),
        session("2026-09-22T09:25:00+02:00", 5, "break"),
        session("2026-09-22T10:00:00+02:00", 15, "long_break"),
        session("2026-09-21T23:50:00+02:00", 25),
        session("2026-09-19T08:00:00+02:00", 50),
      ],
      "2026-09-22",
      7
    );
    expect(stats.today_minutes).toBe(50);
    expect(stats.today_sessions).toBe(2);
    expect(stats.streak_days).toBe(2);
    expect(stats.total_minutes).toBe(125);
    expect(stats.by_day.map((d) => d.date)).toEqual([
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
      "2026-09-21",
      "2026-09-22",
    ]);
    expect(stats.by_day.map((d) => d.minutes)).toEqual([0, 0, 0, 50, 0, 25, 50]);
  });

  it("clamps the window", () => {
    expect(computeFocusStats([], "2026-09-22", 0).by_day).toHaveLength(1);
    expect(computeFocusStats([], "2026-09-22", 10_000).by_day).toHaveLength(366);
  });
});

describe("formatMinutes", () => {
  it("renders hours and minutes", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(25)).toBe("25m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(95)).toBe("1h 35m");
  });
});
