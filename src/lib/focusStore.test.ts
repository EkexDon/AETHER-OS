import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const focusLogSession = vi.fn();
vi.mock("./ipc", () => ({ focusLogSession: (...args: unknown[]) => focusLogSession(...args) }));

const sendDesktopNotification = vi.fn().mockResolvedValue(true);
const playChime = vi.fn().mockReturnValue(true);
vi.mock("./home/notify", () => ({
  sendDesktopNotification: (...args: unknown[]) => sendDesktopNotification(...args),
  playChime: () => playChime(),
  ensureNotificationPermission: vi.fn().mockResolvedValue(true),
}));

import { FOCUS_SETTINGS_KEY, FOCUS_TIMER_KEY, phaseEndMessage, useFocusStore } from "./focusStore";
import { DEFAULT_POMODORO_SETTINGS, initialTimer } from "./home/pomodoro";
import { useAetherStore } from "./store";
import { useToastStore } from "../ui/Toast";

const MIN = 60_000;
const T0 = new Date(2026, 8, 22, 9, 0, 0).getTime();

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  focusLogSession.mockReset().mockResolvedValue({ id: "s1" });
  sendDesktopNotification.mockClear();
  playChime.mockClear();
  window.localStorage.clear();
  useToastStore.setState({ toasts: [] });
  useAetherStore.setState({ view: "editor", selectedNotePath: "/vault/Plan.md" });
  useFocusStore.setState({
    settings: { ...DEFAULT_POMODORO_SETTINGS },
    timer: initialTimer(),
    focusMode: false,
    statsVersion: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-focus");
});

describe("focus store", () => {
  it("starts work with the open note and persists the running timer", () => {
    useFocusStore.getState().start();
    const { timer } = useFocusStore.getState();
    expect(timer).toMatchObject({ phase: "work", status: "running", endsAt: T0 + 25 * MIN, notePath: "/vault/Plan.md" });
    expect(JSON.parse(window.localStorage.getItem(FOCUS_TIMER_KEY) ?? "null")).toMatchObject({ phase: "work", endsAt: T0 + 25 * MIN });
  });

  it("logs a finished work phase, notifies and bumps the stats version", async () => {
    useFocusStore.getState().updateSettings({ sound: true });
    useFocusStore.getState().start();
    useFocusStore.getState().tick(T0 + 25 * MIN + 500);
    await flush();
    expect(focusLogSession).toHaveBeenCalledTimes(1);
    const [session] = focusLogSession.mock.calls[0] as [Record<string, unknown>];
    expect(session).toMatchObject({ kind: "work", minutes: 25, note_path: "/vault/Plan.md" });
    expect(Date.parse(session.started_at as string)).toBe(T0);
    expect(Date.parse(session.ended_at as string)).toBe(T0 + 25 * MIN);
    expect(sendDesktopNotification).toHaveBeenCalledWith("Focus session complete", expect.stringContaining("5-minute break has started"));
    expect(playChime).toHaveBeenCalled();
    expect(useToastStore.getState().toasts.some((t) => t.title === "Focus session complete")).toBe(true);
    expect(useFocusStore.getState().statsVersion).toBe(1);
    expect(useFocusStore.getState().timer.phase).toBe("break");
  });

  it("does not notify for phases that ended long ago (reload catch-up)", async () => {
    useFocusStore.getState().start();
    useFocusStore.getState().tick(T0 + 5 * 60 * MIN);
    await flush();
    expect(focusLogSession).toHaveBeenCalledTimes(2); // work + break
    expect(sendDesktopNotification).not.toHaveBeenCalled();
    expect(useFocusStore.getState().timer).toMatchObject({ phase: "work", status: "ready" });
  });

  it("respects the notification switch", async () => {
    useFocusStore.getState().updateSettings({ notifications: false });
    useFocusStore.getState().start();
    useFocusStore.getState().tick(T0 + 25 * MIN);
    await flush();
    expect(sendDesktopNotification).not.toHaveBeenCalled();
    expect(playChime).not.toHaveBeenCalled();
  });

  it("surfaces log failures as an error toast", async () => {
    focusLogSession.mockRejectedValue(new Error("disk full"));
    useFocusStore.getState().start();
    useFocusStore.getState().tick(T0 + 25 * MIN);
    await flush();
    const toast = useToastStore.getState().toasts.find((t) => t.kind === "error");
    expect(toast?.title).toBe("Could not save the focus session");
    expect(useFocusStore.getState().statsVersion).toBe(0);
  });

  it("stop logs the partial work session", async () => {
    useFocusStore.getState().start();
    vi.setSystemTime(T0 + 11 * MIN);
    useFocusStore.getState().stop();
    await flush();
    expect(focusLogSession.mock.calls[0][0]).toMatchObject({ kind: "work", minutes: 11 });
    expect(useFocusStore.getState().timer.phase).toBe("idle");
    expect(useToastStore.getState().toasts.some((t) => t.title === "Focus session saved")).toBe(true);
  });

  it("toggle pauses and resumes", () => {
    useFocusStore.getState().toggle();
    vi.setSystemTime(T0 + 3 * MIN);
    useFocusStore.getState().toggle();
    expect(useFocusStore.getState().timer).toMatchObject({ status: "paused", remainingMs: 22 * MIN });
    vi.setSystemTime(T0 + 30 * MIN);
    useFocusStore.getState().toggle();
    expect(useFocusStore.getState().timer).toMatchObject({ status: "running", endsAt: T0 + 52 * MIN });
  });

  it("persists validated settings", () => {
    useFocusStore.getState().updateSettings({ workMinutes: 50, cyclesBeforeLongBreak: 99 });
    expect(useFocusStore.getState().settings).toMatchObject({ workMinutes: 50, cyclesBeforeLongBreak: 12 });
    expect(JSON.parse(window.localStorage.getItem(FOCUS_SETTINGS_KEY) ?? "{}")).toMatchObject({ workMinutes: 50 });
    useFocusStore.getState().resetSettings();
    expect(useFocusStore.getState().settings).toEqual(DEFAULT_POMODORO_SETTINGS);
  });

  it("toggles focus mode on the root element", () => {
    useFocusStore.getState().toggleFocusMode();
    expect(document.documentElement.getAttribute("data-focus")).toBe("true");
    useFocusStore.getState().toggleFocusMode();
    expect(document.documentElement.hasAttribute("data-focus")).toBe(false);
  });
});

describe("phaseEndMessage", () => {
  it("announces breaks and the end of breaks", () => {
    const base = { startedAt: 0, endedAt: 0, minutes: 25, natural: true, notePath: null };
    expect(phaseEndMessage({ ...base, kind: "work", next: "longBreak" }, { ...DEFAULT_POMODORO_SETTINGS, autoStartBreaks: false })).toEqual({
      title: "Focus session complete",
      body: "25m of focus. Start your 15-minute long break when you are ready.",
    });
    expect(phaseEndMessage({ ...base, kind: "break", next: "work" }, DEFAULT_POMODORO_SETTINGS).title).toBe("Break is over");
    expect(phaseEndMessage({ ...base, kind: "long_break", next: "work" }, DEFAULT_POMODORO_SETTINGS).title).toBe("Long break is over");
  });
});
