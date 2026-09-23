import { describe, expect, it } from "vitest";
import {
  DEFAULT_POMODORO_SETTINGS,
  applySettings,
  formatClock,
  initialTimer,
  normalizeSettings,
  pauseTimer,
  phaseProgress,
  remainingMs,
  restoreTimer,
  skipPhase,
  startTimer,
  stopTimer,
  tickTimer,
  toggleTimer,
  type PomodoroTimer,
} from "./pomodoro";
import type { PomodoroSettings } from "../../types";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 22, 7, 0, 0);
const settings: PomodoroSettings = { ...DEFAULT_POMODORO_SETTINGS, autoStartBreaks: true };

function runWork(now = T0, s = settings): PomodoroTimer {
  return startTimer(initialTimer(), s, now, "/vault/a.md");
}

describe("start / pause / resume", () => {
  it("starts a work phase from idle with a wall-clock end", () => {
    const t = runWork();
    expect(t).toMatchObject({ phase: "work", status: "running", endsAt: T0 + 25 * MIN, phaseStartedAt: T0 });
    expect(t.notePath).toBe("/vault/a.md");
    expect(remainingMs(t, T0 + 10 * MIN)).toBe(15 * MIN);
    expect(phaseProgress(t, T0 + 5 * MIN)).toBeCloseTo(0.2);
  });

  it("pauses and resumes without losing or gaining time", () => {
    const running = runWork();
    const paused = pauseTimer(running, T0 + 10 * MIN);
    expect(paused).toMatchObject({ status: "paused", endsAt: null, remainingMs: 15 * MIN });
    // A long pause does not eat into the phase.
    expect(remainingMs(paused, T0 + 60 * MIN)).toBe(15 * MIN);
    const resumed = startTimer(paused, settings, T0 + 60 * MIN);
    expect(resumed).toMatchObject({ status: "running", endsAt: T0 + 75 * MIN, phaseStartedAt: T0 });
  });

  it("toggle alternates between running and paused", () => {
    const a = toggleTimer(initialTimer(), settings, T0);
    expect(a.status).toBe("running");
    const b = toggleTimer(a, settings, T0 + MIN);
    expect(b.status).toBe("paused");
    expect(toggleTimer(b, settings, T0 + 2 * MIN).status).toBe("running");
  });

  it("starting a running timer is a no-op", () => {
    const t = runWork();
    expect(startTimer(t, settings, T0 + MIN)).toBe(t);
    expect(pauseTimer(initialTimer(), T0)).toEqual(initialTimer());
  });
});

describe("tick and transitions", () => {
  it("does nothing before the end", () => {
    const t = runWork();
    const r = tickTimer(t, settings, T0 + 24 * MIN);
    expect(r.timer).toBe(t);
    expect(r.completed).toEqual([]);
  });

  it("completes work and auto-starts the break at the exact end (no drift)", () => {
    const t = runWork();
    // The tick arrives 3.7 s late — the break still starts at the work end.
    const r = tickTimer(t, settings, T0 + 25 * MIN + 3_700);
    expect(r.completed).toEqual([
      {
        kind: "work",
        startedAt: T0,
        endedAt: T0 + 25 * MIN,
        minutes: 25,
        natural: true,
        next: "break",
        notePath: "/vault/a.md",
      },
    ]);
    expect(r.timer).toMatchObject({
      phase: "break",
      status: "running",
      phaseStartedAt: T0 + 25 * MIN,
      endsAt: T0 + 30 * MIN,
      completedInCycle: 1,
    });
  });

  it("arms the break instead when auto-start is off", () => {
    const manual = { ...settings, autoStartBreaks: false };
    const r = tickTimer(runWork(T0, manual), manual, T0 + 25 * MIN);
    expect(r.timer).toMatchObject({ phase: "break", status: "ready", endsAt: null, remainingMs: 5 * MIN, phaseStartedAt: null });
  });

  it("never auto-starts work after a break", () => {
    let t = runWork();
    t = tickTimer(t, settings, T0 + 25 * MIN).timer;
    const r = tickTimer(t, settings, T0 + 30 * MIN);
    expect(r.completed.map((c) => c.kind)).toEqual(["break"]);
    expect(r.timer).toMatchObject({ phase: "work", status: "ready", remainingMs: 25 * MIN, notePath: null });
  });

  it("goes to a long break after the configured number of cycles and resets the count", () => {
    const s = { ...settings, cyclesBeforeLongBreak: 2 };
    let now = T0;
    let t = startTimer(initialTimer(), s, now);
    const phases: string[] = [];
    for (let i = 0; i < 6; i++) {
      now = t.endsAt!;
      const r = tickTimer(t, s, now);
      phases.push(r.timer.phase);
      t = r.timer.status === "ready" ? startTimer(r.timer, s, now) : r.timer;
    }
    expect(phases).toEqual(["break", "work", "longBreak", "work", "break", "work"]);
    expect(t.completedInCycle).toBe(1);
  });

  it("catches up several phases after a long gap (reload after closing the app)", () => {
    const t = runWork();
    const r = tickTimer(t, settings, T0 + 3 * 60 * MIN);
    expect(r.completed.map((c) => [c.kind, c.endedAt])).toEqual([
      ["work", T0 + 25 * MIN],
      ["break", T0 + 30 * MIN],
    ]);
    expect(r.timer).toMatchObject({ phase: "work", status: "ready" });
  });

  it("stays drift-free under irregular ticks", () => {
    let t = runWork();
    let now = T0;
    const completed = [];
    // Jittery ticks between 0.3 s and 2.9 s for 40 minutes.
    let seed = 7;
    while (now < T0 + 40 * MIN) {
      seed = (seed * 9301 + 49297) % 233280;
      now += 300 + Math.floor((seed / 233280) * 2600);
      const r = tickTimer(t, settings, now);
      t = r.timer;
      completed.push(...r.completed);
    }
    expect(completed.map((c) => [c.kind, c.endedAt])).toEqual([
      ["work", T0 + 25 * MIN],
      ["break", T0 + 30 * MIN],
    ]);
  });
});

