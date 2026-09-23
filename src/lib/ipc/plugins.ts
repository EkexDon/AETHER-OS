/** Plugin system commands (`src-tauri/src/commands/plugins_commands.rs`). */
import type {
  PluginFetchResponse,
  PluginInfo,
  PluginSettingsValues,
  PluginVaultNote,
} from "../../types";
import { call } from "./core";

// ── Management (plugin manager UI) ──

/** Every installed plugin, valid or broken, sorted by name. */
export const listPlugins = () => call<PluginInfo[]>("cmd_plugins_list");
/** Copy the bundled example plugins into the plugins folder (once). Resolves to the newly installed ids. */
export const installExamplePlugins = () => call<string[]>("cmd_plugins_install_examples");
/** Source of an enabled plugin's entry module. */
export const readPluginSource = (id: string) => call<string>("cmd_plugins_read_source", { id });
/** Enable or disable a plugin. */
export const setPluginEnabled = (id: string, enabled: boolean) =>
  call<PluginInfo>("cmd_plugins_set_enabled", { id, enabled });
/** Replace the granted permissions (must be requested by the manifest). */
export const setPluginPermissions = (id: string, permissions: string[]) =>
  call<PluginInfo>("cmd_plugins_set_permissions", { id, permissions });
/** Install or update a plugin from an absolute folder or `.zip` path. */
export const installPluginFromPath = (path: string) =>
  call<PluginInfo>("cmd_plugins_install_from_path", { path });
/** Remove a plugin with its settings and storage. */
export const uninstallPlugin = (id: string) => call<void>("cmd_plugins_uninstall", { id });
/** Effective settings (stored values over manifest defaults). */
export const getPluginSettings = (id: string) =>
  call<PluginSettingsValues>("cmd_plugins_get_settings", { id });
/** Update some settings; resolves to all settings. */
export const setPluginSettings = (id: string, values: Partial<PluginSettingsValues>) =>
  call<PluginSettingsValues>("cmd_plugins_set_settings", { id, values });
/** Reveal the plugins folder, or one plugin's folder, in the file manager. */
export const openPluginsFolder = (id?: string) => call<void>("cmd_plugins_open_folder", { id: id ?? null });

// ── Capability-checked host operations (called by the plugin host) ──

/** Read one value of a plugin's storage (`null` when missing). */
export const pluginStorageGet = (id: string, key: string) =>
  call<unknown>("cmd_plugins_storage_get", { id, key });
/** Store a value in a plugin's storage; `null` deletes the key. */
export const pluginStorageSet = (id: string, key: string, value: unknown) =>
  call<void>("cmd_plugins_storage_set", { id, key, value: value ?? null });
/** Vault notes with vault-relative paths (`vault:read`). */
export const pluginVaultList = (id: string) => call<PluginVaultNote[]>("cmd_plugins_vault_list", { id });
/** Content of a vault note (`vault:read`). */
export const pluginVaultRead = (id: string, path: string) =>
  call<string>("cmd_plugins_vault_read", { id, path });
/** Create or overwrite a vault note (`vault:write`). */
export const pluginVaultWrite = (id: string, path: string, content: string) =>
  call<void>("cmd_plugins_vault_write", { id, path, content });
/** Create a note without clobbering (`notes:create`); resolves to its vault-relative path. */
export const pluginNoteCreate = (id: string, title: string, content: string) =>
  call<string>("cmd_plugins_note_create", { id, title, content });
/** HTTPS GET limited to hosts granted via `net:fetch:<host>`. */
export const pluginFetch = (id: string, url: string) =>
  call<PluginFetchResponse>("cmd_plugins_fetch", { id, url });
