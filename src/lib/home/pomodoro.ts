/**
 * Pure Pomodoro state machine: idle → work → break → … → longBreak → work.
 *
 * Time is always passed in (`now`, ms since the epoch) and the running phase
 * stores its wall-clock end (`endsAt`), so the countdown never drifts no
 * matter how irregularly `tickTimer` is called, and a reloaded app resumes
 * exactly where the clock is. Phases that ended while nobody was ticking
 * are completed in order at their real end times ("catch-up").
 *
 * Work phases never start on their own; breaks start automatically when
 * `autoStartBreaks` is on (then the break begins at the exact end of the
 * work phase, not at the next tick).
 */
import type { FocusSessionKind, PomodoroPhase, PomodoroSettings, PomodoroStatus } from "../../types";

const MINUTE = 60_000;

/** Defaults: 25 / 5 / 15 minutes, long break after 4 work sessions. */
export const DEFAULT_POMODORO_SETTINGS: PomodoroSettings = {
  workMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  cyclesBeforeLongBreak: 4,
  autoStartBreaks: true,
  notifications: true,
  sound: false,
};

/** Accepted ranges for the numeric settings. */
export const POMODORO_LIMITS = {
  workMinutes: { min: 1, max: 180 },
  breakMinutes: { min: 1, max: 60 },
  longBreakMinutes: { min: 1, max: 120 },
  cyclesBeforeLongBreak: { min: 1, max: 12 },
} as const;

/** The complete timer state (persisted as JSON). */
export interface PomodoroTimer {
  phase: PomodoroPhase;
  status: PomodoroStatus;
  /** Planned length of the current phase in ms. */
  durationMs: number;
  /** Wall-clock end of the running phase; `null` unless running. */
  endsAt: number | null;
  /** Time left while `ready` or `paused` (ms). */
  remainingMs: number;
  /** When the current phase was first started; `null` until started. */
  phaseStartedAt: number | null;
  /** Work sessions finished since the last long break. */
  completedInCycle: number;
  /** Note that was open when the work phase started. */
  notePath: string | null;
}

/** A phase that ended — naturally, skipped or stopped. */
export interface CompletedPhase {
  kind: FocusSessionKind;
  startedAt: number;
  endedAt: number;
  /** Focused minutes (pauses excluded), rounded to the nearest minute. */
  minutes: number;
  /** `true` when the countdown reached zero. */
  natural: boolean;
  /** The phase that follows (for notifications). */
  next: PomodoroPhase;
  notePath: string | null;
}

/** Result of a transition. */
export interface TimerTransition {
  timer: PomodoroTimer;
  completed: CompletedPhase[];
}

/** The resting state: no phase. */
export function initialTimer(): PomodoroTimer {
  return {
    phase: "idle",
    status: "idle",
    durationMs: 0,
    endsAt: null,
    remainingMs: 0,
    phaseStartedAt: null,
    completedInCycle: 0,
    notePath: null,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Coerce anything (e.g. parsed localStorage) into valid settings. */
export function normalizeSettings(raw: unknown): PomodoroSettings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof PomodoroSettings, unknown>>;
  const d = DEFAULT_POMODORO_SETTINGS;
  const L = POMODORO_LIMITS;
  return {
    workMinutes: clampInt(r.workMinutes, L.workMinutes.min, L.workMinutes.max, d.workMinutes),
    breakMinutes: clampInt(r.breakMinutes, L.breakMinutes.min, L.breakMinutes.max, d.breakMinutes),
    longBreakMinutes: clampInt(r.longBreakMinutes, L.longBreakMinutes.min, L.longBreakMinutes.max, d.longBreakMinutes),
    cyclesBeforeLongBreak: clampInt(
      r.cyclesBeforeLongBreak,
      L.cyclesBeforeLongBreak.min,
      L.cyclesBeforeLongBreak.max,
      d.cyclesBeforeLongBreak
    ),
    autoStartBreaks: typeof r.autoStartBreaks === "boolean" ? r.autoStartBreaks : d.autoStartBreaks,
    notifications: typeof r.notifications === "boolean" ? r.notifications : d.notifications,
    sound: typeof r.sound === "boolean" ? r.sound : d.sound,
  };
}

/** Planned length of `phase` in ms. */
export function phaseDurationMs(phase: PomodoroPhase, settings: PomodoroSettings): number {
  switch (phase) {
    case "work":
      return settings.workMinutes * MINUTE;
    case "break":
      return settings.breakMinutes * MINUTE;
    case "longBreak":
      return settings.longBreakMinutes * MINUTE;
    default:
      return 0;
  }
}

/** Session kind stored in the focus log for a phase. */
export function phaseKind(phase: Exclude<PomodoroPhase, "idle">): FocusSessionKind {
  return phase === "work" ? "work" : phase === "break" ? "break" : "long_break";
}

/** Human label of a phase. */
export function phaseLabel(phase: PomodoroPhase): string {
  switch (phase) {
    case "work":
      return "Focus";
    case "break":
      return "Break";
    case "longBreak":
      return "Long break";
    default:
      return "Pomodoro";
  }
}

/** Milliseconds left in the current phase at `now`. */
export function remainingMs(timer: PomodoroTimer, now: number): number {
  if (timer.status === "running" && timer.endsAt !== null) return Math.max(0, timer.endsAt - now);
  return Math.max(0, timer.remainingMs);
}

/** Fraction of the current phase already elapsed (0…1). */
export function phaseProgress(timer: PomodoroTimer, now: number): number {
  if (timer.durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - remainingMs(timer, now) / timer.durationMs));
}

