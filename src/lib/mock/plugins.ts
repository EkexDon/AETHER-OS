/**
 * Mock of the plugin system (`engine/plugins.rs`) for the browser preview.
 *
 * The three bundled example plugins are the real files from
 * `plugins/examples/` (imported as raw text), so their workers genuinely
 * run in the browser. Validation, permission checks and error messages
 * follow the Rust engine. Two things differ on purpose so the preview is
 * lively out of the box:
 *
 * - after `cmd_plugins_install_examples`, Word Count is already enabled
 *   with its permissions granted (a "returning user" state); the others
 *   start disabled exactly like in the desktop app;
 * - the "filesystem" for installs is a set of demo packages under
 *   `/Users/demo/Downloads` (see {@link DEMO_PACKAGES}).
 */
import pkg from "../../../package.json";
import wordCountManifest from "../../../plugins/examples/word-count/manifest.json?raw";
import wordCountMain from "../../../plugins/examples/word-count/main.js?raw";
import dailyReviewManifest from "../../../plugins/examples/daily-review/manifest.json?raw";
import dailyReviewMain from "../../../plugins/examples/daily-review/main.js?raw";
import randomNoteManifest from "../../../plugins/examples/random-note/manifest.json?raw";
import randomNoteMain from "../../../plugins/examples/random-note/main.js?raw";
import type { PluginFetchResponse, PluginInfo, PluginManifest, PluginSettingsValues, PluginVaultNote } from "../../types";
import { defaultSettingValue, settingValueProblem, validateManifest } from "../plugins/manifest";
import { checkFetchUrl } from "../plugins/permissions";
import { sanitizeVaultPath } from "../plugins/paths";
import { mockVault } from "./vaultStore";
import { argBool, argOptString, argString, argStringArray, dirname, registerReset, type MockHandlerMap } from "./runtime";

/** Root of the mock plugins folder. */
export const MOCK_PLUGINS_ROOT = "/Users/demo/Library/Application Support/com.ekin.aetheros/plugins";
const MAX_STORAGE_BYTES = 1024 * 1024;

interface MockPackage {
  manifest: string;
  main: string;
}

const EXAMPLES: MockPackage[] = [
  { manifest: wordCountManifest, main: wordCountMain },
  { manifest: dailyReviewManifest, main: dailyReviewMain },
  { manifest: randomNoteManifest, main: randomNoteMain },
];

const GITHUB_ZEN_MAIN = `/** GitHub Zen — shows a line of GitHub's design philosophy (demo plugin). */
export async function activate(api) {
  const show = async () => {
    const response = await api.net.fetch("https://api.github.com/zen");
    const line = response.ok ? response.body.trim() : "GitHub did not answer.";
    await api.ui.panel.set([
      { type: "heading", text: "GitHub Zen", level: 2 },
      { type: "markdown", content: "> " + line },
      { type: "button", label: "Another one", actionId: "again" },
    ]);
  };
  await api.commands.register({ id: "show", title: "Show GitHub zen", run: show });
  api.events.on("panel:action", (event) => {
    if (event.actionId === "again") void show();
  });
  await show();
}
`;

/** Installable demo packages ("files" the install dialog can point at). */
export const DEMO_PACKAGES: Record<string, MockPackage | { error: string }> = {
  "/Users/demo/Downloads/github-zen": {
    manifest: JSON.stringify({
      id: "com.example.github-zen",
      name: "GitHub Zen",
      version: "0.3.0",
      description: "Fetches a line of GitHub's design philosophy into a panel.",
      author: "Example Inc.",
      main: "main.js",
      permissions: ["net:fetch:api.github.com", "ui:panel", "ui:commands"],
    }),
    main: GITHUB_ZEN_MAIN,
  },
  "/Users/demo/Downloads/github-zen.zip": {
    manifest: JSON.stringify({
      id: "com.example.github-zen",
      name: "GitHub Zen",
      version: "0.3.1",
      description: "Fetches a line of GitHub's design philosophy into a panel.",
      author: "Example Inc.",
      main: "main.js",
      permissions: ["net:fetch:api.github.com", "ui:panel", "ui:commands"],
    }),
    main: GITHUB_ZEN_MAIN,
  },
  "/Users/demo/Downloads/zip-slip.zip": {
    error: 'invalid input: zip entry "../../.zshrc" escapes the plugin folder',
  },
  "/Users/demo/Downloads/broken-plugin": {
    error: "invalid input: invalid plugin manifest: unknown permission \"system:shell\"",
  },
};

const ZEN = [
  "Design for failure.",
  "Keep it logically awesome.",
  "Practicality beats purity.",
  "Mind your words, they are important.",
  "Approachable is better than simple.",
];

interface MockPlugin {
  manifest: PluginManifest;
  main: string;
  enabled: boolean;
  granted: Set<string>;
  bundled: boolean;
  revision: number;
  settings: Record<string, unknown>;
  storage: Record<string, unknown>;
}

