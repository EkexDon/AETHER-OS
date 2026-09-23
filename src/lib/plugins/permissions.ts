/**
 * Plugin permissions: the vocabulary, human descriptions for the review
 * dialog, and the checks the host runs before every privileged call. The
 * Rust backend (`engine/plugins.rs`) repeats the same checks, so a bug here
 * can never widen what a plugin may do.
 */
import type { PluginStaticPermission } from "../../types";

/** Prefix of the host-scoped network permission. */
export const NET_FETCH_PREFIX = "net:fetch:";

/** Every permission except `net:fetch:<host>`, in display order. */
export const STATIC_PERMISSIONS: readonly PluginStaticPermission[] = [
  "vault:read",
  "vault:write",
  "notes:create",
  "ui:commands",
  "ui:panel",
  "ui:statusbar",
  "ai:query",
  "clipboard:read",
];

/** How much a permission exposes; drives the colour of its chip. */
export type PermissionRisk = "low" | "medium" | "high";

/** Human-readable description of a permission. */
export interface PermissionInfo {
  permission: string;
  label: string;
  description: string;
  risk: PermissionRisk;
}

const DESCRIPTIONS: Record<PluginStaticPermission, Omit<PermissionInfo, "permission">> = {
  "vault:read": {
    label: "Read your notes",
    description: "List every note in the vault, read their content and see which note is open.",
    risk: "medium",
  },
  "vault:write": {
    label: "Change your notes",
    description: "Overwrite existing notes and create notes at any path inside the vault.",
    risk: "high",
  },
  "notes:create": {
    label: "Create notes",
    description: "Add new notes to the vault. Existing notes are never overwritten.",
    risk: "low",
  },
  "ui:commands": {
    label: "Add commands",
    description: "Contribute commands to the command palette, optionally with a keyboard shortcut.",
    risk: "low",
  },
  "ui:panel": {
    label: "Show a panel",
    description: "Render a side panel on the Plugins page (text, lists, buttons and Markdown — no HTML).",
    risk: "low",
  },
  "ui:statusbar": {
    label: "Status bar item",
    description: "Show a short text in the status bar.",
    risk: "low",
  },
  "ai:query": {
    label: "Ask the AI",
    description: "Send prompts to your configured AI model (local Ollama or OpenRouter), with notes as context.",
    risk: "medium",
  },
  "clipboard:read": {
    label: "Read the clipboard",
    description: "Read the text currently on your clipboard.",
    risk: "high",
  },
};

/** Host of a `net:fetch:<host>` permission, or `null` for other permissions. */
export function fetchHost(permission: string): string | null {
  return permission.startsWith(NET_FETCH_PREFIX) ? permission.slice(NET_FETCH_PREFIX.length) : null;
}

/** Label, description and risk of any permission string. */
export function describePermission(permission: string): PermissionInfo {
  const host = fetchHost(permission);
  if (host !== null) {
    return {
      permission,
      label: `Connect to ${host}`,
      description: `Download data from https://${host} (HTTPS only, no other hosts).`,
      risk: "medium",
    };
  }
  const known = DESCRIPTIONS[permission as PluginStaticPermission];
  if (known) return { permission, ...known };
  return { permission, label: permission, description: "Unknown permission.", risk: "high" };
}

/**
 * Why a `net:fetch` host is invalid, or `null` when it is a lowercase fully
 * qualified domain name. IP literals, `localhost` and local-only suffixes
 * are refused (same rules as `validate_fetch_host` in Rust).
 */
export function fetchHostProblem(host: string): string | null {
  if (!host) return "missing host";
  if (host.length > 253) return "host is too long";
  if (host !== host.toLowerCase()) return "host must be lowercase";
  const labels = host.split(".");
  if (labels.length < 2) return "host must be a fully qualified domain name";
  for (const label of labels) {
    if (!label || label.length > 63 || !/^[a-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
      return `"${host}" is not a valid host name`;
    }
  }
  const tld = labels[labels.length - 1];
  if (!/[a-z]/.test(tld)) return "IP addresses are not allowed";
  if (["localhost", "local", "internal", "lan", "home"].includes(tld)) return "local host names are not allowed";
  return null;
}

/** Why a permission string is invalid, or `null` when it is valid. */
export function permissionProblem(permission: string): string | null {
  if ((STATIC_PERMISSIONS as readonly string[]).includes(permission)) return null;
  const host = fetchHost(permission);
  if (host !== null) {
    const problem = fetchHostProblem(host);
    return problem ? `"${permission}": ${problem}` : null;
  }
  return `unknown permission "${permission}"`;
}

/** Is `permission` among the granted ones? */
export function hasPermission(granted: readonly string[], permission: string): boolean {
  return granted.includes(permission);
}

/** Does the plugin hold at least one `net:fetch:<host>` grant? */
export function hasAnyFetchPermission(granted: readonly string[]): boolean {
  return granted.some((p) => p.startsWith(NET_FETCH_PREFIX));
}

/** Error thrown when a plugin calls an API it was not granted. */
export class PluginPermissionError extends Error {
  constructor(
    readonly pluginId: string,
    readonly permission: string
  ) {
    super(`permission denied: plugin "${pluginId}" has not been granted "${permission}"`);
    this.name = "PluginPermissionError";
  }
}

/** Throw {@link PluginPermissionError} unless `permission` is granted. */
export function requirePermission(pluginId: string, granted: readonly string[], permission: string): void {
  if (!hasPermission(granted, permission)) throw new PluginPermissionError(pluginId, permission);
}

/**
 * Validate a URL against `net:fetch:<host>` grants: `https` only, default
 * port, no credentials, exact host match. Returns the parsed URL or throws
 * with the same wording as `check_fetch_url` in Rust.
 */
export function checkFetchUrl(granted: readonly string[], raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`invalid URL "${raw}"`);
  }
  if (url.protocol !== "https:") throw new Error("plugins may only fetch https:// URLs");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  if (url.port) throw new Error("URLs with a custom port are not allowed");
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  const allowed = granted.some((p) => fetchHost(p) === host);
  if (!allowed) throw new Error(`permission denied: "${NET_FETCH_PREFIX}${host}" has not been granted`);
  return url;
}
