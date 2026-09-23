/**
 * Formatting helpers for note history: relative times, day grouping for the
 * activity timeline and human-readable descriptions of commits and versions.
 * Pure functions — every "now" is injectable for tests.
 */
import type { GitChangeKind, HistoryActivity, NoteVersion } from "../../types";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Local calendar day `YYYY-MM-DD` of a Unix timestamp (seconds). */
export function dayKey(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days between the timestamp's day and today's (0 = today). */
function daysAgo(seconds: number, nowMs: number): number {
  return Math.round((startOfLocalDay(nowMs) - startOfLocalDay(seconds * 1000)) / (DAY * 1000));
}

/**
 * Short relative time: "just now", "5m ago", "3h ago", "yesterday",
 * "4d ago", then a date ("Sep 14", or "Sep 14, 2025" in another year).
 * Future timestamps (clock skew) read as "just now".
 */
export function relativeTime(seconds: number, nowMs: number = Date.now()): string {
  const delta = Math.floor(nowMs / 1000) - seconds;
  if (delta < 45) return "just now";
  if (delta < HOUR) return `${Math.max(1, Math.round(delta / MINUTE))}m ago`;
  const days = daysAgo(seconds, nowMs);
  if (days === 0 || delta < 6 * HOUR) return `${Math.max(1, Math.floor(delta / HOUR))}h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return formatDate(seconds, nowMs);
}

/** "Sep 14" (this year) or "Sep 14, 2025". */
export function formatDate(seconds: number, nowMs: number = Date.now()): string {
  const d = new Date(seconds * 1000);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Local wall-clock time "14:05". */
export function formatClock(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Full timestamp for tooltips: "Mon, Sep 14, 2026, 14:05". */
export function formatDateTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Heading for a day group: "Today", "Yesterday", "Monday, Sep 14". */
export function dayLabel(seconds: number, nowMs: number = Date.now()): string {
  const days = daysAgo(seconds, nowMs);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(seconds * 1000);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Items of one calendar day, in input order. */
export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/**
 * Group timestamped items (already sorted, typically newest first) into
 * consecutive calendar days.
 */
export function groupByDay<T extends { time: number }>(items: T[], nowMs: number = Date.now()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const key = dayKey(item.time);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(item.time, nowMs), items: [item] });
  }
  return groups;
}

/** File name without folder and `.md` extension ("Inbox/Idea.md" → "Idea"). */
export function noteTitle(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return name.replace(/\.md$/i, "");
}

/** Folder part of a vault-relative path ("" for the vault root). */
export function noteFolder(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx <= 0 ? "" : relPath.slice(0, idx);
}

/** True for Markdown notes (the only files the history view can diff). */
export function isNotePath(path: string): boolean {
  return /\.md$/i.test(path);
}

/**
 * Vault-relative form of an absolute note path, or `null` when the path is
 * not inside `vaultPath`.
 */
export function relativeToVault(path: string, vaultPath: string | null): string | null {
  if (!vaultPath) return null;
  const root = vaultPath.replace(/[\\/]+$/, "");
  const normalized = path.replace(/\\/g, "/");
  const rootNormalized = root.replace(/\\/g, "/");
  if (!normalized.startsWith(`${rootNormalized}/`)) return null;
  return normalized.slice(rootNormalized.length + 1);
}

/** What a commit message says about its origin. */
export type CommitKind = "note" | "notes" | "restore" | "initial" | "other";

/** Classify a history commit message. */
export function commitKind(message: string): CommitKind {
  if (message.startsWith("restore: ")) return "restore";
  if (message.startsWith("notes: initial snapshot")) return "initial";
  if (message.startsWith("note: ")) return "note";
  if (message.startsWith("notes: ")) return "notes";
  return "other";
}

/** Title + detail line for an activity entry. */
export function describeActivity(activity: HistoryActivity): { title: string; detail: string } {
  const kind = commitKind(activity.message);
  const first = activity.files[0];
  if (kind === "initial") {
    return { title: "History started", detail: `${countLabel(activity.file_count, "file")} captured` };
  }
  if (activity.file_count === 1 && first) {
    const title = noteTitle(first.rel_path);
    const folder = noteFolder(first.rel_path);
    if (kind === "restore") {
      const to = /\bto ([0-9a-f]{4,40})$/.exec(activity.message)?.[1];
      return { title: `Restored ${title}`, detail: to ? `to version ${to}` : folder };
    }
    return { title, detail: `${changeVerb(first.change)}${folder ? ` in ${folder}` : ""}` };
  }
  if (activity.file_count === 0) {
    return { title: activity.message || "Snapshot", detail: "No file changes" };
  }
  return { title: `${countLabel(activity.file_count, "file")} changed`, detail: activity.message };
}

/** "1 file" / "3 files". */
export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Past-tense verb for a change kind. */
export function changeVerb(change: GitChangeKind): string {
  switch (change) {
    case "added":
      return "Created";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "typechange":
      return "Changed type";
    default:
      return "Edited";
  }
}

/** Label for a version row ("Created", "Edited", "Restored", …). */
export function versionLabel(version: NoteVersion): string {
  if (commitKind(version.message) === "restore") return "Restored";
  if (commitKind(version.message) === "initial") return "First snapshot";
  return changeVerb(version.change);
}

/** Minimal note shape for {@link matchNotes}. */
export interface NoteLike {
  path: string;
  name: string;
}

/**
 * Notes matching a picker query, best first: exact name, name prefix, word
 * prefix inside the name, then substring of the name or path. Empty query
 * → no results.
 */
export function matchNotes<T extends NoteLike>(notes: T[], query: string, limit = 8): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { note: T; score: number }[] = [];
  for (const note of notes) {
    const name = note.name.toLowerCase();
    let score: number;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.split(/[\s\-_./]+/).some((word) => word.startsWith(q))) score = 2;
    else if (name.includes(q)) score = 3;
    else if (note.path.toLowerCase().includes(q)) score = 4;
    else continue;
    scored.push({ note, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.note.name.localeCompare(b.note.name))
    .slice(0, limit)
    .map((s) => s.note);
}
