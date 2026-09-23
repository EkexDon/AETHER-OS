/**
 * Mock backend for encrypted backup & folder sync (`sync_commands.rs`).
 *
 * Simulates this device ("Demo MacBook") syncing with a second device
 * ("Studio iMac") through an iCloud Drive folder, one open conflict on
 * `01-Projects/Local-first Sync.md`, and a folder of backups. Rounds,
 * backups and passphrase changes stream `sync-progress` events and update
 * `sync-status` like the Rust engine.
 *
 * Passphrases: any passphrase with at least 8 characters unlocks the demo
 * store, except ones containing "wrong" (to exercise the error path).
 */
import type {
  BackupInfo,
  BackupPreview,
  BackupReport,
  BackupVerifyReport,
  PassphraseChangeReport,
  RestoreReport,
  SyncConflict,
  SyncConflictDetail,
  SyncDeviceInfo,
  SyncFolderInfo,
  SyncReport,
  SyncSettings,
  SyncStatus,
} from "../../types";
import { MOCK_VAULT_ROOT } from "./fixtures/vault";
import { argBool, argObject, argString, mockEvents, registerReset, sleep, type MockHandlerMap } from "./runtime";
import { mockVault } from "./vaultStore";

/** The demo sync folder (iCloud Drive). */
export const MOCK_SYNC_DIR = "/Users/demo/Library/Mobile Documents/com~apple~CloudDocs/AETHER Sync";
/** The demo backup folder. */
export const MOCK_BACKUP_DIR = "/Users/demo/Backups/AETHER";
/** A demo restore target that counts as a new, empty folder. */
export const MOCK_RESTORE_DIR = "/Users/demo/Documents/Restored Vault";

const THIS_DEVICE = "4f1c2a9e-7b1d-4c55-9a30-1d2e3f4a5b6c";
const OTHER_DEVICE = "a8e3d6f1-2c4b-4e7a-8f90-6b5a4c3d2e1f";
const CONFLICT_PATH = "vault/01-Projects/Local-first Sync.md";
const CONFLICT_COPY = "vault/01-Projects/Local-first Sync (conflict from Demo MacBook 2026-09-22 091544).md";

interface MockConflict {
  record: SyncConflict;
  current: string;
  other: string;
}

