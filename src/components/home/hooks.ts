import { useEffect, useState } from "react";
import { useFocusStore } from "../../lib/focusStore";
import { createDoubleEscapeDetector } from "../../lib/home/focusMode";
import { toast } from "../../ui";

/**
 * The current time, refreshed every `intervalMs` while `enabled` (and once
 * when it becomes enabled). Components use it to re-render countdowns and
 * relative timestamps without a global ticking store.
 */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/**
 * Drives the Pomodoro timer for the whole app: ticks the focus store once a
 * second (and immediately when the window becomes visible again, so a
 * phase that ended in the background completes at once), keeps
 * `<html data-focus>` in sync and exits Focus Mode on a double Escape.
 * Mount exactly once, in an always-present component (the status bar
 * timer).
 */
export function useFocusEngine(): void {
  useEffect(() => {
    const tick = () => useFocusStore.getState().tick();
    tick();
    const id = window.setInterval(tick, 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    // Re-apply after reloads / hot updates so the DOM matches the store.
    const { focusMode, setFocusMode } = useFocusStore.getState();
    setFocusMode(focusMode);
    const detect = createDoubleEscapeDetector();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (!useFocusStore.getState().focusMode) return;
      if (detect(Date.now())) {
        useFocusStore.getState().setFocusMode(false);
        toast.info("Focus mode off");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
