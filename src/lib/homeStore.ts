/**
 * Data behind the Home dashboard: today's agenda (kept in the global
 * `calendarEvents`, shared with the Calendar view), due tasks (task board and
 * — if the `vaulttasks` feature exists — note checkboxes), recent AI
 * conversations, focus statistics, the last "Index vault for AI" run
 * (persisted as `aether-home-last-index`) and the pins drawer flag.
 *
 * Every source loads independently: one failing backend call marks only its
 * own block as errored, the rest of Home still renders.
 */
import { create } from "zustand";
import type {
  Conversation,
  FocusStats,
  IndexingResult,
  TaskItem,
  TaskProject,
} from "../types";
import {
  call,
  focusStats,
  getProjectDirs,
  getRecentConversations,
  getVaultNotes,
  getVaultStats,
  indexVault,
  listCalendarEvents,
  listTaskProjects,
  listTasks,
  scanProjects,
  updateTask,
} from "./ipc";
import { useAetherStore } from "./store";
import { toast } from "../ui/Toast";
import { parseNoteTasks, type HomeNoteTask } from "./home/dueTasks";
import { dateKey } from "./home/focusStats";

/** localStorage key of the last successful indexing run. */
export const LAST_INDEX_KEY = "aether-home-last-index";
/** Days of focus history Home shows. */
export const HOME_FOCUS_DAYS = 7;
/** Optional command contributed by the `vaulttasks` feature. */
export const VAULT_TASKS_COMMAND = "cmd_vault_tasks_list";

/** Independently loaded Home data sources. */
export type HomeSource = "events" | "tasks" | "noteTasks" | "conversations" | "focus" | "projects";

/** The last indexing run shown in the Vault block. */
export interface LastIndexRun {
  /** ms since the epoch. */
  at: number;
  result: IndexingResult;
}

