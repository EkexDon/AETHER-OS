/** Formatting helpers for export reports and the recent exports list. */
import type { ExportKind, ExportProgress } from "../../types";

/** `1.2 MB`, `830 KB`, `12 B`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** `420 ms`, `3.4 s`, `2 min 5 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

/** `just now`, `5 min ago`, `3 h ago`, `yesterday`, `4 days ago`, or a date. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diff = now.getTime() - then.getTime();
  if (Number.isNaN(diff)) return "";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Progress as a 0–100 percentage (0 without progress). */
export function progressPercent(progress: ExportProgress | null): number {
  if (!progress || progress.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)));
}

/** Human label of a progress phase. */
export function phaseLabel(phase: string): string {
  switch (phase) {
    case "rendering":
      return "Rendering pages";
    case "pages":
      return "Writing pages";
    case "notes":
      return "Adding notes";
    case "attachments":
      return "Copying attachments";
    case "finishing":
      return "Finishing";
    default:
      return "Exporting";
  }
}

/** Label of a recorded export kind. */
export function kindLabel(kind: ExportKind): string {
  return kind === "html" ? "HTML page" : kind === "site" ? "Static site" : "Markdown bundle";
}

/** Plural helper: `1 note`, `3 notes`. */
export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? noun : pluralNoun}`;
}
