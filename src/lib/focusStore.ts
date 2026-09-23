/**
 * Pomodoro timer, its settings and Focus Mode.
 *
 * The state machine is pure (`src/lib/home/pomodoro.ts`); this store adds
 * persistence (settings in `aether-focus-settings`, the running timer with
 * wall-clock timestamps in `aether-focus-timer`, so a reload continues
 * exactly), side effects for finished phases (append to the Rust focus log,
 * toast, desktop notification, optional chime) and the Focus Mode flag
 * (`<html data-focus="true">`, not persisted).
 *
 * Something must call `tick()` about once a second — the always-mounted
 * status bar timer does (`useFocusEngine`).
 */
import { create } from "zustand";
import type { PomodoroSettings } from "../types";
import { focusLogSession } from "./ipc";
import { useAetherStore } from "./store";
import { toast } from "../ui/Toast";
import {
  applySettings,
  initialTimer,
  normalizeSettings,
  pauseTimer,
  restoreTimer,
  skipPhase,
  startTimer,
  stopTimer,
  tickTimer,
  type CompletedPhase,
  type PomodoroTimer,
  type TimerTransition,
} from "./home/pomodoro";
import { toLocalRfc3339 } from "./home/format";
import { formatMinutes } from "./home/focusStats";
import { applyFocusMode } from "./home/focusMode";
import { playChime, sendDesktopNotification } from "./home/notify";

/** localStorage key of the settings. */
export const FOCUS_SETTINGS_KEY = "aether-focus-settings";
/** localStorage key of the timer. */
export const FOCUS_TIMER_KEY = "aether-focus-timer";
/** Phase ends older than this (e.g. while the app was closed) get no desktop notification or sound. */
export const FRESH_COMPLETION_MS = 60_000;

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable — state still applies for this session
  }
}

/** Title + body announcing the end of a phase. */
export function phaseEndMessage(done: CompletedPhase, settings: PomodoroSettings): { title: string; body: string } {
  if (done.kind === "work") {
    const long = done.next === "longBreak";
    const minutes = long ? settings.longBreakMinutes : settings.breakMinutes;
    const breakName = long ? `${minutes}-minute long break` : `${minutes}-minute break`;
    return {
      title: "Focus session complete",
      body: `${formatMinutes(done.minutes)} of focus. ${
        settings.autoStartBreaks ? `Your ${breakName} has started.` : `Start your ${breakName} when you are ready.`
      }`,
    };
  }
  return {
    title: done.kind === "long_break" ? "Long break is over" : "Break is over",
    body: "Start the next focus session when you are ready.",
  };
}

interface FocusState {
  settings: PomodoroSettings;
  timer: PomodoroTimer;
  /** Focus Mode (`<html data-focus>`) is on. */
  focusMode: boolean;
  /** Increments whenever a session was written to the log (stats refresh). */
  statsVersion: number;
  /** Start / resume / begin the armed phase. */
  start: () => void;
  pause: () => void;
  /** Start when not running, pause when running. */
  toggle: () => void;
  /** End the current phase early and go to the next one. */
  skip: () => void;
  /** Back to idle (a started work phase is logged). */
  stop: () => void;
  /** Advance the clock; completes phases whose end has passed. */
  tick: (now?: number) => void;
  updateSettings: (patch: Partial<PomodoroSettings>) => void;
  resetSettings: () => void;
  setFocusMode: (on: boolean) => void;
  toggleFocusMode: () => void;
}

/** Note to attach to a work session: the one open in the editor, if any. */
function currentNotePath(): string | null {
  const s = useAetherStore.getState();
  return s.view === "editor" ? s.selectedNotePath : null;
}

export const useFocusStore = create<FocusState>((set, get) => {
  /** Commit a transition and run the side effects of finished phases. */
  const commit = ({ timer, completed }: TimerTransition, now: number) => {
    if (timer !== get().timer) set({ timer });
    if (completed.length > 0) void handleCompleted(completed, now);
  };

  const handleCompleted = async (completed: CompletedPhase[], now: number) => {
    const { settings } = get();
    const last = completed[completed.length - 1];
    if (last.natural) {
      const { title, body } = phaseEndMessage(last, settings);
      const fresh = now - last.endedAt < FRESH_COMPLETION_MS;
      toast.info(title, { description: fresh ? body : `${body} (finished while AETHER-OS was closed)` });
      if (fresh && settings.notifications) void sendDesktopNotification(title, body);
      if (fresh && settings.sound) playChime();
    }
    for (const done of completed) {
      try {
        await focusLogSession({
          started_at: toLocalRfc3339(done.startedAt),
          ended_at: toLocalRfc3339(done.endedAt),
          minutes: done.minutes,
          kind: done.kind,
          note_path: done.notePath,
        });
        set((s) => ({ statsVersion: s.statsVersion + 1 }));
        if (!done.natural && done.kind === "work") {
          toast.success("Focus session saved", { description: `${formatMinutes(done.minutes)} logged.` });
        }
      } catch (e) {
        toast.error("Could not save the focus session", {
          description: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };

  return {
    settings: normalizeSettings(readJson(FOCUS_SETTINGS_KEY)),
    timer: restoreTimer(readJson(FOCUS_TIMER_KEY)),
    focusMode: false,
    statsVersion: 0,

    start: () => {
      const now = Date.now();
      const { timer, settings } = get();
      set({ timer: startTimer(timer, settings, now, currentNotePath()) });
    },

    pause: () => set({ timer: pauseTimer(get().timer, Date.now()) }),

    toggle: () => {
      if (get().timer.status === "running") get().pause();
      else get().start();
    },

    skip: () => {
      const now = Date.now();
      const { timer, settings } = get();
      commit(skipPhase(timer, settings, now), now);
    },

    stop: () => {
      const now = Date.now();
      commit(stopTimer(get().timer, now), now);
    },

    tick: (now = Date.now()) => {
      const { timer, settings } = get();
      if (timer.status !== "running") return;
      commit(tickTimer(timer, settings, now), now);
    },

    updateSettings: (patch) => {
      const settings = normalizeSettings({ ...get().settings, ...patch });
      set({ settings, timer: applySettings(get().timer, settings) });
    },

    resetSettings: () => {
      const settings = normalizeSettings(null);
      set({ settings, timer: applySettings(get().timer, settings) });
    },

    setFocusMode: (on) => {
      applyFocusMode(on);
      if (on !== get().focusMode) set({ focusMode: on });
    },

    toggleFocusMode: () => get().setFocusMode(!get().focusMode),
  };
});

useFocusStore.subscribe((state, prev) => {
  if (state.settings !== prev.settings) writeJson(FOCUS_SETTINGS_KEY, state.settings);
  if (state.timer !== prev.timer) writeJson(FOCUS_TIMER_KEY, state.timer);
});

/** A fresh idle timer (exported for tests and resets). */
export { initialTimer };
