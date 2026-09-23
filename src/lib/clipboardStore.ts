/**
 * Clipboard history state: the loaded page of clips, filters, selection,
 * stats/settings, undoable deletes, an image cache and the live
 * `clipboard-changed` subscription. Views and the status bar read from it;
 * every backend call goes through `src/lib/ipc/clipboard.ts`.
 */
import { create } from "zustand";
import type { ClipItem, ClipboardSettings, ClipboardStats } from "../types";
import {
  clearClipboardHistory,
  copyClip,
  copyLatestClip,
  deleteClip,
  getClip,
  getClipImage,
  getClipboardSettings,
  getClipboardStats,
  listClips,
  onClipboardChanged,
  pinClip,
  saveClipAsNote,
  setClipboardPaused,
  setClipboardSettings,
} from "./ipc/clipboard";
import type { UnlistenFn } from "./ipc/core";
import { toast } from "../ui/Toast";
import { displayPreview, type ClipKindFilter } from "./clipboard/format";

/** Clips fetched per page. */
export const CLIP_PAGE_SIZE = 200;
/** Largest page the backend serves. */
const MAX_PAGE = 500;
/** Search input debounce. */
export const SEARCH_DEBOUNCE_MS = 150;
/** How long a delete can be undone. */
export const UNDO_DELETE_MS = 5000;
/** Coalesce bursts of `clipboard-changed` events. */
const EVENT_DEBOUNCE_MS = 120;
const MAX_THUMBNAILS = 120;
const MAX_FULL_IMAGES = 6;
const MAX_DETAILS = 6;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Shorten a preview for toasts. */
function short(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface ClipboardState {
  /** Loaded clips, newest first (includes clips pending deletion). */
  items: ClipItem[];
  hasMore: boolean;
  /** First page arrived at least once. */
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  /** Last list error (shown inline). */
  error: string | null;
  query: string;
  kind: ClipKindFilter;
  pinnedOnly: boolean;
  selectedId: string | null;
  stats: ClipboardStats | null;
  settings: ClipboardSettings | null;
  /** Deleted in the UI, committed after {@link UNDO_DELETE_MS}. */
  pendingDeletes: string[];
  /** Data URLs by `<id>:thumb` / `<id>:full`. */
  images: Record<string, string>;
  /** Full clips for items whose list content was truncated. */
  details: Record<string, ClipItem>;
  /** Incremented to ask the view to focus its search field. */
  focusSearchToken: number;
  /** The "Clear history" confirmation is requested (command palette). */
  clearRequested: boolean;

  /** Update the query; the list refreshes after {@link SEARCH_DEBOUNCE_MS}. */
  setQuery: (query: string) => void;
  setKind: (kind: ClipKindFilter) => void;
  setPinnedOnly: (pinnedOnly: boolean) => void;
  select: (id: string | null) => void;
  /** Move the selection by `delta` visible rows (clamped). */
  moveSelection: (delta: number) => void;
  /** Reload the first page(s) with the current filters. */
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Background refresh of totals; failures only clear the stats. */
  refreshStats: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: ClipboardSettings) => Promise<ClipboardSettings>;
  /** Copy a clip to the system clipboard (toasts "Copied"). */
  copy: (id: string) => Promise<void>;
  /** Copy the most recent clip; resolves to it (or `null` when empty). */
  copyLatest: () => Promise<ClipItem | null>;
  togglePin: (id: string) => Promise<void>;
  /** Hide now, delete after {@link UNDO_DELETE_MS} unless undone. */
  deleteWithUndo: (id: string) => void;
  undoDelete: (id: string) => void;
  /** Commit every pending delete immediately. */
  flushDeletes: () => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  togglePaused: () => Promise<void>;
  clear: (keepPinned: boolean) => Promise<number>;
  requestClear: (open: boolean) => void;
  requestSearchFocus: () => void;
  /** Data URL of an image clip (cached). `null` when it cannot be loaded. */
  loadImage: (id: string, thumbnail: boolean) => Promise<string | null>;
  /** Full content of a clip whose list entry is truncated. */
  loadDetail: (id: string) => Promise<ClipItem | null>;
  /** Save as a vault note; resolves to the note path. */
  saveAsNote: (id: string, title: string) => Promise<string>;
}

type Setter = (partial: Partial<ClipboardState> | ((s: ClipboardState) => Partial<ClipboardState>)) => void;

let listSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
const deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const imageRequests = new Map<string, Promise<string | null>>();

