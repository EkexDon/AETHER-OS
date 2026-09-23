import { beforeEach, describe, expect, it } from "vitest";
import type { FocusSession, FocusStats } from "../../types";
import { mockInvoke, resetMockState, setMockLatency } from "./backend";
import { toLocalRfc3339 } from "../home/format";

const invoke = <T,>(command: string, args: Record<string, unknown> = {}) => mockInvoke<T>(command, args);

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
});

describe("mock focus log", () => {
  it("seeds 14 days of history with a streak", async () => {
    const stats = await invoke<FocusStats>("cmd_focus_stats", { days: 14 });
    expect(stats.by_day).toHaveLength(14);
    expect(stats.total_minutes).toBeGreaterThan(0);
    expect(stats.streak_days).toBeGreaterThanOrEqual(6);
    expect(stats.by_day.filter((d) => d.minutes === 0).length).toBeGreaterThanOrEqual(2);
  });

  it("logs sessions and reflects them in stats and the list", async () => {
    const before = await invoke<FocusStats>("cmd_focus_stats", { days: 7 });
    const now = Date.now();
    const saved = await invoke<FocusSession>("cmd_focus_log_session", {
      session: {
        started_at: toLocalRfc3339(now - 25 * 60_000),
        ended_at: toLocalRfc3339(now),
        minutes: null,
        kind: "work",
        note_path: " /vault/Plan.md ",
      },
    });
    expect(saved).toMatchObject({ minutes: 25, kind: "work", note_path: "/vault/Plan.md" });
    const after = await invoke<FocusStats>("cmd_focus_stats", { days: 7 });
    const startedToday = new Date(now - 25 * 60_000).toDateString() === new Date(now).toDateString();
    if (startedToday) expect(after.today_minutes).toBe(before.today_minutes + 25);
    const list = await invoke<FocusSession[]>("cmd_focus_list", { limit: 1 });
    expect(list).toEqual([saved]);
  });

  it("validates like the Rust engine", async () => {
    const bad = (session: Record<string, unknown>) => invoke("cmd_focus_log_session", { session });
    await expect(bad({ started_at: "x", ended_at: "y", kind: "work" })).rejects.toMatch(/^invalid input: invalid timestamp/);
    await expect(
      bad({ started_at: "2026-09-22T10:00:00Z", ended_at: "2026-09-22T09:00:00Z", kind: "work" })
    ).rejects.toMatch(/must not be before/);
    await expect(
      bad({ started_at: "2026-09-22T09:00:00Z", ended_at: "2026-09-22T09:25:00Z", minutes: 90, kind: "work" })
    ).rejects.toMatch(/do not fit/);
    await expect(
      bad({ started_at: "2026-09-22T09:00:00Z", ended_at: "2026-09-22T09:00:10Z", kind: "work" })
    ).rejects.toMatch(/at least one minute/);
    await expect(invoke("cmd_focus_log_session", {})).rejects.toMatch(/missing required key session/);
    await expect(invoke("cmd_focus_stats", {})).rejects.toMatch(/missing required key days/);
  });
});
