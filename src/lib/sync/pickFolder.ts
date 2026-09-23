/**
 * Native folder / file pickers for the Sync & Backup UI. In the desktop
 * shell they open the OS dialog; in the browser preview (`dev:mock`) there
 * is no native dialog, so they return the demo folders the mock backend
 * knows about. Elsewhere they resolve to `null` (the user can still type a
 * path into the field next to the button).
 */
import { open } from "@tauri-apps/plugin-dialog";
import { isMockRuntime, isTauriRuntime } from "../ipc/core";

/** What a folder is picked for (selects the preview fallback). */
export type FolderPurpose = "sync" | "backup" | "restore";

/** Folders used by the browser preview (they exist in the mock backend). */
export const PREVIEW_FOLDERS: Record<FolderPurpose, string> = {
  sync: "/Users/demo/Library/Mobile Documents/com~apple~CloudDocs/AETHER Sync",
  backup: "/Users/demo/Backups/AETHER",
  restore: "/Users/demo/Documents/Restored Vault",
};

/** A backup file of the browser preview. */
export const PREVIEW_BACKUP_FILE = "/Users/demo/Backups/AETHER/aether-backup-before-refactor.aetherbak";

/** Let the user choose a folder; `null` when cancelled or unavailable. */
export async function pickFolder(purpose: FolderPurpose, title: string, defaultPath?: string | null): Promise<string | null> {
  if (isTauriRuntime()) {
    const selected = await open({ directory: true, multiple: false, title, defaultPath: defaultPath ?? undefined });
    return typeof selected === "string" ? selected : null;
  }
  if (isMockRuntime()) return PREVIEW_FOLDERS[purpose];
  return null;
}

/** Let the user choose an `.aetherbak` file; `null` when cancelled or unavailable. */
export async function pickBackupFile(defaultPath?: string | null): Promise<string | null> {
  if (isTauriRuntime()) {
    const selected = await open({
      directory: false,
      multiple: false,
      title: "Choose an AETHER backup",
      defaultPath: defaultPath ?? undefined,
      filters: [{ name: "AETHER backup", extensions: ["aetherbak"] }],
    });
    return typeof selected === "string" ? selected : null;
  }
  if (isMockRuntime()) return PREVIEW_BACKUP_FILE;
  return null;
}
