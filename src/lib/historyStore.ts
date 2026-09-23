import { create } from "zustand";
import type { HistoryActivity, HistoryRestore, HistoryStatus, NoteVersion } from "../types";
import {
  getVaultNotes,
  historyCommitNow,
  historyRecent,
  historyRestore,
  historySetEnabled,
  historyStatus,
  onHistoryCommit,
} from "./ipc";
import { useAetherStore } from "./store";
import { requestNoteReload } from "./noteEditorBus";

/** Diff presentation in the history view. */
export type DiffLayout = "unified" | "split";
/** What the selected version is compared with. */
export type CompareMode = "previous" | "current";

const LAYOUT_KEY = "aether-history-layout";
const COMPARE_KEY = "aether-history-compare";
/** How many activity entries the timeline loads. */
export const RECENT_LIMIT = 120;
/** Status refresh interval while the app runs (watcher commits also push events). */
export const STATUS_REFRESH_MS = 30_000;
/** How long a restore waits for the editor's pending autosave. */
const SAVE_WAIT_MS = 4_000;

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return allowed.includes(raw as T) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable — the preference still applies for this session
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}


/**
 * Resolve once the editor has no unsaved changes for `path` (its autosave
 * runs ~1 s after typing stops). Rejects after `timeoutMs` so a restore
 * never races the autosave and gets overwritten by it.
 */