const INITIAL = {
  items: [] as ClipItem[],
  hasMore: false,
  loaded: false,
  loading: false,
  loadingMore: false,
  error: null as string | null,
  query: "",
  kind: "all" as ClipKindFilter,
  pinnedOnly: false,
  selectedId: null as string | null,
  stats: null as ClipboardStats | null,
  settings: null as ClipboardSettings | null,
  pendingDeletes: [] as string[],
  images: {} as Record<string, string>,
  details: {} as Record<string, ClipItem>,
  focusSearchToken: 0,
  clearRequested: false,
};

/** Clips that are shown (pending deletes hidden). */
export function visibleClips(state: Pick<ClipboardState, "items" | "pendingDeletes">): ClipItem[] {
  if (state.pendingDeletes.length === 0) return state.items;
  const hidden = new Set(state.pendingDeletes);
  return state.items.filter((item) => !hidden.has(item.id));
}

/** The selected clip, if it is visible. */
export function selectedClip(state: ClipboardState): ClipItem | null {
  if (!state.selectedId) return null;
  return visibleClips(state).find((item) => item.id === state.selectedId) ?? null;
}

/** Keep the selection when possible, otherwise pick the first visible clip. */
function reconcileSelection(state: Pick<ClipboardState, "items" | "pendingDeletes" | "selectedId">): string | null {
  const visible = visibleClips(state);
  if (state.selectedId && visible.some((item) => item.id === state.selectedId)) return state.selectedId;
  return visible[0]?.id ?? null;
}

function matchesFilters(item: ClipItem, state: ClipboardState): boolean {
  if (state.kind !== "all" && item.kind !== state.kind) return false;
  if (state.pinnedOnly && !item.pinned) return false;
  return true;
}

/** Replace an item in place (keeps list-truncated content short). */
function replaceItem(items: ClipItem[], next: ClipItem): ClipItem[] {
  return items.map((item) => (item.id === next.id ? { ...next, content: item.truncated ? item.content : next.content, truncated: item.truncated } : item));
}

/** Evict least-recently-added cache entries beyond `max` with the given suffix. */
function evict(images: Record<string, string>, suffix: string, max: number): Record<string, string> {
  const keys = Object.keys(images).filter((k) => k.endsWith(suffix));
  if (keys.length <= max) return images;
  const next = { ...images };
  for (const key of keys.slice(0, keys.length - max)) delete next[key];
  return next;
}

function dropCaches(set: Setter, id: string) {
  set((s) => {
    const images = { ...s.images };
    delete images[`${id}:thumb`];
    delete images[`${id}:full`];
    const details = { ...s.details };
    delete details[id];
    return { images, details };
  });
}

