/**
 * State of the Note Tasks feature: the aggregated task list, toolbar
 * filters, optimistic edits with rollback, the quick-add dialog and the
 * "open note at line" hand-off for the editor.
 *
 * Errors are rethrown with a readable message for the caller to toast; a
 * stale line ("note changed, rescan") additionally triggers a silent reload
 * so the next attempt works on fresh data.
 */
import { create } from "zustand";
import type { VaultTaskItem, VaultTaskPriority, VaultTaskStats, VaultTaskStatus } from "../types/vaulttasks";
import {
  appendVaultTask,
  dailyNote,
  getVaultTaskStats,
  listVaultTasks,
  rescanVaultTasks,
  setVaultTaskDue,
  setVaultTaskPriority,
  setVaultTaskStatus,
  toggleVaultTask,
} from "./ipc";
import { useAetherStore } from "./store";
import { todayIso } from "./vaulttasks/dates";
import { isStaleTaskError, withStatus } from "./vaulttasks/edit";
import { DEFAULT_FILTERS, taskKey, type DueFilter, type PriorityFilter, type ViewFilters } from "./vaulttasks/filters";
import { computeStats } from "./vaulttasks/stats";

/** Layout of the Note Tasks view. */
export type VaultTasksMode = "board" | "list" | "notes";

/** A note location the editor should scroll to once it opens the note. */
export interface PendingNoteLine {
  notePath: string;
  /** 0-based line. */
  line: number;
}

const PREFS_KEY = "aether-vaulttasks-prefs";

interface Prefs {
  mode: VaultTasksMode;
  showCompleted: boolean;
}

function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      return {
        mode: parsed.mode === "board" || parsed.mode === "notes" ? parsed.mode : "list",
        showCompleted: parsed.showCompleted === true,
      };
    }
  } catch {
    // storage unavailable or corrupt — defaults below
  }
  return { mode: "list", showCompleted: false };
}

function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable — preference lasts for this session only
  }
}

/** Message used when the backend reports a stale line. */
export const STALE_MESSAGE = "This note changed on disk — tasks were rescanned. Please try again.";

function toError(error: unknown): Error {
  if (isStaleTaskError(error)) return new Error(STALE_MESSAGE);
  return error instanceof Error ? error : new Error(String(error));
}

interface VaultTasksState extends ViewFilters {
  tasks: VaultTaskItem[];
  /** A list was loaded at least once for the current vault. */
  loaded: boolean;
  loading: boolean;
  rescanning: boolean;
  error: string | null;
  /** Counters: computed from `tasks` once loaded, else from the backend. */
  stats: VaultTaskStats | null;
  mode: VaultTasksMode;
  /** Task keys (`taskKey`) with an edit in flight. */
  pending: Record<string, true>;
  collapsedNotes: Record<string, true>;
  pendingLine: PendingNoteLine | null;
  quickAddOpen: boolean;
  quickAddHosts: number;
  /** Incremented to ask the view to focus its inline quick-add field. */
  quickAddFocusToken: number;
  /** Incremented to ask the view to focus its search field. */
  searchFocusToken: number;

  load: (opts?: { silent?: boolean }) => Promise<void>;
  rescan: () => Promise<number>;
  refreshStats: () => Promise<void>;
  setMode: (mode: VaultTasksMode) => void;
  setQuery: (query: string) => void;
  setDueFilter: (due: DueFilter) => void;
  setPriorityFilter: (priority: PriorityFilter) => void;
  setTagFilter: (tag: string | null) => void;
  setShowCompleted: (show: boolean) => void;
  resetFilters: () => void;
  /** Switch to List with a due preset (palette commands). */
  showDuePreset: (due: DueFilter) => void;
  toggleNoteCollapsed: (notePath: string) => void;
  toggle: (task: VaultTaskItem, checked: boolean) => Promise<VaultTaskItem>;
  setStatus: (task: VaultTaskItem, status: VaultTaskStatus) => Promise<VaultTaskItem>;
  setDue: (task: VaultTaskItem, due: string | null) => Promise<VaultTaskItem>;
  setPriority: (task: VaultTaskItem, priority: VaultTaskPriority) => Promise<VaultTaskItem>;
  /** Append `- [ ] text` to today's daily note (created if missing). */
  addToDailyNote: (text: string) => Promise<VaultTaskItem>;
  /** Open the task's note in the editor and remember the line to reveal. */
  openTaskNote: (task: VaultTaskItem) => void;
  /** Open a note by `[[wikilink]]` name; false when no such note exists. */
  openNoteByName: (name: string) => boolean;
  /** The pending line for `notePath` (cleared once read), for the editor. */
  consumePendingLine: (notePath: string) => number | null;
  /** Show the quick-add dialog; false when no dialog host is mounted. */
  openQuickAdd: () => boolean;
  closeQuickAdd: () => void;
  registerQuickAddHost: () => () => void;
  requestQuickAddFocus: () => void;
  requestSearchFocus: () => void;
}

const prefs = loadPrefs();

