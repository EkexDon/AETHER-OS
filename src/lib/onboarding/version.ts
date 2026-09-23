/**
 * Version comparison and the launch decision: show the setup wizard on the
 * first run, the "What's new" note once after an update, and run the daily
 * update check.
 */
import type { OnboardingState } from "../../types";

/** A parsed SemVer 2.0 version (build metadata dropped). */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers (`["rc", 1]`); empty for a release. */
  pre: (string | number)[];
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parse `1.2.3`, `v1.2.3-rc.1+build`; `null` when not SemVer. */
export function parseVersion(input: string | null | undefined): ParsedVersion | null {
  const m = SEMVER.exec((input ?? "").trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

function comparePre(a: (string | number)[], b: (string | number)[]): number {
  // A release outranks any of its pre-releases (SemVer §11.3).
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * SemVer precedence: negative when `a < b`, 0 when equal, positive when
 * `a > b`. Unparsable versions sort before every valid one.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  return (
    pa.major - pb.major ||
    pa.minor - pb.minor ||
    pa.patch - pb.patch ||
    comparePre(pa.pre, pb.pre)
  );
}

/** What to do right after launch. */
export interface LaunchDecision {
  /** Overlay to open, if any. */
  show: "wizard" | "whats-new" | null;
  /** Store the running version as `version_seen`. */
  markSeen: boolean;
}

/**
 * Decide the launch overlay. The wizard wins on a first run
 * (`completed_at === null`); after an upgrade the "What's new" note shows
 * once (unless turned off). Any version change — also a downgrade or a
 * missing `version_seen` — is recorded so the note never repeats.
 */
export function launchDecision(state: OnboardingState, currentVersion: string, showWhatsNew = true): LaunchDecision {
  if (!state.completed_at) return { show: "wizard", markSeen: false };
  const seen = state.version_seen;
  if (!seen) return { show: null, markSeen: true };
  if (seen === currentVersion) return { show: null, markSeen: false };
  const upgraded = compareVersions(currentVersion, seen) > 0;
  return { show: upgraded && showWhatsNew ? "whats-new" : null, markSeen: true };
}

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the automatic update check is due (enabled and ≥ 24 h since the last one). */
export function isUpdateCheckDue(enabled: boolean, lastCheckAt: number | null, now: number): boolean {
  if (!enabled) return false;
  if (lastCheckAt === null || !Number.isFinite(lastCheckAt)) return true;
  // A clock that jumped backwards also triggers a fresh check.
  return now - lastCheckAt >= DAY_MS || now < lastCheckAt;
}