describe("skip and stop", () => {
  it("skipping work logs the focused minutes and counts the cycle", () => {
    const paused = pauseTimer(runWork(), T0 + 12 * MIN + 20_000);
    const r = skipPhase(paused, settings, T0 + 20 * MIN);
    expect(r.completed).toHaveLength(1);
    expect(r.completed[0]).toMatchObject({ kind: "work", minutes: 12, natural: false, endedAt: T0 + 20 * MIN });
    expect(r.timer).toMatchObject({ phase: "break", status: "running", completedInCycle: 1, endsAt: T0 + 25 * MIN });
  });

  it("skipping an unstarted break arms work without logging", () => {
    const manual = { ...settings, autoStartBreaks: false };
    const armedBreak = tickTimer(runWork(T0, manual), manual, T0 + 25 * MIN).timer;
    const r = skipPhase(armedBreak, manual, T0 + 26 * MIN);
    expect(r.completed).toEqual([]);
    expect(r.timer).toMatchObject({ phase: "work", status: "ready" });
  });

  it("cannot skip an armed work phase or an idle timer", () => {
    const armed = { ...initialTimer(), phase: "work" as const, status: "ready" as const, durationMs: 25 * MIN, remainingMs: 25 * MIN };
    expect(skipPhase(armed, settings, T0).timer).toBe(armed);
    expect(skipPhase(initialTimer(), settings, T0).completed).toEqual([]);
  });

  it("stop logs started work and returns to idle; under a minute is dropped", () => {
    const r = stopTimer(runWork(), T0 + 7 * MIN);
    expect(r.timer).toEqual(initialTimer());
    expect(r.completed[0]).toMatchObject({ kind: "work", minutes: 7, next: "idle", natural: false });
    expect(stopTimer(runWork(), T0 + 20_000).completed).toEqual([]);
  });

  it("stopping a break logs nothing", () => {
    const onBreak = tickTimer(runWork(), settings, T0 + 25 * MIN).timer;
    expect(stopTimer(onBreak, T0 + 27 * MIN).completed).toEqual([]);
  });
});

describe("settings", () => {
  it("normalises garbage and clamps ranges", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_POMODORO_SETTINGS);
    expect(normalizeSettings({ workMinutes: 0, breakMinutes: "7", longBreakMinutes: 999, cyclesBeforeLongBreak: 2.6, sound: "yes" })).toEqual({
      ...DEFAULT_POMODORO_SETTINGS,
      workMinutes: 1,
      breakMinutes: 7,
      longBreakMinutes: 120,
      cyclesBeforeLongBreak: 3,
    });
  });

  it("applies new durations to armed phases only", () => {
    const manual = { ...settings, autoStartBreaks: false };
    const armed = tickTimer(runWork(T0, manual), manual, T0 + 25 * MIN).timer;
    const updated = applySettings(armed, { ...manual, breakMinutes: 10 });
    expect(updated).toMatchObject({ durationMs: 10 * MIN, remainingMs: 10 * MIN });
    const running = runWork();
    expect(applySettings(running, { ...settings, workMinutes: 50 })).toBe(running);
  });
});

describe("persistence", () => {
  it("round-trips through JSON and resumes by the wall clock", () => {
    const running = runWork();
    const restored = restoreTimer(JSON.parse(JSON.stringify(running)));
    expect(restored).toEqual(running);
    // Reloaded 10 minutes later: 15 minutes left, as if never reloaded.
    expect(remainingMs(restored, T0 + 10 * MIN)).toBe(15 * MIN);
  });

  it("falls back to idle for corrupt data", () => {
    expect(restoreTimer("nope")).toEqual(initialTimer());
    expect(restoreTimer({ phase: "work", status: "running", durationMs: 1000, remainingMs: 10 })).toEqual(initialTimer());
    expect(restoreTimer({ phase: "party", status: "running" })).toEqual(initialTimer());
    expect(restoreTimer({ phase: "work", status: "paused", durationMs: -5, remainingMs: 1 })).toEqual(initialTimer());
  });

  it("clamps remaining time to the phase length", () => {
    const t = restoreTimer({ phase: "break", status: "paused", durationMs: 5 * MIN, remainingMs: 50 * MIN, phaseStartedAt: T0, completedInCycle: 2 });
    expect(t.remainingMs).toBe(5 * MIN);
    expect(t.completedInCycle).toBe(2);
  });
});

describe("formatClock", () => {
  it("formats mm:ss and h:mm:ss, rounding up", () => {
    expect(formatClock(25 * MIN)).toBe("25:00");
    expect(formatClock(59_001)).toBe("01:00");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(-5)).toBe("00:00");
    expect(formatClock(90 * MIN + 5_000)).toBe("1:30:05");
  });
});