export const useClipboardStore = create<ClipboardState>((set, get) => {
  const commitDelete = async (id: string) => {
    const timer = deleteTimers.get(id);
    if (timer) clearTimeout(timer);
    deleteTimers.delete(id);
    if (!get().pendingDeletes.includes(id)) return;
    try {
      await deleteClip(id);
      set((s) => {
        const items = s.items.filter((item) => item.id !== id);
        const pendingDeletes = s.pendingDeletes.filter((p) => p !== id);
        return { items, pendingDeletes, selectedId: reconcileSelection({ items, pendingDeletes, selectedId: s.selectedId }) };
      });
      dropCaches(set, id);
    } catch (e) {
      set((s) => ({ pendingDeletes: s.pendingDeletes.filter((p) => p !== id) }));
      toast.error("Could not delete clip", { description: message(e) });
    }
    void get().refreshStats();
  };

  return {
    ...INITIAL,

    setQuery: (query) => {
      set({ query });
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        void get().refresh();
      }, SEARCH_DEBOUNCE_MS);
    },

    setKind: (kind) => {
      if (kind === get().kind) return;
      set({ kind });
      void get().refresh();
    },

    setPinnedOnly: (pinnedOnly) => {
      if (pinnedOnly === get().pinnedOnly) return;
      set({ pinnedOnly });
      void get().refresh();
    },

    select: (selectedId) => set({ selectedId }),

    moveSelection: (delta) => {
      const state = get();
      const visible = visibleClips(state);
      if (visible.length === 0) return;
      const index = visible.findIndex((item) => item.id === state.selectedId);
      const next = index === -1 ? (delta > 0 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, index + delta));
      set({ selectedId: visible[next].id });
      if (next >= visible.length - 5 && state.hasMore) void get().loadMore();
    },

    refresh: async () => {
      const seq = ++listSeq;
      const { query, kind, pinnedOnly, items } = get();
      const limit = Math.min(MAX_PAGE, Math.max(CLIP_PAGE_SIZE, items.length));
      set({ loading: true });
      try {
        const page = await listClips({ query, kind: kind === "all" ? null : kind, pinnedOnly, limit, offset: 0 });
        if (seq !== listSeq) return;
        set((s) => ({
          items: page,
          hasMore: page.length === limit,
          loaded: true,
          loading: false,
          error: null,
          selectedId: reconcileSelection({ items: page, pendingDeletes: s.pendingDeletes, selectedId: s.selectedId }),
        }));
      } catch (e) {
        if (seq !== listSeq) return;
        set({ loading: false, loaded: true, error: message(e) });
      }
    },

    loadMore: async () => {
      const state = get();
      if (!state.hasMore || state.loadingMore || state.loading) return;
      const seq = listSeq;
      set({ loadingMore: true });
      try {
        const page = await listClips({
          query: state.query,
          kind: state.kind === "all" ? null : state.kind,
          pinnedOnly: state.pinnedOnly,
          limit: CLIP_PAGE_SIZE,
          offset: state.items.length,
        });
        if (seq !== listSeq) {
          set({ loadingMore: false });
          return;
        }
        set((s) => {
          const known = new Set(s.items.map((item) => item.id));
          return {
            items: [...s.items, ...page.filter((item) => !known.has(item.id))],
            hasMore: page.length === CLIP_PAGE_SIZE,
            loadingMore: false,
          };
        });
      } catch (e) {
        set({ loadingMore: false });
        toast.error("Could not load more clips", { description: message(e) });
      }
    },

    refreshStats: async () => {
      try {
        set({ stats: await getClipboardStats() });
      } catch {
        // Optional background refresh (status bar): no backend → no stats.
        set({ stats: null });
      }
    },

    loadSettings: async () => {
      try {
        set({ settings: await getClipboardSettings() });
      } catch (e) {
        toast.error("Could not load clipboard settings", { description: message(e) });
      }
    },

    saveSettings: async (settings) => {
      const saved = await setClipboardSettings(settings);
      set({ settings: saved });
      void get().refreshStats();
      void get().refresh();
      return saved;
    },

    copy: async (id) => {
      try {
        const item = await copyClip(id);
        set((s) => {
          const rest = s.items.filter((existing) => existing.id !== id);
          const previous = s.items.find((existing) => existing.id === id);
          const updated = previous?.truncated ? { ...item, content: previous.content, truncated: true } : item;
          return { items: matchesFilters(item, s) ? [updated, ...rest] : rest };
        });
        toast.success("Copied", { description: short(displayPreview(item)) });
        void get().refreshStats();
      } catch (e) {
        toast.error("Could not copy", { description: message(e) });
      }
    },

    copyLatest: async () => {
      const item = await copyLatestClip();
      void get().refreshStats();
      if (get().loaded) void get().refresh();
      return item;
    },

    togglePin: async (id) => {
      const current = get().items.find((item) => item.id === id);
      if (!current) return;
      try {
        const item = await pinClip(id, !current.pinned);
        set((s) => {
          const items = s.pinnedOnly && !item.pinned ? s.items.filter((existing) => existing.id !== id) : replaceItem(s.items, item);
          return { items, selectedId: reconcileSelection({ items, pendingDeletes: s.pendingDeletes, selectedId: s.selectedId }) };
        });
        void get().refreshStats();
      } catch (e) {
        toast.error(current.pinned ? "Could not unpin clip" : "Could not pin clip", { description: message(e) });
      }
    },

    deleteWithUndo: (id) => {
      const state = get();
      if (state.pendingDeletes.includes(id) || !state.items.some((item) => item.id === id)) return;
      const visible = visibleClips(state);
      const index = visible.findIndex((item) => item.id === id);
      const neighbour = visible[index + 1] ?? visible[index - 1] ?? null;
      set((s) => ({
        pendingDeletes: [...s.pendingDeletes, id],
        selectedId: s.selectedId === id ? neighbour?.id ?? null : s.selectedId,
      }));
      deleteTimers.set(
        id,
        setTimeout(() => void commitDelete(id), UNDO_DELETE_MS)
      );
      toast.info("Clip deleted", {
        duration: UNDO_DELETE_MS,
        action: { label: "Undo", onClick: () => get().undoDelete(id) },
      });
    },

    undoDelete: (id) => {
      const timer = deleteTimers.get(id);
      if (timer) clearTimeout(timer);
      deleteTimers.delete(id);
      if (!get().pendingDeletes.includes(id)) return;
      set((s) => ({ pendingDeletes: s.pendingDeletes.filter((p) => p !== id), selectedId: id }));
    },

    flushDeletes: async () => {
      await Promise.all(get().pendingDeletes.map((id) => commitDelete(id)));
    },

    setPaused: async (paused) => {
      try {
        const next = await setClipboardPaused(paused);
        set((s) => ({ stats: s.stats ? { ...s.stats, paused: next } : s.stats }));
        toast.info(next ? "Clipboard capture paused" : "Clipboard capture resumed", {
          description: next ? "New copies are not recorded until you resume." : "New copies are recorded again.",
        });
        void get().refreshStats();
      } catch (e) {
        toast.error(paused ? "Could not pause capture" : "Could not resume capture", { description: message(e) });
      }
    },

    togglePaused: async () => {
      if (!get().stats) await get().refreshStats();
      await get().setPaused(!(get().stats?.paused ?? false));
    },

    clear: async (keepPinned) => {
      for (const id of get().pendingDeletes) {
        const timer = deleteTimers.get(id);
        if (timer) clearTimeout(timer);
        deleteTimers.delete(id);
      }
      set({ pendingDeletes: [] });
      const removed = await clearClipboardHistory(keepPinned);
      set({ images: {}, details: {} });
      await Promise.all([get().refresh(), get().refreshStats()]);
      return removed;
    },

    requestClear: (clearRequested) => set({ clearRequested }),

    requestSearchFocus: () => set((s) => ({ focusSearchToken: s.focusSearchToken + 1 })),

    loadImage: (id, thumbnail) => {
      const key = `${id}:${thumbnail ? "thumb" : "full"}`;
      const cached = get().images[key];
      if (cached) return Promise.resolve(cached);
      const inflight = imageRequests.get(key);
      if (inflight) return inflight;
      const request = getClipImage(id, thumbnail)
        .then((url) => {
          set((s) => ({
            images: evict({ ...s.images, [key]: url }, thumbnail ? ":thumb" : ":full", thumbnail ? MAX_THUMBNAILS : MAX_FULL_IMAGES),
          }));
          return url;
        })
        .catch(() => null)
        .finally(() => imageRequests.delete(key));
      imageRequests.set(key, request);
      return request;
    },

    loadDetail: async (id) => {
      const cached = get().details[id];
      if (cached) return cached;
      try {
        const item = await getClip(id);
        set((s) => {
          const entries = Object.entries({ ...s.details, [id]: item });
          return { details: Object.fromEntries(entries.slice(-MAX_DETAILS)) };
        });
        return item;
      } catch (e) {
        toast.error("Could not load the full clip", { description: message(e) });
        return null;
      }
    },

    saveAsNote: (id, title) => saveClipAsNote(id, title),
  };
});

