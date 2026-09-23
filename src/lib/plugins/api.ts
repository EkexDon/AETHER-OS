/**
 * The plugin API contract: the `api` object a plugin receives in
 * `activate(api)` (typed below and documented in `docs/PLUGIN-API.md`), the
 * table of RPC methods behind it with the permission each one needs, and
 * the events the host sends.
 *
 * The worker side (`workerRuntime.js`) turns every `api.*` call into an
 * RPC request; the host validates the parameters with the `validate`
 * functions here, checks the permission and only then acts.
 */
import type { PluginSettingsValues, PluginVaultNote } from "../../types";

/** Result of `api.net.fetch(url)` inside the worker. */
export interface PluginFetchResult {
  url: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  body: string;
  text(): string;
  json(): unknown;
}

/** Payloads of the events a plugin can subscribe to with `api.events.on`. */
export interface PluginEventMap {
  /** A vault note was opened in the editor (`vault:read`). */
  "note:opened": { path: string; name: string };
  /** The open note was saved (`vault:read`). */
  "note:saved": { path: string; name: string };
  /** One of the plugin's commands was run (`ui:commands`). */
  "command:invoked": { id: string };
  /** A panel button was clicked (`ui:panel`). */
  "panel:action": { actionId: string };
  /** The user saved the plugin's settings. */
  "settings:changed": { settings: PluginSettingsValues };
}

/** Name of a host → plugin event. */
export type PluginEventName = keyof PluginEventMap;

/** The object passed to a plugin's `activate(api)`. */
export interface AetherPluginApi {
  readonly plugin: { id: string; name: string; version: string; permissions: readonly string[] };
  vault: {
    list(): Promise<PluginVaultNote[]>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
  };
  notes: {
    create(title: string, content?: string): Promise<{ path: string }>;
    current(): Promise<{ path: string; name: string; content: string } | null>;
    open(path: string): Promise<void>;
  };
  commands: {
    register(command: { id: string; title: string; shortcut?: string; run: () => unknown }): Promise<void>;
    unregister(id: string): Promise<void>;
  };
  ui: {
    panel: { set(tree: unknown): Promise<void>; clear(): Promise<void> };
    statusbar: { set(text: string | null, tooltip?: string | null): Promise<void>; clear(): Promise<void> };
    toast(message: string, kind?: "info" | "success" | "error"): Promise<void>;
  };
  ai: { query(prompt: string, options?: { notes?: string[] }): Promise<string> };
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  settings: { get(): Promise<PluginSettingsValues> };
  clipboard: { readText(): Promise<string> };
  net: { fetch(url: string): Promise<PluginFetchResult> };
  events: { on<K extends PluginEventName>(name: K, handler: (payload: PluginEventMap[K]) => void): () => void };
}

/** Permission required to receive each event (`null`: every plugin). */
export const PLUGIN_EVENTS: Record<PluginEventName, string | null> = {
  "note:opened": "vault:read",
  "note:saved": "vault:read",
  "command:invoked": "ui:commands",
  "panel:action": "ui:panel",
  "settings:changed": null,
};

/** Every plugin → host method. */
export type PluginMethod =
  | "vault.list"
  | "vault.read"
  | "vault.write"
  | "notes.create"
  | "notes.current"
  | "notes.open"
  | "commands.register"
  | "commands.unregister"
  | "ui.panel.set"
  | "ui.statusbar.set"
  | "ui.toast"
  | "ai.query"
  | "storage.get"
  | "storage.set"
  | "settings.get"
  | "clipboard.readText"
  | "net.fetch";

/** Special permission marker: any `net:fetch:<host>` grant (the host is checked per URL). */
export const NET_FETCH_ANY = "net:fetch:*";

/** Validation and access rule of one method. */
export interface MethodSpec {
  /** Required permission, {@link NET_FETCH_ANY}, or `null` for every plugin. */
  permission: string | null;
  /** How long the worker waits for the host's answer. */
  timeoutMs: number;
  /** Check and normalise the positional parameters; throws `TypeError`. */
  validate(params: unknown[]): unknown[];
}

/** Command registration payload after validation. */
export interface CommandRegistration {
  id: string;
  title: string;
  shortcut: string | null;
}

/** Toast kinds a plugin may use. */
export type PluginToastKind = "info" | "success" | "error";

function string(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  if (!allowEmpty && !value.trim()) throw new TypeError(`${name} must not be empty`);
  if (value.length > max) throw new TypeError(`${name} is longer than ${max} characters`);
  return value;
}

function optionalString(value: unknown, name: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return string(value, name, max, true);
}

function arity(params: unknown[], max: number, method: string): void {
  if (params.length > max) throw new TypeError(`${method} takes at most ${max} argument${max === 1 ? "" : "s"}`);
}

const NOTE_MAX = 5 * 1024 * 1024;
const PATH_MAX = 1024;
const COMMAND_ID = /^[A-Za-z0-9._-]{1,64}$/;

const none = (method: string) => (params: unknown[]) => {
  arity(params, 0, method);
  return [];
};

