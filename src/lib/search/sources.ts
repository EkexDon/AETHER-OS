/**
 * Client-side launcher sources that the backend index does not hold:
 * browser bookmarks (kept by the Browser view in `localStorage`) and the
 * clipboard history (optional — served by the clipboard feature).
 */
import { listClips } from "../ipc";
import type { ClipItem } from "../../types";
import { launcherScore } from "./fuzzy";

/** Where the Browser view stores its bookmarks. */
export const BOOKMARKS_STORAGE_KEY = "aether-browser-bookmarks";

/** A browser bookmark. */
export interface BookmarkEntry {
  title: string;
  url: string;
}

/** Bookmarks saved in the Browser view; malformed storage yields `[]`. */
export function loadBookmarks(storage: Pick<Storage, "getItem"> | null = safeStorage()): BookmarkEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(BOOKMARKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (b): b is BookmarkEntry =>
          typeof b === "object" && b !== null && typeof (b as BookmarkEntry).url === "string" && /^https?:\/\//i.test((b as BookmarkEntry).url)
      )
      .map((b) => ({ url: b.url, title: typeof b.title === "string" && b.title.trim() ? b.title.trim() : b.url }));
  } catch {
    return [];
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Host name of a URL for subtitles (`https://docs.rs/x` → `docs.rs`). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Bookmarks matching `query` by title, host or URL, best first. */
export function matchBookmarks(bookmarks: BookmarkEntry[], query: string, limit = 4): { bookmark: BookmarkEntry; score: number }[] {
  const q = query.trim();
  if (!q) return [];
  return bookmarks
    .map((bookmark) => ({ bookmark, score: launcherScore(q, bookmark.title, [hostOf(bookmark.url), bookmark.url]) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Clipboard items matching `query` (full-text search of the clipboard
 * feature). Resolves to `[]` when the clipboard history is unavailable —
 * the launcher treats it as an optional source.
 */
export async function searchClipboard(query: string, limit = 4): Promise<ClipItem[]> {
  if (!query.trim()) return [];
  try {
    const clips = await listClips({ query, limit });
    return Array.isArray(clips) ? clips.filter((c) => c.kind !== "image") : [];
  } catch {
    return [];
  }
}
