/** Home feature commands (`src-tauri/src/commands/home_commands.rs`). */
import type { FocusSession, FocusSessionInput, FocusStats } from "../../types";
import { call } from "./core";

/** Append a completed focus session to the focus log; returns the stored record. */
export const focusLogSession = (session: FocusSessionInput) =>
  call<FocusSession>("cmd_focus_log_session", {
    session: {
      started_at: session.started_at,
      ended_at: session.ended_at,
      minutes: session.minutes ?? null,
      kind: session.kind,
      note_path: session.note_path ?? null,
    },
  });

/** Focus statistics for the last `days` days (1–366) ending today. */
export const focusStats = (days: number) => call<FocusStats>("cmd_focus_stats", { days });

/** The `limit` (1–1000) most recent focus sessions, newest first. */
export const focusList = (limit: number) => call<FocusSession[]>("cmd_focus_list", { limit });