/** Method table used by the host (validation + permission) and the bootstrap (timeouts). */
export const PLUGIN_METHODS: Record<PluginMethod, MethodSpec> = {
  "vault.list": { permission: "vault:read", timeoutMs: 10_000, validate: none("vault.list") },
  "vault.read": {
    permission: "vault:read",
    timeoutMs: 10_000,
    validate: (p) => {
      arity(p, 1, "vault.read");
      return [string(p[0], "path", PATH_MAX)];
    },
  },
  "vault.write": {
    permission: "vault:write",
    timeoutMs: 10_000,
    validate: (p) => {
      arity(p, 2, "vault.write");
      return [string(p[0], "path", PATH_MAX), string(p[1], "content", NOTE_MAX, true)];
    },
  },
  "notes.create": {
    permission: "notes:create",
    timeoutMs: 10_000,
    validate: (p) => {
      arity(p, 2, "notes.create");
      return [string(p[0], "title", 200), p[1] === undefined || p[1] === null ? "" : string(p[1], "content", NOTE_MAX, true)];
    },
  },
  "notes.current": { permission: "vault:read", timeoutMs: 10_000, validate: none("notes.current") },
  "notes.open": {
    permission: "vault:read",
    timeoutMs: 10_000,
    validate: (p) => {
      arity(p, 1, "notes.open");
      return [string(p[0], "path", PATH_MAX)];
    },
  },
  "commands.register": {
    permission: "ui:commands",
    timeoutMs: 10_000,
    validate: (p) => {
      arity(p, 1, "commands.register");
      const raw = p[0];
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new TypeError("commands.register expects { id, title, shortcut?, run }");
      }
      const c = raw as Record<string, unknown>;
      const id = string(c.id, "command id", 64);
      if (!COMMAND_ID.test(id)) throw new TypeError("command id may only use letters, digits, '.', '_' and '-'");
      const registration: CommandRegistration = {
        id,
        title: string(c.title, "command title", 80),
        shortcut: optionalString(c.shortcut, "command shortcut", 40),
      };
      return [registration];
    },
  },
  "commands.unregister": {
    permission: "ui:commands",
    timeoutMs: 10_000,
    validate: (p) => {
      arity(p, 1, "commands.unregister");
      return [string(p[0], "command id", 64)];
    },
  },
  "ui.panel.set": {
    permission: "ui:panel",
    timeoutMs: 10_000,
    validate: (p) => {
      arity(p, 1, "ui.panel.set");
      return [p[0] ?? null];
    },
  },
  "ui.statusbar.set": {
    permission: "ui:statusbar",
    timeoutMs: 10_000,
    validate: (p) => {
      arity(p, 2, "ui.statusbar.set");
      return [optionalString(p[0], "status text", 60), optionalString(p[1], "tooltip", 300)];
    },
  },
  "ui.toast": {
    permission: null,
    timeoutMs: 10_000,
    validate: (p) => {
      arity(p, 2, "ui.toast");
      const kind = p[1] ?? "info";
      if (kind !== "info" && kind !== "success" && kind !== "error") {
        throw new TypeError('toast kind must be "info", "success" or "error"');
      }
      return [string(p[0], "message", 300), kind];
    },
  },
  "ai.query": {
    permission: "ai:query",
    timeoutMs: 180_000,
    validate: (p) => {
      arity(p, 2, "ai.query");
      const options = p[1] ?? {};
      if (typeof options !== "object" || options === null || Array.isArray(options)) {
        throw new TypeError("ai.query options must be an object");
      }
      const notes = (options as { notes?: unknown }).notes ?? [];
      if (!Array.isArray(notes) || notes.length > 50) throw new TypeError("options.notes must be an array of at most 50 paths");
      return [string(p[0], "prompt", 20_000), notes.map((n, i) => string(n, `options.notes[${i}]`, PATH_MAX))];
    },
  },
  "storage.get": {
    permission: null,
    timeoutMs: 10_000,
    validate: (p) => {
      arity(p, 1, "storage.get");
      return [string(p[0], "storage key", 128)];
    },
  },
  "storage.set": {
    permission: null,
    timeoutMs: 10_000,
    validate: (p) => {
      arity(p, 2, "storage.set");
      return [string(p[0], "storage key", 128), p[1] ?? null];
    },
  },
  "settings.get": { permission: null, timeoutMs: 10_000, validate: none("settings.get") },
  "clipboard.readText": { permission: "clipboard:read", timeoutMs: 10_000, validate: none("clipboard.readText") },
  "net.fetch": {
    permission: NET_FETCH_ANY,
    timeoutMs: 30_000,
    validate: (p) => {
      arity(p, 1, "net.fetch");
      return [string(p[0], "url", 4096)];
    },
  },
};

/** Is `method` a known plugin → host method? */
export function isPluginMethod(method: string): method is PluginMethod {
  return Object.prototype.hasOwnProperty.call(PLUGIN_METHODS, method);
}

/** Worker-side timeouts per method, embedded into the bootstrap. */
export function methodTimeouts(): Record<string, number> {
  return Object.fromEntries(Object.entries(PLUGIN_METHODS).map(([method, spec]) => [method, spec.timeoutMs]));
}

/** Host → plugin requests and their timeouts. */
export const HOST_REQUEST_TIMEOUTS = {
  activate: 10_000,
  deactivate: 2_000,
  "command.run": 180_000,
} as const;
