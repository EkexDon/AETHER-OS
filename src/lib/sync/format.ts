/** Display helpers for the Sync & Backup UI (pure, tested). */
import type { SyncProgress, SyncReport, SyncStatus } from "../../types";

/** Visual tone of a status (maps onto `Badge` variants). */
export type SyncTone = "neutral" | "accent" | "success" | "warning" | "danger";

/** Strip the logical namespace (`vault/Notes/a.md` → `Notes/a.md`). */
export function displayPath(path: string): string {
  for (const prefix of ["vault/", "app-conflicts/", "app/"]) {
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

/** Last path segment of a file-system path (`/a/b/Vault` → `Vault`). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** `1536` → `1.5 KB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Sep". Future times read "in 5 min". */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const then = new Date(iso);
  const ms = then.getTime();
  if (Number.isNaN(ms)) return "unknown";
  const diff = now.getTime() - ms;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const phrase = (text: string) => (future ? `in ${text}` : `${text} ago`);
  if (abs < 45_000) return future ? "in a moment" : "just now";
  if (abs < hour) return phrase(`${Math.max(1, Math.round(abs / minute))} min`);
  if (abs < day) return phrase(`${Math.round(abs / hour)} h`);
  if (!future && abs < 2 * day) return "yesterday";
  if (abs < 7 * day) return phrase(`${Math.round(abs / day)} days`);
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short", year: then.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** Absolute local date + time for tooltips. */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Short label + tone for a status. */
export function statusSummary(status: SyncStatus | null): { label: string; tone: SyncTone; detail: string } {
  if (!status) return { label: "Loading", tone: "neutral", detail: "Reading sync status…" };
  if (status.state === "syncing") {
    const op = status.progress?.operation ?? "sync";
    const label = op === "sync" ? "Syncing" : op === "backup" ? "Backing up" : op === "restore" ? "Restoring" : op === "verify" ? "Verifying" : "Re-encrypting";
    return { label, tone: "accent", detail: progressText(status.progress) };
  }
  if (!status.configured && !status.enabled) {
    return { label: "Not set up", tone: "neutral", detail: "Choose a folder to sync through." };
  }
  if (!status.enabled) return { label: "Paused", tone: "neutral", detail: "Background sync is off." };
  if (status.state === "locked") {
    return { label: "Locked", tone: "warning", detail: status.message ?? "Enter your passphrase to unlock sync." };
  }
  if (status.state === "error") {
    return { label: "Error", tone: "danger", detail: humanizeError(status.message ?? "The last sync failed.") };
  }
  if (status.conflicts > 0) {
    return {
      label: `${status.conflicts} conflict${status.conflicts === 1 ? "" : "s"}`,
      tone: "warning",
      detail: "Both versions were kept — pick one below.",
    };
  }
  return {
    label: "Up to date",
    tone: "success",
    detail: status.last_sync_at ? `Last synced ${relativeTime(status.last_sync_at)}.` : "Waiting for the first sync.",
  };
}

/** "12 / 40" style progress text. */
export function progressText(progress: SyncProgress | null | undefined): string {
  if (!progress) return "Working…";
  if (progress.total <= 0) return "Preparing…";
  return `${Math.min(progress.done, progress.total)} of ${progress.total}`;
}

/** 0–100, or null when indeterminate. */
export function progressPercent(progress: SyncProgress | null | undefined): number | null {
  if (!progress || progress.total <= 0) return null;
  return Math.round((Math.min(progress.done, progress.total) / progress.total) * 100);
}

/** One-line summary of a sync round. */
export function describeReport(report: SyncReport): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many = `${one}s`) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(report.uploaded, "upload");
  add(report.downloaded, "download");
  add(report.deleted_local + report.deleted_remote, "deletion");
  add(report.conflicts, "conflict");
  if (parts.length === 0) parts.push("Everything was already in sync");
  if (report.issues.length > 0) parts.push(`${report.issues.length} skipped`);
  return parts.join(" · ");
}

/** `60` → `every minute`, `900` → `every 15 minutes`, `3600` → `every hour`. */
export function intervalLabel(seconds: number): string {
  if (seconds < 60) return `every ${seconds} seconds`;
  if (seconds === 60) return "every minute";
  if (seconds < 3600) return `every ${Math.round(seconds / 60)} minutes`;
  if (seconds === 3600) return "every hour";
  return `every ${Math.round(seconds / 3600)} hours`;
}

/**
 * Display prefixes of every `AetherError` variant (`engine/error.rs`); a
 * parity test fails when Rust gains a category that is missing here.
 */
export const ERROR_CATEGORIES = [
  "invalid input",
  "vault error",
  "I/O error",
  "database error",
  "network error",
  "sync error",
  "crypto error",
  "AI engine error",
  "vector engine error",
] as const;

const CATEGORY_PREFIX = new RegExp(
  `^(?:${ERROR_CATEGORIES.map((c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")}): `,
  "i"
);

/**
 * Remove the Rust error category prefix and capitalise
 * (`crypto error: wrong passphrase` → `Wrong passphrase`). Knows every
 * `AetherError` category ({@link ERROR_CATEGORIES}). A doubled prefix
 * (`invalid input: invalid input: x`) is stripped once per layer.
 */
export function humanizeError(message: string): string {
  let stripped = message.trim();
  for (let i = 0; i < 3 && CATEGORY_PREFIX.test(stripped); i++) stripped = stripped.replace(CATEGORY_PREFIX, "").trim();
  return stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : message;
}

/** Message of an unknown thrown value, humanised. */
export function errorText(error: unknown): string {
  return humanizeError(error instanceof Error ? error.message : String(error));
}