interface MockSyncState {
  settings: SyncSettings;
  unlocked: boolean;
  initialized: boolean;
  lastSyncAt: string | null;
  lastBackupAt: string | null;
  lastError: string | null;
  message: string | null;
  busy: SyncStatus["progress"];
  pendingDownloads: number;
  rounds: number;
  conflicts: MockConflict[];
  devices: SyncDeviceInfo[];
  backups: Map<string, BackupInfo[]>;
  folders: Map<string, SyncFolderInfo>;
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function conflictContents(): { current: string; other: string } {
  const live = (() => {
    try {
      return mockVault.read(`${MOCK_VAULT_ROOT}/01-Projects/Local-first Sync.md`);
    } catch {
      return "# Local-first Sync\n\nEncrypted folder sync between devices.\n";
    }
  })();
  const other = live
    .replace(/\n*$/, "\n")
    .concat("\n## Open questions (edited on the train)\n\n- Should conflict copies be merged automatically?\n- Tombstones: 30 days enough?\n");
  const current = live
    .replace(/\n*$/, "\n")
    .concat("\n## Decisions\n\n- Argon2id with 64 MiB, AES-256-GCM per file\n- Keep both versions on conflict, never lose data\n");
  return { current, other };
}

function backup(name: string, msAgo: number, scheduled: boolean, files: number, bytes: number, device = "Demo MacBook"): BackupInfo {
  return {
    path: `${MOCK_BACKUP_DIR}/${name}`,
    file_name: name,
    created_at: iso(msAgo),
    device_name: device,
    files,
    bytes,
    archive_bytes: Math.round(bytes * 1.04) + 4096,
    include_app_data: true,
    scheduled,
    error: null,
  };
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function seed(): MockSyncState {
  const { current, other } = conflictContents();
  const conflict: SyncConflict = {
    id: "9f2c4b6e8a1d3f5c7b9e0a2c4d6f8b1e",
    path: CONFLICT_PATH,
    display_path: "01-Projects/Local-first Sync.md",
    copy_path: CONFLICT_COPY,
    display_copy_path: "01-Projects/Local-first Sync (conflict from Demo MacBook 2026-09-22 091544).md",
    kind: "vault",
    detected_at: iso(40 * MIN),
    detected_by_name: "Studio iMac",
    current: { device_id: OTHER_DEVICE, device_name: "Studio iMac", modified_at: iso(55 * MIN), is_this_device: false },
    other: { device_id: THIS_DEVICE, device_name: "Demo MacBook", modified_at: iso(70 * MIN), is_this_device: true },
    resolved: false,
    resolution: null,
    resolved_at: null,
    resolved_by_name: null,
    copy_exists: true,
  };
  const noteCount = (() => {
    try {
      return mockVault.list().length;
    } catch {
      return 33;
    }
  })();
  return {
    settings: {
      enabled: true,
      sync_dir: MOCK_SYNC_DIR,
      device_id: THIS_DEVICE,
      device_name: "Demo MacBook",
      include_app_data: true,
      interval_seconds: 60,
      remember_key: true,
      backup_dir: MOCK_BACKUP_DIR,
      backup_every_hours: 24,
      backup_keep: 7,
      backup_include_app_data: true,
    },
    unlocked: true,
    initialized: true,
    lastSyncAt: iso(3 * MIN),
    lastBackupAt: iso(9 * HOUR),
    lastError: null,
    message: null,
    busy: null,
    pendingDownloads: 0,
    rounds: 0,
    conflicts: [{ record: conflict, current, other }],
    devices: [
      {
        device_id: THIS_DEVICE,
        device_name: "Demo MacBook",
        platform: "macos",
        app_version: "0.2.0",
        last_seen: iso(3 * MIN),
        file_count: noteCount + 14,
        is_current: true,
      },
      {
        device_id: OTHER_DEVICE,
        device_name: "Studio iMac",
        platform: "macos",
        app_version: "0.2.0",
        last_seen: iso(12 * MIN),
        file_count: noteCount + 13,
        is_current: false,
      },
    ],
    backups: new Map([
      [
        MOCK_BACKUP_DIR,
        [
          backup("aether-backup-scheduled-latest.aetherbak", 9 * HOUR, true, noteCount + 14, 2_480_000),
          backup("aether-backup-before-refactor.aetherbak", 2 * DAY + 3 * HOUR, false, noteCount + 12, 2_310_000),
          backup("aether-backup-scheduled-previous.aetherbak", DAY + 9 * HOUR, true, noteCount + 13, 2_402_000),
          backup("aether-backup-imac.aetherbak", 6 * DAY, false, noteCount + 9, 2_050_000, "Studio iMac"),
        ].sort((a, b) => b.created_at.localeCompare(a.created_at)),
      ],
    ]),
    folders: new Map([
      [
        MOCK_SYNC_DIR,
        { path: MOCK_SYNC_DIR, initialized: true, device_count: 2, created_at: iso(41 * DAY), created_by: "Studio iMac" },
      ],
    ]),
  };
}

let state = seed();
registerReset(() => {
  state = seed();
});

/** Multiplier for the simulated operation delays (tests use 0). */
let delayScale = 1;

/** Speed up (or remove) the simulated Argon2id / round delays. */
export function setSyncMockDelayScale(scale: number): void {
  delayScale = Math.max(0, scale);
}

const wait = (ms: number) => sleep(ms * delayScale);

function unresolvedCount(): number {
  return state.conflicts.filter((c) => !c.record.resolved).length;
}

function status(): SyncStatus {
  const s = state.settings;
  const configured = s.sync_dir !== null;
  const every = s.backup_every_hours * HOUR;
  return {
    state: state.busy
      ? "syncing"
      : s.enabled && configured && !state.unlocked
        ? "locked"
        : s.enabled && state.lastError
          ? "error"
          : "idle",
    enabled: s.enabled,
    configured,
    unlocked: state.unlocked,
    initialized: state.initialized,
    remembered: s.remember_key,
    last_sync_at: state.lastSyncAt,
    pending_uploads: 0,
    pending_downloads: state.pendingDownloads,
    conflicts: unresolvedCount(),
    message: state.lastError ?? state.message,
    device_id: s.device_id,
    device_name: s.device_name,
    last_backup_at: state.lastBackupAt,
    next_backup_at:
      s.backup_every_hours > 0 && s.backup_dir
        ? new Date((state.lastBackupAt ? new Date(state.lastBackupAt).getTime() : Date.now()) + every).toISOString()
        : null,
    progress: state.busy,
  };
}

function emitStatus(): void {
  mockEvents.emit("sync-status", status());
}

function requireUnlocked(): void {
  if (!state.unlocked) throw new Error("invalid input: sync is locked — unlock it with your passphrase first");
}

function requireFolder(): string {
  const dir = state.settings.sync_dir;
  if (!dir) throw new Error("invalid input: choose a sync folder first");
  return dir;
}

function checkPassphrase(passphrase: string, message = "wrong passphrase"): void {
  if (passphrase.length < 8 || /wrong/i.test(passphrase)) throw new Error(`invalid input: ${message}`);
}

function checkDir(path: string, label: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) throw new Error(`invalid input: the ${label} must be an absolute path`);
  if (trimmed === "/" || trimmed === "/Users/demo") throw new Error(`invalid input: the ${label} cannot be a filesystem root`);
  return trimmed.replace(/\/+$/, "");
}

/** Run a fake long operation that streams progress events. */
async function simulate(operation: string, total: number, stepMs = 45): Promise<void> {
  state.busy = { operation, done: 0, total };
  emitStatus();
  for (let done = 1; done <= total; done++) {
    await wait(stepMs);
    state.busy = { operation, done, total };
    mockEvents.emit("sync-progress", { operation, done, total });
  }
  state.busy = null;
}

function previewFiles(): BackupPreview["files"] {
  let notes: { path: string; mtime: number }[] = [];
  try {
    notes = mockVault.list().map((n) => ({ path: n.path, mtime: n.mtime }));
  } catch {
    notes = [];
  }
  const files = notes.map((n) => ({
    path: `vault/${n.path.startsWith(`${MOCK_VAULT_ROOT}/`) ? n.path.slice(MOCK_VAULT_ROOT.length + 1) : n.path}`,
    size: 900 + ((n.path.length * 137) % 5200),
    modified_at: new Date(n.mtime * 1000).toISOString(),
  }));
  for (const app of ["app/memory/facts.json", "app/calendar/events/weekly-review.json", "app/tasks/items/ship-sync.json"]) {
    files.push({ path: app, size: 640, modified_at: iso(2 * DAY) });
  }
  return files;
}

function findBackup(path: string): BackupInfo {
  for (const list of state.backups.values()) {
    const found = list.find((b) => b.path === path);
    if (found) return found;
  }
  throw new Error(`invalid input: backup not found: ${path}`);
}

function findConflict(id: string): MockConflict {
  const found = state.conflicts.find((c) => c.record.id === id);
  if (!found) throw new Error("invalid input: conflict not found");
  return found;
}

/** Handlers for every `cmd_sync_*` command. */
export const syncHandlers: MockHandlerMap = {
  cmd_sync_get_settings: () => state.settings,

  cmd_sync_set_settings: (args) => {
    const patch = argObject<Record<string, unknown>>(args, "patch");
    const next: SyncSettings = { ...state.settings };
    if (typeof patch.sync_dir === "string") {
      next.sync_dir = patch.sync_dir.trim() ? checkDir(patch.sync_dir, "sync folder") : null;
      if (next.sync_dir?.startsWith(MOCK_VAULT_ROOT)) {
        throw new Error("invalid input: the sync folder cannot be inside the vault (it would sync itself)");
      }
    }
    if (typeof patch.backup_dir === "string") {
      next.backup_dir = patch.backup_dir.trim() ? checkDir(patch.backup_dir, "backup folder") : null;
    }
    if (typeof patch.device_name === "string") {
      const name = patch.device_name.trim();
      if (!name || name.length > 64) throw new Error("invalid input: the device name must be 1–64 printable characters");
      next.device_name = name;
    }
    if (typeof patch.include_app_data === "boolean") next.include_app_data = patch.include_app_data;
    if (typeof patch.interval_seconds === "number") {
      if (patch.interval_seconds < 15 || patch.interval_seconds > 86_400) {
        throw new Error("invalid input: the sync interval must be between 15 and 86400 seconds");
      }
      next.interval_seconds = patch.interval_seconds;
    }
    if (typeof patch.backup_every_hours === "number") {
      if (patch.backup_every_hours < 0 || patch.backup_every_hours > 720) {
        throw new Error("invalid input: scheduled backups can run at most every 720 hours");
      }
      next.backup_every_hours = patch.backup_every_hours;
    }
    if (typeof patch.backup_keep === "number") {
      if (patch.backup_keep < 1 || patch.backup_keep > 365) throw new Error("invalid input: keep between 1 and 365 backups");
      next.backup_keep = patch.backup_keep;
    }
    if (typeof patch.backup_include_app_data === "boolean") next.backup_include_app_data = patch.backup_include_app_data;
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (next.enabled && !next.sync_dir) throw new Error("invalid input: choose a sync folder before turning sync on");
    if (next.backup_every_hours > 0 && !next.backup_dir) {
      throw new Error("invalid input: choose a backup folder before scheduling backups");
    }
    const folderChanged = next.sync_dir !== state.settings.sync_dir;
    if (typeof patch.remember_key === "boolean") {
      if (patch.remember_key && !state.unlocked && !folderChanged) {
        throw new Error("invalid input: unlock sync first to remember the key on this device");
      }
      next.remember_key = patch.remember_key && !folderChanged;
    }
    if (folderChanged) {
      state.unlocked = false;
      next.remember_key = false;
      state.lastError = null;
      state.message = next.sync_dir ? "Sync folder changed — unlock with its passphrase to continue." : null;
    }
    state.settings = next;
    emitStatus();
    return next;
  },

  cmd_sync_inspect_folder: (args) => {
    const path = checkDir(argString(args, "path"), "sync folder");
    return state.folders.get(path) ?? { path, initialized: false, device_count: 0, created_at: null, created_by: null };
  },

  cmd_sync_unlock: async (args) => {
    const passphrase = argString(args, "passphrase");
    const remember = argBool(args, "remember");
    const dir = state.settings.sync_dir;
    const folder = dir ? state.folders.get(dir) : undefined;
    if (!folder?.initialized && !state.initialized && passphrase.length < 8) {
      throw new Error("invalid input: the passphrase must be at least 8 characters long");
    }
    await wait(350); // Argon2id takes a moment.
    checkPassphrase(passphrase);
    if (dir && !folder?.initialized) {
      state.folders.set(dir, {
        path: dir,
        initialized: true,
        device_count: 1,
        created_at: new Date().toISOString(),
        created_by: state.settings.device_name,
      });
    }
    state.unlocked = true;
    state.initialized = true;
    state.message = null;
    state.lastError = null;
    state.settings = { ...state.settings, remember_key: remember };
    emitStatus();
    return status();
  },

  cmd_sync_lock: () => {
    state.unlocked = false;
    emitStatus();
    return status();
  },

  cmd_sync_now: async (): Promise<SyncReport> => {
    requireUnlocked();
    requireFolder();
    const started = new Date();
    state.rounds += 1;
    const first = state.rounds === 1;
    await simulate("sync", first ? 6 : 3, 120);
    state.lastSyncAt = new Date().toISOString();
    state.lastError = null;
    state.devices = state.devices.map((d) => (d.is_current ? { ...d, last_seen: state.lastSyncAt } : d));
    emitStatus();
    return {
      started_at: started.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started.getTime(),
      uploaded: first ? 1 : 0,
      downloaded: first ? 2 : 0,
      deleted_local: 0,
      deleted_remote: 0,
      adopted: 0,
      conflicts: 0,
      pending_uploads: 0,
      pending_downloads: 0,
      bytes_up: first ? 3_412 : 0,
      bytes_down: first ? 8_904 : 0,
      devices: state.devices.length,
      files: state.devices[0]?.file_count ?? 0,
      issues: [],
    };
  },

  cmd_sync_status: () => status(),

  cmd_sync_list_conflicts: () => {
    requireUnlocked();
    requireFolder();
    return state.conflicts
      .map((c) => c.record)
      .sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.detected_at.localeCompare(a.detected_at));
  },

