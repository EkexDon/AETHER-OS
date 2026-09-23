/**
 * Vault and health actions shared by the setup wizard and the Settings
 * sections: connect a vault (and refresh everything that depends on it),
 * pick a folder with the native dialog, re-check provider health.
 */
import { open } from "@tauri-apps/plugin-dialog";
import type { SystemHealth } from "../../types";
import {
  getHealth,
  getVaultGraph,
  getVaultNotes,
  getVaultStats,
  isTauriRuntime,
  setVaultPath,
} from "../ipc";
import { useAetherStore } from "../store";

/**
 * Point AETHER-OS at `path` and reload notes, stats, graph and health into
 * the global store. Throws with the backend's message on failure.
 */
export async function connectVault(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("Choose a folder first.");
  await setVaultPath(trimmed);
  const store = useAetherStore.getState();
  store.setVaultPath(trimmed);
  const [notes, stats, graph, health] = await Promise.all([getVaultNotes(), getVaultStats(), getVaultGraph(), getHealth()]);
  store.setVaultNotes(notes);
  store.setVaultStats(stats);
  store.setGraph(graph);
  store.setHealth(health);
}

/** Whether the native folder picker is available (desktop app only). */
export function canPickFolder(): boolean {
  return isTauriRuntime();
}

/** Open the native folder picker; `null` when cancelled or unavailable. */
export async function pickFolder(title = "Choose a vault folder"): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

/** Fetch provider/vault health into the global store and return it. */
export async function refreshHealth(): Promise<SystemHealth> {
  const health = await getHealth();
  useAetherStore.getState().setHealth(health);
  return health;
}

/** Last path segment (`/Users/me/Notes` → `Notes`). */
export function folderName(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
