/** Clipboard history commands (`src-tauri/src/commands/clipboard_commands.rs`). */
import type {
  ClipItem,
  ClipListQuery,
  ClipboardChangedEvent,
  ClipboardSettings,
  ClipboardStats,
} from "../../types";
import { call, listenSafe, type UnlistenFn } from "./core";

/** Tauri event emitted after every capture and change of the history. */
export const CLIPBOARD_CHANGED_EVENT = "clipboard-changed";

/** History page, newest first. Long `content` is truncated (see `ClipItem.truncated`). */
export const listClips = (query: ClipListQuery = {}) =>
  call<ClipItem[]>("cmd_clipboard_list", {
    query: query.query?.trim() ? query.query : null,
    kind: query.kind ?? null,
    pinnedOnly: query.pinnedOnly ?? false,
    limit: query.limit ?? null,
    offset: query.offset ?? null,
  });
/** One clip with its full content. */
export const getClip = (id: string) => call<ClipItem>("cmd_clipboard_get", { id });
/** Write a clip back to the system clipboard; bumps its counters. */
export const copyClip = (id: string) => call<ClipItem>("cmd_clipboard_copy", { id });
/** Copy the most recent clip back to the system clipboard (`null` = empty history). */
export const copyLatestClip = () => call<ClipItem | null>("cmd_clipboard_copy_latest");
/** Pin or unpin a clip. Pinned clips are never pruned. */
export const pinClip = (id: string, pinned: boolean) => call<ClipItem>("cmd_clipboard_pin", { id, pinned });
/** Delete one clip. */
export const deleteClip = (id: string) => call<void>("cmd_clipboard_delete", { id });
/** Delete the history (optionally keeping pinned clips); returns how many were removed. */
export const clearClipboardHistory = (keepPinned: boolean) =>
  call<number>("cmd_clipboard_clear", { keepPinned });
/** Capture and retention settings. */
export const getClipboardSettings = () => call<ClipboardSettings>("cmd_clipboard_get_settings");
/** Validate, persist and apply settings (prunes right away). */
export const setClipboardSettings = (settings: ClipboardSettings) =>
  call<ClipboardSettings>("cmd_clipboard_set_settings", { settings });
/** Pause or resume capture for this session; resolves to the new state. */
export const setClipboardPaused = (paused: boolean) => call<boolean>("cmd_clipboard_set_paused", { paused });
/** Totals, pause state and watcher health. */
export const getClipboardStats = () => call<ClipboardStats>("cmd_clipboard_stats");
/** Save a clip as a vault note (`clipboard/<title>.md`); resolves to the note path. */
export const saveClipAsNote = (id: string, title: string) =>
  call<string>("cmd_clipboard_save_as_note", { id, title });
/** An image clip as a PNG data URL; `thumbnail` picks the ≤ 256 px version. */
export const getClipImage = (id: string, thumbnail: boolean) =>
  call<string>("cmd_clipboard_image", { id, thumbnail });
/** Subscribe to history changes (captures, copies, pins, deletes, settings). */
export const onClipboardChanged = (handler: (event: ClipboardChangedEvent) => void): Promise<UnlistenFn> =>
  listenSafe<ClipboardChangedEvent>(CLIPBOARD_CHANGED_EVENT, handler);