  cmd_sync_get_conflict: (args): SyncConflictDetail => {
    requireUnlocked();
    const conflict = findConflict(argString(args, "id"));
    return {
      conflict: conflict.record,
      current_content: conflict.current,
      other_content: conflict.record.copy_exists ? conflict.other : null,
      binary: false,
    };
  },

  cmd_sync_resolve_conflict: (args) => {
    requireUnlocked();
    const conflict = findConflict(argString(args, "id"));
    const keep = argString(args, "keep");
    if (!["local", "remote", "both"].includes(keep)) {
      throw new Error(`invalid input: unknown conflict resolution "${keep}" (expected local, remote or both)`);
    }
    if (conflict.record.resolved) throw new Error("invalid input: this conflict was already resolved");
    if (keep === "remote") {
      if (!conflict.record.copy_exists) throw new Error("invalid input: the conflict copy no longer exists on this device");
      try {
        mockVault.write(`${MOCK_VAULT_ROOT}/${conflict.record.display_path}`, conflict.other);
      } catch {
        // The demo note may have been deleted in the preview; the record still resolves.
      }
      conflict.current = conflict.other;
    }
    conflict.record = {
      ...conflict.record,
      resolved: true,
      resolution: keep as SyncConflict["resolution"],
      resolved_at: new Date().toISOString(),
      resolved_by_name: state.settings.device_name,
      copy_exists: keep === "both",
    };
    emitStatus();
    return conflict.record;
  },

