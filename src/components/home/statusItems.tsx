import { Bookmark, Minimize2, Pause, SkipForward, Timer } from "lucide-react";
import { useFocusStore } from "../../lib/focusStore";
import { useHomeStore } from "../../lib/homeStore";
import { countPins, usePinsStore } from "../../lib/pinsStore";
import { formatClock, phaseLabel, remainingMs } from "../../lib/home/pomodoro";
import { Tooltip, cx, toast } from "../../ui";
import { useFocusEngine, useNow } from "./hooks";
import { PINS_DRAWER_TOGGLE_ATTR, PinsDrawer } from "./PinsDrawer";

/**
 * Pomodoro timer in the status bar (mm:ss in the phase color; click to
 * start / pause / resume, the arrow skips the phase). It also hosts the
 * timer engine, so it must stay mounted — in Focus Mode it is the one
 * status item that remains visible (`data-focus-keep`).
 */
export function FocusStatusItem() {
  useFocusEngine();
  const timer = useFocusStore((s) => s.timer);
  const focusMode = useFocusStore((s) => s.focusMode);
  const toggle = useFocusStore((s) => s.toggle);
  const skip = useFocusStore((s) => s.skip);
  const setFocusMode = useFocusStore((s) => s.setFocusMode);
  const now = useNow(1000, timer.status === "running");

  const exitFocus = focusMode ? (
    <Tooltip content="Exit focus mode (Esc twice)" shortcut="mod+shift+f" placement="top">
      <button
        type="button"
        className="statusbar-item home-focus-exit"
        data-focus-keep=""
        onClick={() => {
          setFocusMode(false);
          toast.info("Focus mode off");
        }}
      >
        <Minimize2 size={14} />
        <span className="statusbar-muted">Exit focus</span>
      </button>
    </Tooltip>
  ) : null;

  if (timer.phase === "idle") {
    return (
      <>
        {exitFocus}
        <Tooltip content="Start a Pomodoro" shortcut="mod+alt+t" placement="top">
          <button type="button" className="statusbar-item home-focus-status" data-focus-keep="" onClick={toggle}>
            <Timer size={14} />
            <span className="statusbar-muted">Focus</span>
          </button>
        </Tooltip>
      </>
    );
  }

  const running = timer.status === "running";
  const label = phaseLabel(timer.phase);
  const clock = formatClock(remainingMs(timer, now));
  const action = running ? "Pause" : timer.status === "paused" ? "Resume" : "Start";
  const canSkip = !(timer.phase === "work" && timer.status === "ready");
  const skipLabel = timer.phase === "work" ? "Finish focus and start the break" : "Skip the break";

  return (
    <>
      {exitFocus}
      <Tooltip content={`${label} · ${action}`} shortcut="mod+alt+t" placement="top">
        <button
          type="button"
          className={cx("statusbar-item home-focus-status", `is-${timer.phase}`, `is-${timer.status}`)}
          data-focus-keep=""
          aria-label={`${label} ${clock}, ${action.toLowerCase()}`}
          onClick={toggle}
        >
          {running ? <span className="home-focus-dot" aria-hidden="true" /> : <Pause size={14} />}
          <span className="home-focus-clock tabular">{timer.status === "ready" ? formatClock(timer.durationMs) : clock}</span>
          <span className="statusbar-muted">{timer.status === "ready" ? `Start ${label.toLowerCase()}` : label}</span>
        </button>
      </Tooltip>
      {canSkip && (
        <Tooltip content={skipLabel} placement="top">
          <button
            type="button"
            className="statusbar-item statusbar-icon home-focus-skip"
            data-focus-keep=""
            aria-label={skipLabel}
            onClick={skip}
          >
            <SkipForward size={14} />
          </button>
        </Tooltip>
      )}
    </>
  );
}

/** Pin count; toggles the pins drawer (which it also renders). */
export function PinsStatusItem() {
  const total = usePinsStore((s) => countPins(s.groups));
  const open = useHomeStore((s) => s.pinsDrawerOpen);
  const toggle = useHomeStore((s) => s.togglePinsDrawer);
  return (
    <>
      <Tooltip content={open ? "Hide pins" : "Show pins"} shortcut="mod+alt+b" placement="top">
        <button
          type="button"
          className={cx("statusbar-item home-pins-status", open && "is-active")}
          aria-pressed={open}
          aria-label={`Pins (${total})`}
          {...{ [PINS_DRAWER_TOGGLE_ATTR]: "" }}
          onClick={toggle}
        >
          <Bookmark size={14} />
          {total > 0 && <span className="statusbar-muted tabular">{total}</span>}
        </button>
      </Tooltip>
      <PinsDrawer />
    </>
  );
}
