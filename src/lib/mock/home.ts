/**
 * Mock focus log (`cmd_focus_*`) for the browser preview: 14 days of seeded
 * Pomodoro sessions with a live streak, validation that mirrors
 * `engine/focus_log.rs`, and stats computed by the shared TS port.
 */
import type { FocusSession, FocusSessionKind } from "../../types";
import { computeFocusStats, dateKey, MAX_STATS_DAYS } from "../home/focusStats";
import { toLocalRfc3339 } from "../home/format";
import { argNumber, argObject, mockUuid, registerReset, type MockHandlerMap } from "./runtime";

const MINUTE = 60_000;
const MAX_SESSION_MINUTES = 24 * 60;
const MAX_LIST_LIMIT = 1000;
const KINDS: FocusSessionKind[] = ["work", "break", "long_break"];

/** Work sessions per day, oldest (13 days ago) → yesterday. Gaps break the streak. */
const SEED_PATTERN = [3, 4, 0, 2, 5, 3, 0, 4, 3, 2, 4, 5, 3];

function seedSessions(now: Date = new Date()): FocusSession[] {
  const sessions: FocusSession[] = [];
  const push = (start: number, minutes: number, kind: FocusSessionKind) => {
    sessions.push({
      id: mockUuid(),
      started_at: toLocalRfc3339(start),
      ended_at: toLocalRfc3339(start + minutes * MINUTE),
      minutes,
      kind,
      note_path: null,
    });
  };
  SEED_PATTERN.forEach((count, i) => {
    const day = new Date(now);
    day.setDate(day.getDate() - (SEED_PATTERN.length - i));
    day.setHours(9, 0, 0, 0);
    let t = day.getTime();
    for (let n = 0; n < count; n++) {
      push(t, 25, "work");
      t += 25 * MINUTE;
      const long = (n + 1) % 4 === 0;
      push(t, long ? 15 : 5, long ? "long_break" : "break");
      t += (long ? 15 : 5) * MINUTE;
    }
  });
  // Today: two finished sessions shortly before "now", if they fit into today.
  const todayKey = dateKey(now);
  for (const endsAgo of [70, 35]) {
    const start = now.getTime() - (endsAgo + 25) * MINUTE;
    if (dateKey(new Date(start)) === todayKey) push(start, 25, "work");
  }
  return sessions;
}

let sessions: FocusSession[] = seedSessions();
registerReset(() => {
  sessions = seedSessions();
});

function invalid(message: string): Error {
  return new Error(`invalid input: ${message}`);
}

function parseTs(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw invalid(`invalid timestamp "${String(value)}"`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw invalid(`invalid timestamp "${value}"`);
  return ms;
}

function logSession(input: Partial<Record<keyof FocusSession, unknown>>): FocusSession {
  const started = parseTs(input.started_at);
  const ended = parseTs(input.ended_at);
  if (ended < started) throw invalid("ended_at must not be before started_at");
  const kind = KINDS.includes(input.kind as FocusSessionKind) ? (input.kind as FocusSessionKind) : null;
  if (!kind) throw new Error(`invalid args \`session\` for command: unknown variant \`${String(input.kind)}\``);
  const span = Math.floor((ended - started + 30_000) / MINUTE);
  const minutes = typeof input.minutes === "number" ? Math.floor(input.minutes) : span;
  if (minutes <= 0) throw invalid("a focus session must last at least one minute");
  if (minutes > MAX_SESSION_MINUTES) throw invalid(`a focus session cannot exceed ${MAX_SESSION_MINUTES} minutes`);
  if (minutes > span + 1) throw invalid(`${minutes} minutes do not fit between started_at and ended_at`);
  let notePath: string | null = null;
  if (typeof input.note_path === "string" && input.note_path.trim()) {
    notePath = input.note_path.trim();
    if (notePath.length > 4096 || /[\u0000-\u001f\u007f]/.test(notePath)) {
      throw invalid("note_path must be a single line of at most 4096 bytes");
    }
  }
  const session: FocusSession = {
    id: mockUuid(),
    started_at: toLocalRfc3339(started),
    ended_at: toLocalRfc3339(ended),
    minutes,
    kind,
    note_path: notePath,
  };
  sessions.push(session);
  return session;
}

export const homeHandlers: MockHandlerMap = {
  cmd_focus_log_session: (args) => logSession(argObject<FocusSession>(args, "session")),
  cmd_focus_stats: (args) => {
    const days = Math.min(MAX_STATS_DAYS, Math.max(1, Math.floor(argNumber(args, "days"))));
    return computeFocusStats(sessions, dateKey(new Date()), days);
  },
  cmd_focus_list: (args) => {
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(argNumber(args, "limit"))));
    return [...sessions]
      .map((s, i) => ({ s, i, end: Date.parse(s.ended_at) }))
      .sort((a, b) => b.end - a.end || b.i - a.i)
      .slice(0, limit)
      .map(({ s }) => s);
  },
};
