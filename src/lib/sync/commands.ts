/**
 * Command palette contributions of Sync & Backup (registered through the
 * `sync` anchor in `src/lib/commands/registry.ts`).
 */
import { Archive, Lock, LockOpen, RefreshCw } from "lucide-react";
import type { CommandContext, CommandContribution } from "../commands/registry";
import { useSyncStore } from "../syncStore";
import { describeReport, errorText } from "./format";
import { pickFolder } from "./pickFolder";

/** Palette section label. */
export const SYNC_GROUP = "Sync & Backup";

/** Run a sync round, or ask for the passphrase / setup first. */
export async function runSyncNow(ctx: Pick<CommandContext, "toast" | "setView">): Promise<void> {
  const store = useSyncStore.getState();
  if (!store.status) await store.refresh().catch(() => undefined);
  const status = useSyncStore.getState().status;
  if (!status?.configured) {
    ctx.setView("sync");
    useSyncStore.getState().openSetup();
    return;
  }
  if (!status.unlocked) {
    useSyncStore.getState().openUnlock();
    return;
  }
  try {
    const report = await useSyncStore.getState().syncNow();
    ctx.toast.success("Sync finished", { description: describeReport(report) });
  } catch (e) {
    ctx.toast.error("Sync failed", { description: errorText(e) });
  }
}

/** Create a backup in the configured (or a picked) folder. */
export async function runBackupNow(ctx: Pick<CommandContext, "toast">): Promise<void> {
  const store = useSyncStore.getState();
  if (!store.settings || !store.status) await store.refresh().catch(() => undefined);
  const { settings, status, backupsDir } = useSyncStore.getState();
  if (!status?.unlocked) {
    useSyncStore.getState().openUnlock();
    ctx.toast.info("Unlock first", { description: "Backups are encrypted with your sync passphrase." });
    return;
  }
  const dir =
    settings?.backup_dir ?? backupsDir ?? (await pickFolder("backup", "Choose a folder for the backup").catch(() => null));
  if (!dir) return;
  try {
    const report = await useSyncStore.getState().createBackup(dir, settings?.backup_include_app_data ?? true);
    ctx.toast.success("Backup created", { description: `${report.file_name} · ${report.files} files` });
  } catch (e) {
    ctx.toast.error("Backup failed", { description: errorText(e) });
  }
}

export const syncCommands: CommandContribution[] = [
  {
    id: "sync.now",
    title: "Sync: sync now",
    group: SYNC_GROUP,
    icon: RefreshCw,
    shortcut: "mod+alt+y",
    keywords: ["sync", "devices", "icloud", "dropbox", "syncthing", "upload", "download"],
    run: (ctx) => runSyncNow(ctx),
  },
  {
    id: "sync.lock",
    title: "Sync: lock",
    group: SYNC_GROUP,
    icon: Lock,
    shortcut: "mod+alt+l",
    keywords: ["forget key", "passphrase", "encryption", "secure"],
    run: async (ctx) => {
      try {
        await useSyncStore.getState().lock();
        ctx.toast.success("Sync locked", { description: "The key was removed from memory." });
      } catch (e) {
        ctx.toast.error("Could not lock sync", { description: errorText(e) });
      }
    },
  },
  {
    id: "sync.unlock",
    title: "Sync: unlock",
    group: SYNC_GROUP,
    icon: LockOpen,
    keywords: ["passphrase", "key", "decrypt"],
    run: () => useSyncStore.getState().openUnlock(),
  },
  {
    id: "backup.create",
    title: "Backup: create now",
    group: SYNC_GROUP,
    icon: Archive,
    shortcut: "mod+alt+shift+b",
    keywords: ["backup", "snapshot", "export", "encrypted", "aetherbak", "archive"],
    run: (ctx) => runBackupNow(ctx),
  },
];