/** `mm:ss` (or `h:mm:ss` from one hour), rounding partial seconds up. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** The phase after `phase` and the updated cycle counter. */
function nextPhase(
  phase: Exclude<PomodoroPhase, "idle">,
  completedInCycle: number,
  settings: PomodoroSettings
): { phase: Exclude<PomodoroPhase, "idle">; completedInCycle: number } {
  if (phase === "work") {
    const count = completedInCycle + 1;
    return { phase: count >= settings.cyclesBeforeLongBreak ? "longBreak" : "break", completedInCycle: count };
  }
  if (phase === "longBreak") return { phase: "work", completedInCycle: 0 };
  return { phase: "work", completedInCycle };
}

/** Arm `phase`; it runs from `startAt` when it is a break and breaks auto-start. */
function enterPhase(
  base: PomodoroTimer,
  phase: Exclude<PomodoroPhase, "idle">,
  completedInCycle: number,
  settings: PomodoroSettings,
  startAt: number
): PomodoroTimer {
  const durationMs = phaseDurationMs(phase, settings);
  const autoStart = phase !== "work" && settings.autoStartBreaks;
  return {
    ...base,
    phase,
    completedInCycle,
    durationMs,
    status: autoStart ? "running" : "ready",
    endsAt: autoStart ? startAt + durationMs : null,
    remainingMs: durationMs,
    phaseStartedAt: autoStart ? startAt : null,
    notePath: phase === "work" ? null : base.notePath,
  };
}

function completion(timer: PomodoroTimer, endedAt: number, focusedMs: number, natural: boolean, next: PomodoroPhase): CompletedPhase | null {
  if (timer.phase === "idle" || timer.phaseStartedAt === null) return null;
  const minutes = Math.round(focusedMs / MINUTE);
  if (minutes < 1) return null;
  return {
    kind: phaseKind(timer.phase),
    startedAt: timer.phaseStartedAt,
    endedAt,
    minutes,
    natural,
    next,
    notePath: timer.notePath,
  };
}

/**
 * Start (from idle: a new work phase), resume (paused) or begin an armed
 * phase (ready). A running timer is returned unchanged.
 */
export function startTimer(
  timer: PomodoroTimer,
  settings: PomodoroSettings,
  now: number,
  notePath: string | null = null
): PomodoroTimer {
  if (timer.status === "running") return timer;
  if (timer.phase === "idle") {
    const durationMs = phaseDurationMs("work", settings);
    return {
      ...timer,
      phase: "work",
      status: "running",
      durationMs,
      endsAt: now + durationMs,
      remainingMs: durationMs,
      phaseStartedAt: now,
      notePath,
    };
  }
  const remaining = timer.remainingMs > 0 ? timer.remainingMs : timer.durationMs;
  return {
    ...timer,
    status: "running",
    endsAt: now + remaining,
    remainingMs: remaining,
    phaseStartedAt: timer.phaseStartedAt ?? now,
    notePath: timer.phase === "work" && timer.phaseStartedAt === null ? notePath : timer.notePath,
  };
}

/** Freeze a running countdown. */
export function pauseTimer(timer: PomodoroTimer, now: number): PomodoroTimer {
  if (timer.status !== "running") return timer;
  return { ...timer, status: "paused", remainingMs: remainingMs(timer, now), endsAt: null };
}

/** Start/resume when not running, pause when running. */
export function toggleTimer(
  timer: PomodoroTimer,
  settings: PomodoroSettings,
  now: number,
  notePath: string | null = null
): PomodoroTimer {
  return timer.status === "running" ? pauseTimer(timer, now) : startTimer(timer, settings, now, notePath);
}

