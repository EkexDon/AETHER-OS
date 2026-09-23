/**
 * Frontend state of encrypted backup & folder sync (feature `sync`).
 *
 * Holds the latest status (kept live through the `sync-status` /
 * `sync-progress` events), settings, conflicts, devices and the backups of
 * the folder the user looks at, plus the open state of the global unlock and
 * setup dialogs (rendered once by the status bar item so commands can open
 * them from anywhere).
 */
import { create } from "zustand";
import type {
  BackupInfo,
  BackupReport,
  SyncConflict,
  SyncDeviceInfo,
  SyncKeepChoice,
  SyncProgress,
  SyncReport,
  SyncSettings,
  SyncSettingsPatch,
  SyncStatus,
} from "../types";
import {
  createBackup,
  getSyncSettings,
  getSyncStatus,
  listBackups,
  listSyncConflicts,
  listSyncDevices,
  lockSync,
  onSyncProgress,
  onSyncStatus,
  resolveSyncConflict,
  setSyncSettings,
  syncNow,
  unlockSync,
  type UnlistenFn,
} from "./ipc";

const BACKUPS_DIR_KEY = "aether-sync-backups-dir";

function readBackupsDir(): string | null {
  try {
    return window.localStorage.getItem(BACKUPS_DIR_KEY);
  } catch {
    return null;
  }
}

function writeBackupsDir(dir: string): void {
  try {
    window.localStorage.setItem(BACKUPS_DIR_KEY, dir);
  } catch {
    // Storage unavailable — the folder is still used for this session.
  }
}

/** State + actions of {@link useSyncStore}. */
export interface SyncStoreState {
  status: SyncStatus | null;
  settings: SyncSettings | null;
  conflicts: SyncConflict[];
  devices: SyncDeviceInfo[];
  /** Folder whose backups are listed. */
  backupsDir: string | null;
  backups: BackupInfo[];
  backupsLoading: boolean;
  lastReport: SyncReport | null;
  progress: SyncProgress | null;
  /** Error of the last (foreground) load, if any. */
  loadError: string | null;
  unlockOpen: boolean;
  setupOpen: boolean;
  /** The one-time start-up unlock prompt was shown this session. */
  prompted: boolean;

  /** Merge a status from an event or a command result. */
  applyStatus: (status: SyncStatus) => void;
  /** Reload status and settings (plus conflicts and devices when unlocked). */
  refresh: () => Promise<void>;
  refreshConflicts: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  /** List the backups in `dir` (remembered as the current backups folder). */
  loadBackups: (dir: string) => Promise<void>;
  unlock: (passphrase: string, remember: boolean) => Promise<SyncStatus>;
  lock: () => Promise<void>;
  syncNow: () => Promise<SyncReport>;
  updateSettings: (patch: SyncSettingsPatch) => Promise<SyncSettings>;
  resolveConflict: (id: string, keep: SyncKeepChoice) => Promise<SyncConflict>;
  createBackup: (dir: string, includeAppData: boolean) => Promise<BackupReport>;
  openUnlock: () => void;
  closeUnlock: () => void;
  openSetup: () => void;
  closeSetup: () => void;
  markPrompted: () => void;
}