export const useVaultTasksStore = create<VaultTasksState>((set, get) => {
  const setTasks = (tasks: VaultTaskItem[]) => set({ tasks, stats: computeStats(tasks, todayIso()) });

  const replace = (key: string, next: VaultTaskItem) =>
    setTasks(get().tasks.map((t) => (taskKey(t) === key ? next : t)));

  const markPending = (key: string, on: boolean) =>
    set((s) => {
      const pending = { ...s.pending };
      if (on) pending[key] = true;
      else delete pending[key];
      return { pending };
    });

  /** Optimistically apply `optimistic`, run `request`, roll back on failure. */
  const mutate = async (
    task: VaultTaskItem,
    optimistic: VaultTaskItem | null,
    request: () => Promise<VaultTaskItem>
  ): Promise<VaultTaskItem> => {
    const key = taskKey(task);
    if (get().pending[key]) throw new Error("This task is still being saved.");
    markPending(key, true);
    if (optimistic) replace(key, optimistic);
    try {
      const updated = await request();
      replace(key, updated);
      return updated;
    } catch (error) {
      replace(key, task);
      if (isStaleTaskError(error)) void get().load({ silent: true }).catch(() => undefined);
      throw toError(error);
    } finally {
      markPending(key, false);
    }
  };

  const persist = () => savePrefs({ mode: get().mode, showCompleted: get().showCompleted });

  return {
    ...DEFAULT_FILTERS,
    showCompleted: prefs.showCompleted,
    tasks: [],
    loaded: false,
    loading: false,
    rescanning: false,
    error: null,
    stats: null,
    mode: prefs.mode,
    pending: {},
    collapsedNotes: {},
    pendingLine: null,
    quickAddOpen: false,
    quickAddHosts: 0,
    quickAddFocusToken: 0,
    searchFocusToken: 0,

    load: async ({ silent = false } = {}) => {
      if (!silent) set({ loading: true, error: null });
      try {
        const tasks = await listVaultTasks();
        setTasks(tasks);
        set({ loaded: true, error: null });
      } catch (error) {
        const message = toError(error).message;
        if (!silent) set({ error: message });
        throw new Error(message);
      } finally {
        if (!silent) set({ loading: false });
      }
    },

    rescan: async () => {
      set({ rescanning: true });
      try {
        const tasks = await rescanVaultTasks();
        setTasks(tasks);
        set({ loaded: true, error: null });
        return tasks.length;
      } catch (error) {
        throw toError(error);
      } finally {
        set({ rescanning: false });
      }
    },

    refreshStats: async () => {
      const stats = await getVaultTaskStats();
      if (!get().loaded) set({ stats });
    },

    setMode: (mode) => {
      set({ mode });
      persist();
    },
    setQuery: (query) => set({ query }),
    setDueFilter: (due) => set({ due }),
    setPriorityFilter: (priority) => set({ priority }),
    setTagFilter: (tag) => set({ tag }),
    setShowCompleted: (showCompleted) => {
      set({ showCompleted });
      persist();
    },
    resetFilters: () => set({ query: "", due: "all", priority: "all", tag: null }),
    showDuePreset: (due) => {
      set({ query: "", priority: "all", tag: null, due, mode: "list" });
      persist();
    },
    toggleNoteCollapsed: (notePath) =>
      set((s) => {
        const collapsedNotes = { ...s.collapsedNotes };
        if (collapsedNotes[notePath]) delete collapsedNotes[notePath];
        else collapsedNotes[notePath] = true;
        return { collapsedNotes };
      }),

    toggle: (task, checked) =>
      mutate(task, withStatus(task, checked ? "done" : "todo"), () => toggleVaultTask(task, checked)),
    setStatus: (task, status) => mutate(task, withStatus(task, status), () => setVaultTaskStatus(task, status)),
    setDue: (task, due) => mutate(task, { ...task, due }, () => setVaultTaskDue(task, due)),
    setPriority: (task, priority) => mutate(task, { ...task, priority }, () => setVaultTaskPriority(task, priority)),

    addToDailyNote: async (text) => {
      try {
        const path = await dailyNote();
        const task = await appendVaultTask(path, text);
        // Appending can shift later lines of the note; reload for fresh ids.
        await get()
          .load({ silent: true })
          .catch(() => setTasks([...get().tasks, task]));
        return task;
      } catch (error) {
        throw toError(error);
      }
    },

    openTaskNote: (task) => {
      set({ pendingLine: { notePath: task.note_path, line: task.line } });
      const aether = useAetherStore.getState();
      aether.selectNote(task.note_path);
      aether.setView("editor");
    },

    openNoteByName: (name) => {
      const wanted = name.trim().toLowerCase();
      const note = useAetherStore.getState().vaultNotes.find((n) => n.name.toLowerCase() === wanted);
      if (!note) return false;
      const aether = useAetherStore.getState();
      aether.selectNote(note.path);
      aether.setView("editor");
      return true;
    },

    consumePendingLine: (notePath) => {
      const pending = get().pendingLine;
      if (!pending || pending.notePath !== notePath) return null;
      set({ pendingLine: null });
      return pending.line;
    },

    openQuickAdd: () => {
      if (get().quickAddHosts === 0) return false;
      set({ quickAddOpen: true });
      return true;
    },
    closeQuickAdd: () => set({ quickAddOpen: false }),
    registerQuickAddHost: () => {
      set((s) => ({ quickAddHosts: s.quickAddHosts + 1 }));
      return () => set((s) => ({ quickAddHosts: Math.max(0, s.quickAddHosts - 1) }));
    },
    requestQuickAddFocus: () => set((s) => ({ quickAddFocusToken: s.quickAddFocusToken + 1 })),
    requestSearchFocus: () => set((s) => ({ searchFocusToken: s.searchFocusToken + 1 })),
  };
});
