/**
 * gitView — pure presentation helpers for the Source Control panel.
 * Kept free of React/IPC so every branch is trivially unit-testable.
 */

import type { GitChangeKind, GitStatusEntry } from "../types";

export interface ChangeGroup {
  /** Files with staged changes (index ≠ HEAD). */
  staged: GitStatusEntry[];
  /** Files with unstaged changes or untracked files (worktree ≠ index). */
  unstaged: GitStatusEntry[];
}

/** Split a status snapshot's entries into the two VS Code style groups. */
export function groupChanges(entries: GitStatusEntry[]): ChangeGroup {
  return {
    staged: entries.filter((e) => e.staged !== null),
    unstaged: entries.filter((e) => e.unstaged !== null),
  };
}

const CHANGE_LABELS: Record<GitChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
};

export function changeLabel(kind: GitChangeKind): string {
  return CHANGE_LABELS[kind];
}

export const CHANGE_COLORS: Record<GitChangeKind, string> = {
  added: "#86efac",
  modified: "#fbbf24",
  deleted: "#f87171",
  renamed: "#93c5fd",
  typechange: "#c084fc",
};

/**
 * Compact relative time like Git tooling shows ("2h", "3d", "May 12").
 * Deterministic: takes `now` so tests don't sleep.
 */
export function formatRelativeTime(unixSeconds: number, now: number): string {
  const diff = Math.max(0, now - unixSeconds);
  const minutes = Math.floor(diff / 60);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const date = new Date(unixSeconds * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "↑1 ↓2" style sync summary; empty string when fully synced. */
export function describeSyncState(ahead: number, behind: number): string {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.join(" ");
}

/** The file name part of a repo-relative path. */
export function fileNameOf(repoPath: string): string {
  const idx = repoPath.lastIndexOf("/");
  return idx === -1 ? repoPath : repoPath.slice(idx + 1);
}
