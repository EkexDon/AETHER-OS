/**
 * State of the plugin system: the installed plugins (from the backend),
 * what their running workers contributed (panels, status bar texts,
 * commands, logs) and the plugin manager's UI state.
 *
 * The store talks to the backend through `ipc`; it never touches workers.
 * `PluginHost` (`src/lib/plugins/host.ts`) subscribes to `plugins` and
 * starts/stops workers to match, and writes the runtime fields below.
 */
import { create } from "zustand";
import type { PluginInfo, PluginSettingsValues } from "../types";
import {
  installExamplePlugins,
  installPluginFromPath,
  listPlugins,
  setPluginEnabled,
  setPluginPermissions,
  setPluginSettings,
  uninstallPlugin,
} from "./ipc";
import type { PluginViewNode } from "./plugins/viewTree";

/** Lifecycle of a plugin's worker. */
export type PluginRuntimeStatus = "stopped" | "starting" | "running" | "error";

/** Runtime state of one plugin. */
export interface PluginRuntimeState {
  status: PluginRuntimeStatus;
  /** Activation/start failure (status `error`). */
  error: string | null;
  startedAt: number | null;
}

/** A diagnostic line reported by a plugin (or about it). */
export interface PluginLogEntry {
  level: "info" | "warn" | "error";
  message: string;
  at: number;
}

/** A command a running plugin registered. */
export interface PluginCommandInfo {
  /** Id inside the plugin (`run`), not the palette id. */
  id: string;
  title: string;
  shortcut: string | null;
}

/** Text a plugin shows in the status bar. */
export interface PluginStatusText {
  text: string;
  tooltip: string | null;
}

const IDLE_RUNTIME: PluginRuntimeState = { status: "stopped", error: null, startedAt: null };

/** Most recent log lines kept per plugin. */
export const MAX_LOG_ENTRIES = 20;

interface PluginsState {
  plugins: PluginInfo[];
  loaded: boolean;
  loading: boolean;
  loadError: string | null;

  runtime: Record<string, PluginRuntimeState>;
  panels: Record<string, PluginViewNode[]>;
  statusItems: Record<string, PluginStatusText>;
  commands: Record<string, PluginCommandInfo[]>;
  logs: Record<string, PluginLogEntry[]>;

  /** Plugin whose panel tab is active. */
  activePanelId: string | null;
  installOpen: boolean;
  /** Permission review dialog target and mode (`enable` also turns the plugin on). */
  review: { id: string; mode: "review" | "enable" } | null;

  /** Seed the bundled examples once, then load the list. Idempotent. */
  init: () => Promise<void>;
  /** Reload the plugin list from the backend. */
  refresh: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<PluginInfo>;
  setPermissions: (id: string, permissions: string[]) => Promise<PluginInfo>;
  /** Grant `permissions` and enable the plugin in one step. */
  grantAndEnable: (id: string, permissions: string[]) => Promise<PluginInfo>;
  install: (path: string) => Promise<PluginInfo>;
  uninstall: (id: string) => Promise<void>;
  saveSettings: (id: string, values: Partial<PluginSettingsValues>) => Promise<PluginSettingsValues>;

  setRuntime: (id: string, patch: Partial<PluginRuntimeState>) => void;
  setPanel: (id: string, tree: PluginViewNode[] | null) => void;
  setStatusItem: (id: string, item: PluginStatusText | null) => void;
  setCommands: (id: string, commands: PluginCommandInfo[]) => void;
  addLog: (id: string, level: PluginLogEntry["level"], message: string) => void;
  /** Drop everything a stopped plugin contributed (keeps logs and runtime status). */
  clearContributions: (id: string) => void;

  setActivePanel: (id: string | null) => void;
  setInstallOpen: (open: boolean) => void;
  openReview: (id: string, mode?: "review" | "enable") => void;
  closeReview: () => void;
}

let initPromise: Promise<void> | null = null;

function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!(id in record)) return record;
  const next = { ...record };
  delete next[id];
  return next;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Plugin system store. */
