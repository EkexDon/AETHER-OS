/** Vault reader commands (`src-tauri/src/commands/vault_commands.rs`). */
import type { GraphData, VaultIndex, VaultNote, VaultStats } from "../../types";
import { call } from "./core";

/** Configured or auto-detected vault path, `null` when none is found. */
export const getVaultPath = () => call<string | null>("cmd_get_vault_path");
/** Persist a new vault path in the app config. */
export const setVaultPath = (path: string) => call<void>("cmd_set_vault_path", { path });
/** All Markdown notes in the vault, sorted by name. */
export const getVaultNotes = () => call<VaultNote[]>("cmd_get_vault_notes");
/** Raw Markdown content of one note (absolute path). */
export const getNoteContent = (path: string) => call<string>("cmd_get_note_content", { path });
/** The NoPes index (`.nopes/index.json`), `null` when the vault has none. */
export const getVaultIndex = () => call<VaultIndex | null>("cmd_get_vault_index");
/** Wikilink graph of the vault. */
export const getVaultGraph = () => call<GraphData>("cmd_get_vault_graph");
/** Aggregate note/task/tag/link counters. */
export const getVaultStats = () => call<VaultStats>("cmd_get_vault_stats");
