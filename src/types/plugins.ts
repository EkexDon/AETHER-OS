/**
 * Plugin system types (`src-tauri/src/engine/plugins.rs`).
 *
 * The manifest keeps the camelCase field names of `manifest.json`; the
 * wrapper structs (`PluginInfo`, …) use the backend's snake_case names.
 */

/** A permission string a manifest may request. */
export type PluginStaticPermission =
  | "vault:read"
  | "vault:write"
  | "notes:create"
  | "ui:commands"
  | "ui:panel"
  | "ui:statusbar"
  | "ai:query"
  | "clipboard:read";

/** Any permission, including the host-scoped `net:fetch:<host>`. */
export type PluginPermission = PluginStaticPermission | `net:fetch:${string}`;

/** Value type of a plugin setting. */
export type PluginSettingType = "string" | "number" | "boolean" | "select";

/** A value of a plugin setting. */
export type PluginSettingValue = string | number | boolean;

/** One entry of a manifest's `settings` array. */
export interface PluginSettingSpec {
  key: string;
  type: PluginSettingType;
  label: string;
  description?: string | null;
  default?: PluginSettingValue | null;
  /** Choices of a `select` setting. */
  options?: { value: string; label: string }[];
  /** Bounds of a `number` setting. */
  min?: number | null;
  max?: number | null;
}

/** `manifest.json` of a plugin. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  main: string;
  minAppVersion: string | null;
  permissions: string[];
  settings: PluginSettingSpec[];
}

/** An installed plugin (`cmd_plugins_list`). */
export interface PluginInfo {
  /** Validated manifest; a placeholder named after the folder when `error` is set. */
  manifest: PluginManifest;
  enabled: boolean;
  /** Subset of `manifest.permissions`, in manifest order. */
  granted_permissions: string[];
  /** Absolute plugin folder. */
  path: string;
  /** Why the package cannot run, if it cannot. */
  error: string | null;
  /** Changes when the code or version changes (the host restarts the plugin). */
  fingerprint: string;
  /** Installed from the examples bundled with AETHER-OS. */
  bundled: boolean;
}

/** Effective settings of a plugin: key → value. */
export type PluginSettingsValues = Record<string, PluginSettingValue>;

/** A vault note as plugins see it (vault-relative path). */
export interface PluginVaultNote {
  path: string;
  name: string;
  mtime: number;
}

/** Response of `cmd_plugins_fetch`. */
export interface PluginFetchResponse {
  /** Final URL after redirects. */
  url: string;
  status: number;
  ok: boolean;
  content_type: string | null;
  body: string;
}
