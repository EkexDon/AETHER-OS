import { Flame, Focus, Maximize2, Pause, Play, SkipForward, Square, Timer } from "lucide-react";
import type { FocusStats } from "../../types";
import { useFocusStore } from "../../lib/focusStore";
import { formatClock, phaseLabel, phaseProgress, remainingMs } from "../../lib/home/pomodoro";
import { formatMinutes } from "../../lib/home/focusStats";
import { Button, EmptyState, IconButton, Tooltip, cx, toast } from "../../ui";
import { FocusChart } from "./FocusChart";
import { HomeBlock } from "./HomeBlock";
import { useNow } from "./hooks";

export interface FocusBlockProps {
  stats: FocusStats | null;
  today: string;
  loading?: boolean;
  error?: string | null;
  onOpenSettings: () => void;
}

/** Pomodoro controls, today's focus time, streak and the last 7 days. */
export function FocusBlock({ stats, today, loading, error, onOpenSettings }: FocusBlockProps) {
  const timer = useFocusStore((s) => s.timer);
  const settings = useFocusStore((s) => s.settings);
  const focusMode = useFocusStore((s) => s.focusMode);
  const { toggle, skip, stop, toggleFocusMode } = useFocusStore.getState();
  const now = useNow(1000, timer.status === "running");

  const idle = timer.phase === "idle";
  const left = idle ? settings.workMinutes * 60_000 : remainingMs(timer, now);
  const progress = idle ? 0 : phaseProgress(timer, now);
  const cycles = settings.cyclesBeforeLongBreak;
  const filled = timer.phase === "longBreak" ? cycles : timer.completedInCycle;
  const primaryLabel = idle
    ? "Start focus"
    : timer.status === "running"
      ? "Pause"
      : timer.status === "paused"
        ? "Resume"
        : `Start ${phaseLabel(timer.phase).toLowerCase()}`;
  const canSkip = !idle && !(timer.phase === "work" && timer.status === "ready");
  const hasHistory = !!stats && stats.by_day.some((d) => d.minutes > 0);

  return (
    <HomeBlock
      title="Focus"
      icon={Timer}
      loading={loading}
      error={error}
      actionLabel="Settings"
      onAction={onOpenSettings}
      className="home-focus"
    >
      <div className={cx("home-timer", `is-${timer.phase}`, `is-${timer.status}`)}>
        <div className="home-timer-top">
          <div className="home-timer-readout">
            <span className="home-timer-phase">
              {idle ? `${settings.workMinutes} min Pomodoro` : phaseLabel(timer.phase)}
              {timer.status === "paused" && <span className="home-timer-paused"> · paused</span>}
            </span>
            <span className="home-timer-clock tabular" aria-live="off">
              {formatClock(left)}
            </span>
          </div>
          <div className="home-timer-cycles" aria-label={`${filled} of ${cycles} sessions before the long break`}>
            {Array.from({ length: cycles }, (_, i) => (
              <span key={i} className={cx("home-timer-cycle", i < filled && "is-done")} />
            ))}
          </div>
        </div>
        <div
          className="home-timer-progress"
          role="progressbar"
          aria-label="Phase progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
        <div className="home-timer-controls">
          <Tooltip content={primaryLabel} shortcut="mod+alt+t" placement="top">
            <Button
              variant="secondary"
              size="sm"
              iconLeft={timer.status === "running" ? <Pause size={13} /> : <Play size={13} />}
              onClick={toggle}
            >
              {primaryLabel}
            </Button>
          </Tooltip>
          {canSkip && (
            <IconButton
              size="sm"
              label={timer.phase === "work" ? "Finish focus and start the break" : "Skip the break"}
              icon={<SkipForward size={13} />}
              onClick={skip}
            />
          )}
          {!idle && <IconButton size="sm" label="Stop Pomodoro" icon={<Square size={12} />} onClick={stop} />}
          <span className="home-timer-spacer" />
          <IconButton
            size="sm"
            label={focusMode ? "Exit focus mode" : "Focus mode"}
            shortcut="mod+shift+f"
            active={focusMode}
            icon={focusMode ? <Focus size={13} /> : <Maximize2 size={13} />}
            onClick={() => {
              toggleFocusMode();
              if (useFocusStore.getState().focusMode) toast.info("Focus mode on", { description: "Press Esc twice to exit." });
            }}
          />
        </div>
      </div>

      <dl className="home-focus-stats">
        <div>
          <dt>Today</dt>
          <dd className="tabular">{formatMinutes(stats?.today_minutes ?? 0)}</dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd className="tabular">{stats?.today_sessions ?? 0}</dd>
        </div>
        <div>
          <dt>Streak</dt>
          <dd className="tabular">
            <Flame size={13} className={cx("home-streak-icon", (stats?.streak_days ?? 0) > 0 && "is-active")} aria-hidden="true" />
            {stats?.streak_days ?? 0} {stats?.streak_days === 1 ? "day" : "days"}
          </dd>
        </div>
      </dl>

      {hasHistory && stats ? (
        <FocusChart days={stats.by_day} today={today} />
      ) : (
        <EmptyState
          size="sm"
          icon={Flame}
          title="No focus sessions this week"
          description={`Finish a ${settings.workMinutes}-minute session to start your streak.`}
          className="home-focus-empty"
        />
      )}
    </HomeBlock>
  );
}