function loadLastIndex(): LastIndexRun | null {
  try {
    const raw = window.localStorage.getItem(LAST_INDEX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastIndexRun>;
    const r = parsed.result;
    if (
      typeof parsed.at === "number" &&
      Number.isFinite(parsed.at) &&
      r &&
      typeof r.total === "number" &&
      typeof r.indexed === "number" &&
      typeof r.skipped === "number"
    ) {
      return { at: parsed.at, result: { total: r.total, indexed: r.indexed, skipped: r.skipped } };
    }
  } catch {
    // unreadable entry — treat as never indexed
  }
  return null;
}

function saveLastIndex(run: LastIndexRun): void {
  try {
    window.localStorage.setItem(LAST_INDEX_KEY, JSON.stringify(run));
  } catch {
    // storage unavailable — the time still shows for this session
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface HomeState {
  boardTasks: TaskItem[];
  taskProjects: TaskProject[];
  /** `null` when the `vaulttasks` feature is not available. */
  noteTasks: HomeNoteTask[] | null;
  conversations: Conversation[];
  focusStats: FocusStats | null;
  /** Per-source error message of the last load. */
  errors: Partial<Record<HomeSource, string>>;
  /** Sources currently loading. */
  loading: Partial<Record<HomeSource, boolean>>;
  /** Whether `refresh()` completed at least once. */
  loaded: boolean;
  lastIndex: LastIndexRun | null;
  pinsDrawerOpen: boolean;

  /** Reload every block (optional sources fail silently). */
  refresh: () => Promise<void>;
  refreshEvents: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  refreshNoteTasks: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  refreshFocus: () => Promise<void>;
  /** Scan the configured project folders when the projects list is empty. */
  ensureProjects: () => Promise<void>;
  /** Re-read vault notes and stats into the global store. */
  refreshVault: () => Promise<void>;
  /** "Index vault for AI" with toast feedback; records the run. */
  runIndex: () => Promise<void>;
  /** Mark a board task done (optimistic, rolled back on error). */
  completeBoardTask: (id: string) => Promise<void>;
  setPinsDrawerOpen: (open: boolean) => void;
  togglePinsDrawer: () => void;
}

export const useHomeStore = create<HomeState>((set, get) => {
  const track = async (source: HomeSource, load: () => Promise<void>, silent = false) => {
    set((s) => ({ loading: { ...s.loading, [source]: true } }));
    try {
      await load();
      set((s) => ({ errors: { ...s.errors, [source]: undefined } }));
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [source]: silent ? undefined : message(e) } }));
    } finally {
      set((s) => ({ loading: { ...s.loading, [source]: false } }));
    }
  };

  return {
    boardTasks: [],
    taskProjects: [],
    noteTasks: null,
    conversations: [],
    focusStats: null,
    errors: {},
    loading: {},
    loaded: false,
    lastIndex: loadLastIndex(),
    pinsDrawerOpen: false,

    refresh: async () => {
      const s = get();
      await Promise.all([
        s.refreshEvents(),
        s.refreshTasks(),
        s.refreshNoteTasks(),
        s.refreshConversations(),
        s.refreshFocus(),
        s.ensureProjects(),
      ]);
      set({ loaded: true });
    },

    refreshEvents: () =>
      track("events", async () => {
        // Shared with the Calendar view and the event editor.
        useAetherStore.getState().setCalendarEvents(await listCalendarEvents());
      }),

    refreshTasks: () =>
      track("tasks", async () => {
        const [projects, tasks] = await Promise.all([listTaskProjects(), listTasks(null)]);
        set({ taskProjects: projects, boardTasks: tasks });
        // The task editor modal reads projects from the global store.
        useAetherStore.getState().setTaskProjects(projects);
      }),

    refreshNoteTasks: () =>
      track(
        "noteTasks",
        async () => {
          try {
            // Only what Home shows: due today or earlier (filtered again client-side).
            const raw = await call<unknown>(VAULT_TASKS_COMMAND, { filter: { due_before: dateKey(new Date()) } });
            set({ noteTasks: parseNoteTasks(raw) });
          } catch (e) {
            // Feature not installed (unknown command) or failing: hide the section.
            set({ noteTasks: null });
            throw e;
          }
        },
        true
      ),

    refreshConversations: () =>
      track("conversations", async () => {
        const conversations = await getRecentConversations(12);
        set({ conversations });
      }),

    refreshFocus: () =>
      track("focus", async () => {
        const stats = await focusStats(HOME_FOCUS_DAYS);
        set({ focusStats: stats });
      }),

    ensureProjects: () =>
      track("projects", async () => {
        const aether = useAetherStore.getState();
        if (aether.projects.length > 0) return;
        const dirs = await getProjectDirs();
        if (dirs.length === 0) return;
        const found = await scanProjects(dirs);
        // Another view may have scanned meanwhile; keep the non-empty list.
        if (useAetherStore.getState().projects.length === 0) useAetherStore.getState().setProjects(found);
      }),

    refreshVault: async () => {
      const [notes, stats] = await Promise.all([getVaultNotes(), getVaultStats()]);
      const aether = useAetherStore.getState();
      aether.setVaultNotes(notes);
      aether.setVaultStats(stats);
    },

    runIndex: async () => {
      const aether = useAetherStore.getState();
      if (aether.indexing) return;
      aether.setIndexing(true);
      try {
        const result = await indexVault();
        const run = { at: Date.now(), result };
        saveLastIndex(run);
        set({ lastIndex: run });
        toast.success("Vault indexed", {
          description: `${result.indexed} of ${result.total} notes embedded${result.skipped ? `, ${result.skipped} unchanged` : ""}.`,
        });
      } catch (e) {
        toast.error("Indexing failed", { description: message(e) });
      } finally {
        useAetherStore.getState().setIndexing(false);
      }
    },

    completeBoardTask: async (id) => {
      const before = get().boardTasks;
      const task = before.find((t) => t.id === id);
      if (!task || task.status === "done") return;
      set({ boardTasks: before.map((t) => (t.id === id ? { ...t, status: "done" } : t)) });
      try {
        const updated = await updateTask(id, { status: "done" });
        set((s) => ({ boardTasks: s.boardTasks.map((t) => (t.id === id ? updated : t)) }));
        useAetherStore.getState().upsertTaskItem(updated);
        toast.success("Task completed", { description: updated.title });
      } catch (e) {
        set((s) => ({ boardTasks: s.boardTasks.map((t) => (t.id === id ? task : t)) }));
        toast.error("Could not complete the task", { description: message(e) });
      }
    },

    setPinsDrawerOpen: (pinsDrawerOpen) => set({ pinsDrawerOpen }),
    togglePinsDrawer: () => set((s) => ({ pinsDrawerOpen: !s.pinsDrawerOpen })),
  };
});