  cmd_sync_change_passphrase: async (args): Promise<PassphraseChangeReport> => {
    const oldPassphrase = argString(args, "oldPassphrase");
    const newPassphrase = argString(args, "newPassphrase");
    if (newPassphrase.length < 8) throw new Error("invalid input: the passphrase must be at least 8 characters long");
    if (oldPassphrase === newPassphrase) {
      throw new Error("invalid input: the new passphrase must be different from the current one");
    }
    await wait(300);
    checkPassphrase(oldPassphrase, "the current passphrase is wrong");
    const synced = state.settings.sync_dir !== null;
    await simulate("passphrase", 24, 50);
    emitStatus();
    return { blobs: synced ? 214 : 0, indexes: synced ? 2 : 0, devices: synced ? 2 : 0, conflicts: synced ? state.conflicts.length : 0, sync_folder: synced, issues: [] };
  },

  cmd_sync_devices: () => {
    if (state.settings.sync_dir && !state.unlocked) throw new Error("invalid input: unlock sync to see the other devices");
    return state.devices;
  },

  cmd_sync_backup_create: async (args): Promise<BackupReport> => {
    const dir = checkDir(argString(args, "destDir"), "backup folder");
    const includeAppData = argBool(args, "includeAppData");
    requireUnlocked();
    const files = previewFiles().filter((f) => includeAppData || f.path.startsWith("vault/"));
    await simulate("backup", 12, 60);
    const now = new Date();
    const name = `aether-backup-${stamp(now)}.aetherbak`;
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    const info: BackupInfo = {
      path: `${dir}/${name}`,
      file_name: name,
      created_at: now.toISOString(),
      device_name: state.settings.device_name,
      files: files.length,
      bytes,
      archive_bytes: Math.round(bytes * 1.04) + 4096,
      include_app_data: includeAppData,
      scheduled: false,
      error: null,
    };
    state.backups.set(dir, [info, ...(state.backups.get(dir) ?? [])]);
    emitStatus();
    return {
      path: info.path,
      file_name: name,
      created_at: info.created_at,
      files: info.files,
      bytes,
      archive_bytes: info.archive_bytes,
      skipped: [],
      pruned: [],
    };
  },