let unlisten: Promise<UnlistenFn> | null = null;
let eventTimer: ReturnType<typeof setTimeout> | null = null;
let viewAttachments = 0;

/** Subscribe (once, app-wide) to `clipboard-changed`: stats always refresh, the list while a view is attached. */
export function ensureClipboardSync(): void {
  if (unlisten) return;
  unlisten = onClipboardChanged(() => {
    if (eventTimer) clearTimeout(eventTimer);
    eventTimer = setTimeout(() => {
      eventTimer = null;
      const state = useClipboardStore.getState();
      void state.refreshStats();
      if (viewAttachments > 0) void state.refresh();
    }, EVENT_DEBOUNCE_MS);
  });
}

/** Called by the history view on mount: loads everything and keeps the list live. Returns the detach function. */
export function attachClipboardView(): () => void {
  ensureClipboardSync();
  viewAttachments += 1;
  const state = useClipboardStore.getState();
  void state.refresh();
  void state.refreshStats();
  void state.loadSettings();
  return () => {
    viewAttachments = Math.max(0, viewAttachments - 1);
  };
}

/** Test helper: drop timers, the subscription and all state. */
export async function resetClipboardStore(): Promise<void> {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
  if (eventTimer) clearTimeout(eventTimer);
  eventTimer = null;
  for (const timer of deleteTimers.values()) clearTimeout(timer);
  deleteTimers.clear();
  imageRequests.clear();
  viewAttachments = 0;
  listSeq += 1;
  if (unlisten) {
    const pending = unlisten;
    unlisten = null;
    (await pending)();
  }
  useClipboardStore.setState({ ...INITIAL });
}