/**
 * Advance the clock: every running phase whose end has passed completes at
 * its real end time and the next phase is armed (or started, for breaks
 * with `autoStartBreaks`). Loops, so a long gap catches up correctly.
 */
export function tickTimer(timer: PomodoroTimer, settings: PomodoroSettings, now: number): TimerTransition {
  let current = timer;
  const completed: CompletedPhase[] = [];
  // Bounded: work never auto-starts, so at most work → break → (ready).
  for (let guard = 0; guard < 8; guard++) {
    if (current.status !== "running" || current.endsAt === null || current.phase === "idle") break;
    if (now < current.endsAt) break;
    const endedAt = current.endsAt;
    const next = nextPhase(current.phase, current.completedInCycle, settings);
    const done = completion(current, endedAt, current.durationMs, true, next.phase);
    if (done) completed.push(done);
    current = enterPhase(current, next.phase, next.completedInCycle, settings, endedAt);
  }
  return { timer: current, completed };
}

/**
 * End the current phase early and move on. Skipping work (running or
 * paused) logs the focused minutes so far and still counts towards the
 * long-break cycle; skipping a break arms the next work phase. An armed,
 * not yet started work phase cannot be skipped.
 */
export function skipPhase(timer: PomodoroTimer, settings: PomodoroSettings, now: number): TimerTransition {
  if (timer.phase === "idle") return { timer, completed: [] };
  if (timer.phase === "work" && timer.status === "ready") return { timer, completed: [] };
  const next = nextPhase(timer.phase, timer.completedInCycle, settings);
  const focusedMs = timer.durationMs - remainingMs(timer, now);
  const done = completion(timer, now, focusedMs, false, next.phase);
  return {
    timer: enterPhase(timer, next.phase, next.completedInCycle, settings, now),
    completed: done ? [done] : [],
  };
}

/** Stop everything. A started work phase logs its focused minutes. */
export function stopTimer(timer: PomodoroTimer, now: number): TimerTransition {
  if (timer.phase === "idle") return { timer, completed: [] };
  const focusedMs = timer.durationMs - remainingMs(timer, now);
  const done = timer.phase === "work" ? completion(timer, now, focusedMs, false, "idle") : null;
  return { timer: initialTimer(), completed: done ? [done] : [] };
}

/**
 * Apply changed settings: an armed (not yet started) phase takes the new
 * length; a started phase keeps its length, the next phase uses the new one.
 */
export function applySettings(timer: PomodoroTimer, settings: PomodoroSettings): PomodoroTimer {
  if (timer.status !== "ready" || timer.phase === "idle") return timer;
  const durationMs = phaseDurationMs(timer.phase, settings);
  return { ...timer, durationMs, remainingMs: durationMs };
}

const PHASES: PomodoroPhase[] = ["idle", "work", "break", "longBreak"];
const STATUSES: PomodoroStatus[] = ["idle", "ready", "running", "paused"];

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Rebuild a timer from persisted JSON. Anything inconsistent falls back to
 * the idle timer so a corrupted entry never breaks the app.
 */
export function restoreTimer(raw: unknown): PomodoroTimer {
  if (typeof raw !== "object" || raw === null) return initialTimer();
  const r = raw as Record<string, unknown>;
  const phase = PHASES.includes(r.phase as PomodoroPhase) ? (r.phase as PomodoroPhase) : null;
  const status = STATUSES.includes(r.status as PomodoroStatus) ? (r.status as PomodoroStatus) : null;
  if (!phase || !status) return initialTimer();
  if (phase === "idle" || status === "idle") return initialTimer();
  const durationMs = finiteOrNull(r.durationMs);
  const remaining = finiteOrNull(r.remainingMs);
  const endsAt = finiteOrNull(r.endsAt);
  const startedAt = finiteOrNull(r.phaseStartedAt);
  if (durationMs === null || durationMs <= 0 || remaining === null || remaining < 0) return initialTimer();
  if (status === "running" && (endsAt === null || startedAt === null)) return initialTimer();
  return {
    phase,
    status,
    durationMs,
    endsAt: status === "running" ? endsAt : null,
    remainingMs: Math.min(remaining, durationMs),
    phaseStartedAt: startedAt,
    completedInCycle: Math.max(0, Math.floor(finiteOrNull(r.completedInCycle) ?? 0)),
    notePath: typeof r.notePath === "string" ? r.notePath : null,
  };
}