  cmd_sync_backup_list: (args) => {
    const dir = checkDir(argString(args, "dir"), "backup folder");
    return state.backups.get(dir) ?? [];
  },

  cmd_sync_backup_verify: async (args): Promise<BackupVerifyReport> => {
    const path = argString(args, "path");
    const passphrase = argString(args, "passphrase");
    const info = findBackup(path);
    await wait(300);
    checkPassphrase(passphrase, "wrong passphrase for this backup");
    await simulate("verify", 10, 50);
    emitStatus();
    return { path, ok: true, files_checked: info.files, bytes: info.bytes, issues: [] };
  },

  cmd_sync_backup_preview: async (args): Promise<BackupPreview> => {
    const path = argString(args, "path");
    const passphrase = argString(args, "passphrase");
    const info = findBackup(path);
    await wait(300);
    checkPassphrase(passphrase, "wrong passphrase for this backup");
    const files = previewFiles()
      .filter((f) => info.include_app_data || f.path.startsWith("vault/"))
      .slice(0, info.files);
    return {
      path,
      created_at: info.created_at,
      device: info.device_name,
      device_id: info.device_name === "Studio iMac" ? OTHER_DEVICE : THIS_DEVICE,
      include_app_data: info.include_app_data,
      file_count: files.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
      files,
    };
  },