interface State {
  plugins: Map<string, MockPlugin>;
  seeded: Set<string>;
  revision: number;
  zen: number;
}

function seed(): State {
  return { plugins: new Map(), seeded: new Set(), revision: 1, zen: 0 };
}

let state = seed();
registerReset(() => {
  state = seed();
});

const invalid = (message: string) => new Error(`invalid input: ${message}`);

function parse(pkgSource: MockPackage): PluginManifest {
  try {
    return validateManifest(pkgSource.manifest, pkg.version);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

function info(plugin: MockPlugin): PluginInfo {
  const id = plugin.manifest.id;
  return {
    manifest: plugin.manifest,
    enabled: plugin.enabled,
    granted_permissions: plugin.manifest.permissions.filter((p) => plugin.granted.has(p)),
    path: `${MOCK_PLUGINS_ROOT}/${id}`,
    error: null,
    fingerprint: `${plugin.manifest.version}:${plugin.revision}`,
    bundled: plugin.bundled,
  };
}

function get(id: string): MockPlugin {
  const plugin = state.plugins.get(id);
  if (!plugin) throw invalid(`plugin "${id}" is not installed`);
  return plugin;
}

function requireEnabled(id: string): MockPlugin {
  const plugin = get(id);
  if (!plugin.enabled) throw invalid(`plugin "${id}" is disabled`);
  return plugin;
}

function requirePermission(id: string, permission: string): MockPlugin {
  const plugin = requireEnabled(id);
  if (!plugin.granted.has(permission) || !plugin.manifest.permissions.includes(permission)) {
    throw invalid(`permission denied: plugin "${id}" has not been granted "${permission}"`);
  }
  return plugin;
}

function install(source: MockPackage, bundled: boolean): MockPlugin {
  const manifest = parse(source);
  const previous = state.plugins.get(manifest.id);
  const plugin: MockPlugin = {
    manifest,
    main: source.main,
    enabled: previous?.enabled ?? false,
    granted: new Set([...(previous?.granted ?? [])].filter((p) => manifest.permissions.includes(p))),
    bundled,
    revision: ++state.revision,
    settings: previous?.settings ?? {},
    storage: previous?.storage ?? {},
  };
  state.plugins.set(manifest.id, plugin);
  return plugin;
}

function effectiveSettings(plugin: MockPlugin): PluginSettingsValues {
  const out: PluginSettingsValues = {};
  for (const spec of plugin.manifest.settings) {
    const stored = plugin.settings[spec.key];
    out[spec.key] = stored !== undefined && settingValueProblem(spec, stored) === null
      ? (stored as PluginSettingsValues[string])
      : defaultSettingValue(spec);
  }
  return out;
}

function sortedList(): PluginInfo[] {
  return [...state.plugins.values()]
    .map(info)
    .sort((a, b) => a.manifest.name.toLowerCase().localeCompare(b.manifest.name.toLowerCase()) || a.manifest.id.localeCompare(b.manifest.id));
}

function vaultRoot(): string {
  const root = mockVault.root;
  if (!root) throw new Error("vault error: no vault path configured");
  return root;
}

function relPath(path: string): string {
  try {
    return sanitizeVaultPath(path);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

/** Same rules as `note_path_from_title` in Rust. */
function notePathFromTitle(title: string): string {
  const parts = title
    .split("/")
    .map((segment) =>
      segment
        .replace(/[\\:*?"<>|\u0000-\u001f\u007f]/g, "-")
        .trim()
        .replace(/^\.+/, "")
        .trim()
    )
    .filter(Boolean);
  if (parts.length === 0) throw invalid("note title is required");
  if (parts.length > 6) throw invalid("note title has too many folder levels");
  const joined = parts.join("/");
  if ([...joined].length > 200) throw invalid("note title is longer than 200 characters");
  return joined;
}

/** Mock handlers for every `cmd_plugins_*` command. */
export const pluginsHandlers: MockHandlerMap = {
  cmd_plugins_list: () => sortedList(),

  cmd_plugins_install_examples: () => {
    const installed: string[] = [];
    for (const example of EXAMPLES) {
      const manifest = parse(example);
      if (state.seeded.has(manifest.id)) continue;
      if (!state.plugins.has(manifest.id)) {
        const plugin = install(example, true);
        if (manifest.id === "aether.word-count") {
          plugin.enabled = true;
          plugin.granted = new Set(manifest.permissions);
        }
        installed.push(manifest.id);
      }
      state.seeded.add(manifest.id);
    }
    return installed;
  },

  cmd_plugins_read_source: (args) => requireEnabled(argString(args, "id")).main,

  cmd_plugins_set_enabled: (args) => {
    const plugin = get(argString(args, "id"));
    plugin.enabled = argBool(args, "enabled");
    return info(plugin);
  },

  cmd_plugins_set_permissions: (args) => {
    const id = argString(args, "id");
    const plugin = get(id);
    const permissions = argStringArray(args, "permissions");
    for (const permission of permissions) {
      if (!plugin.manifest.permissions.includes(permission)) {
        throw invalid(`plugin "${id}" does not request the permission "${permission}"`);
      }
    }
    plugin.granted = new Set(permissions);
    return info(plugin);
  },

  cmd_plugins_install_from_path: (args) => {
    const path = argString(args, "path").trim();
    if (!path.startsWith("/")) throw invalid("the plugin path must be absolute");
    const source = DEMO_PACKAGES[path];
    if (!source) throw invalid(`no such file or folder: ${path}`);
    if ("error" in source) throw new Error(source.error);
    return info(install(source, false));
  },

  cmd_plugins_uninstall: (args) => {
    const id = argString(args, "id");
    get(id);
    state.plugins.delete(id);
  },

  cmd_plugins_get_settings: (args) => effectiveSettings(get(argString(args, "id"))),

  cmd_plugins_set_settings: (args) => {
    const plugin = get(argString(args, "id"));
    const values = args.values;
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      throw invalid("plugin settings must be a JSON object");
    }
    const next = { ...effectiveSettings(plugin) } as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
      const spec = plugin.manifest.settings.find((s) => s.key === key);
      if (!spec) throw invalid(`unknown setting "${key}"`);
      const problem = settingValueProblem(spec, value);
      if (problem) throw invalid(`setting "${spec.label}" ${problem}`);
      next[key] = value;
    }
    plugin.settings = next;
    return effectiveSettings(plugin);
  },

  cmd_plugins_storage_get: (args) => {
    const plugin = requireEnabled(argString(args, "id"));
    const key = argString(args, "key");
    return key in plugin.storage ? plugin.storage[key] : null;
  },

  cmd_plugins_storage_set: (args) => {
    const plugin = requireEnabled(argString(args, "id"));
    const key = argString(args, "key");
    if (!key || key.length > 128) throw invalid("storage keys must be 1–128 printable characters");
    const next = { ...plugin.storage };
    if (args.value === null || args.value === undefined) delete next[key];
    else next[key] = args.value;
    if (new TextEncoder().encode(JSON.stringify(next)).length > MAX_STORAGE_BYTES) {
      throw invalid("plugin storage is limited to 1 MB");
    }
    plugin.storage = next;
  },

  cmd_plugins_open_folder: (args) => {
    const id = argOptString(args, "id");
    if (id) get(id);
    console.info(`[mock] would reveal ${id ? `${MOCK_PLUGINS_ROOT}/${id}` : MOCK_PLUGINS_ROOT} in the file manager`);
  },

  cmd_plugins_vault_list: (args): PluginVaultNote[] => {
    requirePermission(argString(args, "id"), "vault:read");
    const root = vaultRoot();
    return mockVault.list().map((note) => ({ path: note.path.slice(root.length + 1), name: note.name, mtime: note.mtime }));
  },

  cmd_plugins_vault_read: (args) => {
    requirePermission(argString(args, "id"), "vault:read");
    const rel = relPath(argString(args, "path"));
    const abs = `${vaultRoot()}/${rel}`;
    if (!mockVault.hasFile(abs)) throw new Error(`vault error: note not found: ${rel}`);
    return mockVault.read(abs);
  },

  cmd_plugins_vault_write: (args) => {
    requirePermission(argString(args, "id"), "vault:write");
    const rel = relPath(argString(args, "path"));
    const abs = `${vaultRoot()}/${rel}`;
    mockVault.addDir(dirname(abs));
    mockVault.write(abs, argString(args, "content"));
  },

  cmd_plugins_note_create: (args) => {
    requirePermission(argString(args, "id"), "notes:create");
    const abs = mockVault.create(notePathFromTitle(argString(args, "title")), argString(args, "content"));
    return abs.slice(vaultRoot().length + 1);
  },

  cmd_plugins_fetch: (args): PluginFetchResponse => {
    const id = argString(args, "id");
    const plugin = requireEnabled(id);
    const granted = plugin.manifest.permissions.filter((p) => plugin.granted.has(p));
    let url: URL;
    try {
      url = checkFetchUrl(granted, argString(args, "url"));
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
    if (url.hostname === "api.github.com" && url.pathname === "/zen") {
      const body = ZEN[state.zen++ % ZEN.length];
      return { url: url.toString(), status: 200, ok: true, content_type: "text/plain;charset=utf-8", body };
    }
    return {
      url: url.toString(),
      status: 200,
      ok: true,
      content_type: "application/json",
      body: JSON.stringify({ mock: true, url: url.toString() }),
    };
  },
};
