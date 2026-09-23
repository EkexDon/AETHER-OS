/** Home feature types — focus log mirrors `src-tauri/src/engine/focus_log.rs`;
 *  pins and Pomodoro settings are frontend-only. */

/** What a logged focus session was. */
export type FocusSessionKind = "work" | "break" | "long_break";

/** One completed session as stored in `<data_dir>/focus/sessions.jsonl`. */
export interface FocusSession {
  id: string;
  /** RFC 3339 with the local UTC offset. */
  started_at: string;
  ended_at: string;
  /** Whole minutes (≥ 1). */
  minutes: number;
  kind: FocusSessionKind;
  /** Note that was open while focusing (metadata only). */
  note_path: string | null;
}

/** A session to append (`cmd_focus_log_session`, nested → snake_case). */
export interface FocusSessionInput {
  started_at: string;
  ended_at: string;
  /** Derived from the timestamps when omitted. */
  minutes?: number | null;
  kind: FocusSessionKind;
  note_path?: string | null;
}

/** Work minutes on one local day. */
export interface FocusDay {
  /** `YYYY-MM-DD`. */
  date: string;
  minutes: number;
  sessions: number;
}

/** Aggregated focus statistics (`cmd_focus_stats`). */
export interface FocusStats {
  today_minutes: number;
  today_sessions: number;
  /** Consecutive days with a work session, ending today (or yesterday). */
  streak_days: number;
  /** Work minutes across the `by_day` window. */
  total_minutes: number;
  /** Oldest first, ending today. */
  by_day: FocusDay[];
}

/** What a pin points at. */
export type PinKind = "note" | "project" | "command" | "conversation" | "url";

/** A bookmark shown on Home, in the pins drawer and the sidebar panel. */
export interface PinItem {
  id: string;
  kind: PinKind;
  /** Note path, project path, command id, conversation id or URL. */
  ref: string;
  label: string;
  /** Optional lucide icon name override. */
  icon?: string;
}

/** A named, ordered list of pins. */
export interface PinGroup {
  id: string;
  name: string;
  items: PinItem[];
}

/** Pomodoro phase. `idle` means no timer is set. */
export type PomodoroPhase = "idle" | "work" | "break" | "longBreak";

/** Whether the current phase is counting down. `ready` = armed, not started. */
export type PomodoroStatus = "idle" | "ready" | "running" | "paused";

/** User-configurable Pomodoro settings (persisted as `aether-focus-settings`). */
export interface PomodoroSettings {
  /** Minutes per phase. */
  workMinutes: number;
  breakMinutes: number;
  longBreakMinutes: number;
  /** Work sessions before a long break. */
  cyclesBeforeLongBreak: number;
  /** Start breaks automatically when a work session ends. */
  autoStartBreaks: boolean;
  /** Desktop notification when a phase ends. */
  notifications: boolean;
  /** Short chime when a phase ends. */
  sound: boolean;
}