export const usePluginsStore = create<PluginsState>((set, get) => {
  const upsert = (info: PluginInfo) =>
    set((state) => {
      const index = state.plugins.findIndex((p) => p.manifest.id === info.manifest.id);
      if (index === -1) {
        const plugins = [...state.plugins, info].sort((a, b) =>
          a.manifest.name.toLowerCase().localeCompare(b.manifest.name.toLowerCase())
        );
        return { plugins };
      }
      const plugins = [...state.plugins];
      plugins[index] = info;
      return { plugins };
    });

  return {
    plugins: [],
    loaded: false,
    loading: false,
    loadError: null,
    runtime: {},
    panels: {},
    statusItems: {},
    commands: {},
    logs: {},
    activePanelId: null,
    installOpen: false,
    review: null,

    init: () => {
      initPromise ??= (async () => {
        try {
          await installExamplePlugins();
        } catch (error) {
          console.warn("[plugins] could not install the bundled examples:", error);
        }
        await get().refresh();
      })().catch((error) => {
        initPromise = null;
        throw error;
      });
      return initPromise;
    },

    refresh: async () => {
      set({ loading: true });
      try {
        const plugins = await listPlugins();
        set({ plugins, loaded: true, loading: false, loadError: null });
      } catch (error) {
        set({ loading: false, loaded: true, loadError: message(error) });
        throw error;
      }
    },

    setEnabled: async (id, enabled) => {
      const info = await setPluginEnabled(id, enabled);
      upsert(info);
      return info;
    },

    setPermissions: async (id, permissions) => {
      const info = await setPluginPermissions(id, permissions);
      upsert(info);
      return info;
    },

    grantAndEnable: async (id, permissions) => {
      await setPluginPermissions(id, permissions);
      const info = await setPluginEnabled(id, true);
      upsert(info);
      return info;
    },

    install: async (path) => {
      const info = await installPluginFromPath(path);
      upsert(info);
      return info;
    },

    uninstall: async (id) => {
      await uninstallPlugin(id);
      set((state) => ({
        plugins: state.plugins.filter((p) => p.manifest.id !== id),
        runtime: without(state.runtime, id),
        panels: without(state.panels, id),
        statusItems: without(state.statusItems, id),
        commands: without(state.commands, id),
        logs: without(state.logs, id),
        activePanelId: state.activePanelId === id ? null : state.activePanelId,
      }));
    },

    saveSettings: (id, values) => setPluginSettings(id, values),

    setRuntime: (id, patch) =>
      set((state) => ({
        runtime: {
          ...state.runtime,
          [id]: { ...(state.runtime[id] ?? IDLE_RUNTIME), ...patch },
        },
      })),

    setPanel: (id, tree) =>
      set((state) => {
        if (!tree) {
          return {
            panels: without(state.panels, id),
            activePanelId: state.activePanelId === id ? null : state.activePanelId,
          };
        }
        return { panels: { ...state.panels, [id]: tree } };
      }),

    setStatusItem: (id, item) =>
      set((state) => (item ? { statusItems: { ...state.statusItems, [id]: item } } : { statusItems: without(state.statusItems, id) })),

    setCommands: (id, commands) =>
      set((state) => (commands.length ? { commands: { ...state.commands, [id]: commands } } : { commands: without(state.commands, id) })),

    addLog: (id, level, text) =>
      set((state) => ({
        logs: {
          ...state.logs,
          [id]: [...(state.logs[id] ?? []), { level, message: text, at: Date.now() }].slice(-MAX_LOG_ENTRIES),
        },
      })),

    clearContributions: (id) =>
      set((state) => ({
        panels: without(state.panels, id),
        statusItems: without(state.statusItems, id),
        commands: without(state.commands, id),
        activePanelId: state.activePanelId === id ? null : state.activePanelId,
      })),

    setActivePanel: (activePanelId) => set({ activePanelId }),
    setInstallOpen: (installOpen) => set({ installOpen }),
    openReview: (id, mode = "review") => set({ review: { id, mode } }),
    closeReview: () => set({ review: null }),
  };
});

/** Test helper: forget the one-time `init()` so it can run again. */
export function resetPluginsStoreForTests(): void {
  initPromise = null;
  usePluginsStore.setState({
    plugins: [],
    loaded: false,
    loading: false,
    loadError: null,
    runtime: {},
    panels: {},
    statusItems: {},
    commands: {},
    logs: {},
    activePanelId: null,
    installOpen: false,
    review: null,
  });
}