export function waitForEditorSave(path: string, timeoutMs = SAVE_WAIT_MS): Promise<void> {
  const dirty = () => {
    const s = useAetherStore.getState();
    return s.noteDirty && s.selectedNotePath === path;
  };
  if (!dirty()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("The note has unsaved changes. Wait for the autosave to finish and try again."));
    }, timeoutMs);
    const unsubscribe = useAetherStore.subscribe(() => {
      if (!dirty()) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Show restored content wherever the note is open. The editor only reads a
 * note from disk when it mounts or the selection changes, so when it is on
 * screen it is remounted by a round trip through the history view.
 */
async function reloadOpenNote(path: string, content: string): Promise<void> {
  const app = useAetherStore.getState();
  if (app.selectedNotePath !== path) return;
  app.setNoteContent(content);
  // The editor re-reads the note from disk when asked; no view flip needed.
  requestNoteReload(path);
}

interface HistoryStoreState {
  status: HistoryStatus | null;
  statusError: string | null;
  recent: HistoryActivity[];
  recentLoaded: boolean;
  recentLoading: boolean;
  recentError: string | null;
  /** Incremented after every commit so open version lists refetch. */
  revision: number;
  /** Note shown in the history view's versions column. */
  selectedPath: string | null;
  /** Version to select once the note's versions are loaded. */
  requestedVersion: string | null;
  /** Note shown in the history drawer; `null` = closed. */
  drawerPath: string | null;
  layout: DiffLayout;
  compare: CompareMode;

  refreshStatus: () => Promise<void>;
  refreshRecent: () => Promise<void>;
  /** Turn automatic versioning on/off. Throws on failure. */
  setEnabled: (enabled: boolean) => Promise<HistoryStatus>;
  /** Snapshot one note (or all pending changes). Throws on failure. */
  snapshotNow: (path?: string | null) => Promise<HistoryActivity | null>;
  /**
   * Restore `path` to `version`: waits for the editor's autosave, writes
   * the old content, refreshes the editor and the vault list. Throws on failure.
   */
  restore: (path: string, version: Pick<NoteVersion, "id">) => Promise<HistoryRestore>;
  /** Pick the note (and optionally a version) shown in the history view. */
  selectNote: (path: string | null, versionId?: string | null) => void;
  /** The versions column consumed `requestedVersion`. */
  clearRequestedVersion: () => void;
  openDrawer: (path: string) => void;
  closeDrawer: () => void;
  setLayout: (layout: DiffLayout) => void;
  setCompare: (compare: CompareMode) => void;
  /** Merge a commit pushed by the backend (`history-commit` event). */
  applyCommit: (activity: HistoryActivity) => void;
}

export const useHistoryStore = create<HistoryStoreState>((set, get) => ({
  status: null,
  statusError: null,
  recent: [],
  recentLoaded: false,
  recentLoading: false,
  recentError: null,
  revision: 0,
  selectedPath: null,
  requestedVersion: null,
  drawerPath: null,
  layout: readPref<DiffLayout>(LAYOUT_KEY, ["unified", "split"], "unified"),
  compare: readPref<CompareMode>(COMPARE_KEY, ["previous", "current"], "previous"),

  refreshStatus: async () => {
    try {
      const status = await historyStatus();
      set({ status, statusError: null });
    } catch (e) {
      set({ statusError: message(e) });
    }
  },

  refreshRecent: async () => {
    set({ recentLoading: true });
    try {
      const recent = await historyRecent(RECENT_LIMIT);
      set({ recent, recentLoaded: true, recentLoading: false, recentError: null });
    } catch (e) {
      set({ recentLoading: false, recentLoaded: true, recentError: message(e) });
    }
  },

  setEnabled: async (enabled) => {
    const status = await historySetEnabled(enabled);
    set((s) => ({ status, statusError: null, revision: s.revision + 1 }));
    void get().refreshRecent();
    return status;
  },

  snapshotNow: async (path) => {
    const activity = await historyCommitNow(path ?? null);
    if (activity) get().applyCommit(activity);
    await get().refreshStatus();
    return activity;
  },

  restore: async (path, version) => {
    await waitForEditorSave(path);
    const result = await historyRestore(path, version.id);
    await reloadOpenNote(path, result.content);
    try {
      useAetherStore.getState().setVaultNotes(await getVaultNotes());
    } catch {
      // The note list refreshes on the next vault scan; the restore itself succeeded.
    }
    set((s) => ({ revision: s.revision + 1 }));
    await Promise.all([get().refreshStatus(), get().refreshRecent()]);
    return result;
  },

  selectNote: (selectedPath, versionId = null) => set({ selectedPath, requestedVersion: versionId }),
  clearRequestedVersion: () => set({ requestedVersion: null }),
  openDrawer: (drawerPath) => set({ drawerPath }),
  closeDrawer: () => set({ drawerPath: null }),
  setLayout: (layout) => {
    writePref(LAYOUT_KEY, layout);
    set({ layout });
  },
  setCompare: (compare) => {
    writePref(COMPARE_KEY, compare);
    set({ compare });
  },

  applyCommit: (activity) => {
    set((s) => {
      const known = s.recent.some((a) => a.commit_id === activity.commit_id);
      const recent = known || !s.recentLoaded ? s.recent : [activity, ...s.recent].slice(0, RECENT_LIMIT);
      // The exact commit count comes from the debounced status refresh below.
      const status = s.status
        ? { ...s.status, last_commit_at: Math.max(activity.time, s.status.last_commit_at ?? 0), last_error: null }
        : s.status;
      return { recent, status, revision: known ? s.revision : s.revision + 1 };
    });
    scheduleStatusRefresh();
  },
}));

let statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Coalesce status refreshes after bursts of commit events. */
function scheduleStatusRefresh(): void {
  if (statusRefreshTimer) clearTimeout(statusRefreshTimer);
  statusRefreshTimer = setTimeout(() => {
    statusRefreshTimer = null;
    void useHistoryStore.getState().refreshStatus();
  }, 250);
}

let syncUsers = 0;
let stopSync: (() => void) | null = null;

/**
 * Keep the history store live: load the status, subscribe to
 * `history-commit` events and refresh the status periodically. Reference
 * counted — every caller must invoke the returned cleanup.
 */
export function initHistorySync(): () => void {
  syncUsers += 1;
  if (syncUsers === 1) {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onHistoryCommit((activity) => useHistoryStore.getState().applyCommit(activity)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    void useHistoryStore.getState().refreshStatus();
    const timer = setInterval(() => void useHistoryStore.getState().refreshStatus(), STATUS_REFRESH_MS);
    stopSync = () => {
      disposed = true;
      clearInterval(timer);
      unlisten?.();
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    syncUsers -= 1;
    if (syncUsers === 0) {
      stopSync?.();
      stopSync = null;
    }
  };
}
