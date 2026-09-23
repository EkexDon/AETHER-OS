/** Clipboard history types — mirror `src-tauri/src/engine/clipboard.rs`. */

/** What a clip contains. */
export type ClipKind = "text" | "url" | "code" | "image" | "color";

/** One entry of the clipboard history. */
export interface ClipItem {
  /** UUID v4. */
  id: string;
  kind: ClipKind;
  /** The copied text; for images the absolute path of the stored PNG. */
  content: string;
  /** Single-line preview (≤ 200 chars); `WxH` for images. */
  preview: string;
  /** Size of the text in bytes, or of the stored PNG for images. */
  byte_len: number;
  pinned: boolean;
  /** Source application (not detected yet, always `null`). */
  source_app: string | null;
  /** Captures + copies from the UI. */
  copy_count: number;
  /** RFC 3339 UTC. */
  created_at: string;
  /** Most recent capture or copy; the history is ordered by it. */
  last_copied_at: string;
  /** `content` was shortened for a list response — use `getClip` for all of it. */
  truncated: boolean;
}

/** Persisted capture and retention settings. */
export interface ClipboardSettings {
  enabled: boolean;
  /** Unpinned clips kept (10–10 000); pinned clips don't count. */
  max_items: number;
  /** Unpinned clips not copied for this many days are pruned (0 = forever). */
  keep_days: number;
  capture_images: boolean;
}

/** Totals and watcher state. */
export interface ClipboardStats {
  total: number;
  pinned: number;
  images: number;
  bytes: number;
  /** Capture paused for this session. */
  paused: boolean;
  enabled: boolean;
  /** Copies skipped this session because they looked like secrets. */
  skipped_secrets: number;
  /** Why the system clipboard cannot be read (`null` = healthy). */
  watcher_error: string | null;
}

/** Why the history changed. */
export type ClipboardChangeReason = "captured" | "copied" | "updated" | "deleted" | "cleared" | "settings";

/** Payload of the `clipboard-changed` event. */
export interface ClipboardChangedEvent {
  id: string | null;
  reason: ClipboardChangeReason;
}

/** Filters for `listClips`. */
export interface ClipListQuery {
  /** Full-text search (prefix words, AND). */
  query?: string | null;
  kind?: ClipKind | null;
  pinnedOnly?: boolean;
  /** Page size (default 100, max 500). */
  limit?: number;
  offset?: number;
}