  cmd_sync_backup_restore: async (args): Promise<RestoreReport> => {
    const path = argString(args, "path");
    const passphrase = argString(args, "passphrase");
    const target = checkDir(argString(args, "targetDir"), "restore folder");
    const mode = argString(args, "mode");
    if (mode !== "merge" && mode !== "replace") {
      throw new Error(`invalid input: unknown restore mode "${mode}" (expected merge or replace)`);
    }
    const info = findBackup(path);
    const intoLiveVault = target === MOCK_VAULT_ROOT;
    // The preview treats the demo restore folder as new/empty and every other folder as non-empty.
    if (mode === "replace" && !intoLiveVault && target !== MOCK_RESTORE_DIR) {
      throw new Error("invalid input: replace only works on the current vault or an empty folder — use merge for other folders");
    }
    await wait(300);
    checkPassphrase(passphrase, "wrong passphrase for this backup");
    await simulate("restore", 14, 55);
    emitStatus();
    const vaultFiles = Math.max(0, info.files - 3);
    return {
      target_dir: target,
      mode,
      restored: mode === "replace" || !intoLiveVault ? vaultFiles : 2,
      unchanged: mode === "merge" && intoLiveVault ? vaultFiles - 3 : 0,
      restored_copies: mode === "merge" && intoLiveVault ? 1 : 0,
      app_files_restored: info.include_app_data ? (mode === "replace" ? 3 : 0) : 0,
      app_files_kept: info.include_app_data && mode === "merge" ? 3 : 0,
      moved_existing_to: mode === "replace" && intoLiveVault ? `${target}.pre-restore-${stamp(new Date())}` : null,
      app_data_moved_to: mode === "replace" && info.include_app_data ? "/Users/demo/Library/Application Support/com.ekin.aetheros/sync/pre-restore" : null,
      issues: [],
    };
  },
};
