/** Pure formatting helpers for the clipboard history UI. */
import type { ClipItem, ClipKind } from "../../types";

/** Kind filter of the history view (`all` = no filter). */
export type ClipKindFilter = "all" | ClipKind;

/** Filter options in display order. */
export const KIND_FILTERS: { value: ClipKindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "text", label: "Text" },
  { value: "url", label: "Links" },
  { value: "code", label: "Code" },
  { value: "image", label: "Images" },
  { value: "color", label: "Colors" },
];

const KIND_LABELS: Record<ClipKind, string> = {
  text: "Text",
  url: "Link",
  code: "Code",
  image: "Image",
  color: "Color",
};

/** Singular label of a kind ("Link", "Code", …). */
export function kindLabel(kind: ClipKind): string {
  return KIND_LABELS[kind];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative time for list rows: `now`, `5m`, `3h`, `Yesterday`,
 * weekday within a week, then `12 Sep` (plus the year when it differs).
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diff = now.getTime() - then.getTime();
  if (Number.isNaN(diff)) return "";
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (then.getTime() >= startOfToday) return `${Math.floor(diff / HOUR)}h`;
  if (then.getTime() >= startOfToday - DAY) return "Yesterday";
  if (then.getTime() >= startOfToday - 6 * DAY) {
    return then.toLocaleDateString("en-US", { weekday: "short" });
  }
  const sameYear = then.getFullYear() === now.getFullYear();
  return then.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Long, absolute timestamp for tooltips and the detail pane. */
export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `512 B`, `1.2 KB`, `3.4 MB` (1024-based). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Parse an image preview (`1440x900`) into its dimensions. */
export function imageDimensions(preview: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(preview.trim());
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** `1440 × 900` for image previews; other previews unchanged. */
export function displayPreview(item: Pick<ClipItem, "kind" | "preview">): string {
  if (item.kind !== "image") return item.preview;
  const dims = imageDimensions(item.preview);
  return dims ? `${dims.width} × ${dims.height}` : item.preview;
}

/** Secondary line of a list row: kind, size or copy count. */
export function rowDescription(item: ClipItem): string {
  const parts: string[] = [kindLabel(item.kind)];
  if (item.kind === "image") parts.push(formatBytes(item.byte_len));
  else if (item.kind === "url") {
    const host = urlHost(item.content);
    if (host) parts.push(host);
  } else if (item.kind === "text" || item.kind === "code") {
    const lines = lineCount(item.content);
    if (lines > 1) parts.push(`${lines} lines`);
    else parts.push(`${item.content.trim().length} chars`);
  }
  if (item.copy_count > 1) parts.push(`copied ${item.copy_count}×`);
  return parts.join(" · ");
}

/** Host of a URL clip (`github.com`), or `null`. */
export function urlHost(text: string): string | null {
  try {
    const candidate = /^www\./i.test(text.trim()) ? `https://${text.trim()}` : text.trim();
    const url = new URL(candidate);
    return url.hostname || null;
  } catch {
    return null;
  }
}

/** An openable `href` for a URL clip (adds `https://` to `www.` links). */
export function urlHref(text: string): string | null {
  const trimmed = text.trim();
  const candidate = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
  try {
    const url = new URL(candidate);
    return ["http:", "https:", "mailto:", "ftp:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Number of lines (a trailing newline does not start a new line). */
export function lineCount(text: string): number {
  if (!text) return 0;
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed.split("\n").length;
}

/** Word count for text clips. */
export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/);
  return words[0] === "" ? 0 : words.length;
}

/** Header subtitle: `412 clips · 18 pinned · 1.2 MB`. */
export function statsSummary(stats: { total: number; pinned: number; bytes: number } | null): string {
  if (!stats) return "Loading history…";
  if (stats.total === 0) return "No clips yet";
  const parts = [`${stats.total.toLocaleString("en-US")} clip${stats.total === 1 ? "" : "s"}`];
  if (stats.pinned > 0) parts.push(`${stats.pinned} pinned`);
  parts.push(formatBytes(stats.bytes));
  return parts.join(" · ");
}

/**
 * Default title for "Save as note": the URL host + path for links, the
 * first line for text and code, `Image 1440 × 900` or `Color #3fb0a3`.
 */
export function suggestNoteTitle(item: ClipItem): string {
  const clean = (s: string) =>
    s
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80)
      .trim();
  switch (item.kind) {
    case "image":
      return `Image ${displayPreview(item)}`;
    case "color":
      return clean(`Color ${item.content.trim()}`);
    case "url": {
      const host = urlHost(item.content);
      return clean(host ? `Link ${host}` : item.preview) || "Clipped link";
    }
    default:
      return clean(item.preview) || "Clipboard snippet";
  }
}