const initial = () => ({
  status: null,
  settings: null,
  conflicts: [],
  devices: [],
  backupsDir: readBackupsDir(),
  backups: [],
  backupsLoading: false,
  lastReport: null,
  progress: null,
  loadError: null,
  unlockOpen: false,
  setupOpen: false,
  prompted: false,
});

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  ...initial(),

  applyStatus: (status) => {
    const previous = get().status;
    set({ status, progress: status.progress });
    // A round (or resolve) just finished: conflicts and devices may have changed.
    const finished = previous?.state === "syncing" && status.state !== "syncing";
    if (status.unlocked && status.configured && (finished || previous?.conflicts !== status.conflicts)) {
      void get()
        .refreshConflicts()
        .catch(() => undefined);
      if (finished) {
        void get()
          .refreshDevices()
          .catch(() => undefined);
      }
    }
  },

  refresh: async () => {
    try {
      const [status, settings] = await Promise.all([getSyncStatus(), getSyncSettings()]);
      set({ status, settings, progress: status.progress, loadError: null });
      if (!get().backupsDir && settings.backup_dir) set({ backupsDir: settings.backup_dir });
      if (status.unlocked && status.configured) {
        await Promise.all([get().refreshConflicts(), get().refreshDevices()]);
      } else {
        set({ conflicts: [], devices: [] });
      }
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  refreshConflicts: async () => {
    const conflicts = await listSyncConflicts();
    set({ conflicts });
  },

  refreshDevices: async () => {
    const devices = await listSyncDevices();
    set({ devices });
  },

  loadBackups: async (dir) => {
    set({ backupsDir: dir, backupsLoading: true });
    writeBackupsDir(dir);
    try {
      const backups = await listBackups(dir);
      if (get().backupsDir === dir) set({ backups });
    } finally {
      set({ backupsLoading: false });
    }
  },

  unlock: async (passphrase, remember) => {
    const status = await unlockSync(passphrase, remember);
    set({ status, unlockOpen: false, prompted: true });
    const settings = await getSyncSettings();
    set({ settings });
    if (status.configured) {
      await Promise.all([get().refreshConflicts(), get().refreshDevices()]).catch(() => undefined);
    }
    return status;
  },

  lock: async () => {
    const status = await lockSync();
    set({ status, conflicts: [], devices: [] });
  },

  syncNow: async () => {
    const report = await syncNow();
    set({ lastReport: report });
    const status = await getSyncStatus();
    set({ status });
    await Promise.all([get().refreshConflicts(), get().refreshDevices()]).catch(() => undefined);
    return report;
  },

  updateSettings: async (patch) => {
    const settings = await setSyncSettings(patch);
    set({ settings });
    const status = await getSyncStatus();
    set({ status });
    return settings;
  },

  resolveConflict: async (id, keep) => {
    const resolved = await resolveSyncConflict(id, keep);
    set({ conflicts: get().conflicts.map((c) => (c.id === id ? resolved : c)) });
    const status = await getSyncStatus();
    set({ status });
    return resolved;
  },

  createBackup: async (dir, includeAppData) => {
    const report = await createBackup(dir, includeAppData);
    if (get().backupsDir === dir) {
      await get()
        .loadBackups(dir)
        .catch(() => undefined);
    }
    return report;
  },

  openUnlock: () => set({ unlockOpen: true }),
  closeUnlock: () => set({ unlockOpen: false, prompted: true }),
  openSetup: () => set({ setupOpen: true }),
  closeSetup: () => set({ setupOpen: false }),
  markPrompted: () => set({ prompted: true }),
}));

let retainCount = 0;
let generation = 0;
let unlisteners: UnlistenFn[] = [];

/**
 * Keep the store subscribed to backend events while at least one component
 * needs it. Returns the release function (call it on unmount).
 */
export function retainSyncEvents(): () => void {
  retainCount += 1;
  if (retainCount === 1) {
    generation += 1;
    const mine = generation;
    const pending = [
      onSyncStatus((status) => useSyncStore.getState().applyStatus(status)),
      onSyncProgress((progress) => useSyncStore.setState({ progress })),
    ];
    void Promise.all(pending).then((fns) => {
      // Released (or re-subscribed) before the listeners were ready.
      if (mine === generation && retainCount > 0) unlisteners = fns;
      else fns.forEach((fn) => fn());
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainCount -= 1;
    if (retainCount === 0) {
      generation += 1;
      unlisteners.forEach((fn) => fn());
      unlisteners = [];
    }
  };
}

/** Reset to the initial state (tests). */
export function resetSyncStore(): void {
  useSyncStore.setState(initial());
}
