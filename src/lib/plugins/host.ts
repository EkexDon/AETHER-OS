/**
 * The plugin host: runs one Web Worker per enabled plugin and answers its
 * API calls.
 *
 * Security model
 * - A plugin only runs in a worker created from the hardened bootstrap
 *   (`bootstrap.ts`): no DOM, no Tauri IPC, no network or storage APIs.
 * - Everything it can do goes through {@link PluginHost.handleRequest},
 *   in this order and before anything reaches IPC: the call must fit the
 *   plugin's rate limit, the method must exist, the permission must be
 *   granted, the payload must fit its size cap (`limits.ts`), the
 *   parameters are validated (`api.ts`), and privileged work is delegated
 *   to Rust commands that check the permission once more.
 * - Worker failures (uncaught errors, unreadable messages, malformed
 *   protocol traffic) are caught and recorded in that plugin's log, which
 *   its card on the Plugins page shows.
 * - UI contributions are data: panels are validated view trees, commands
 *   are namespaced (`plugin:<id>:<command>`) and cannot take over an
 *   existing shortcut, toasts are rate-limited and name the plugin.
 */
import { Blocks } from "lucide-react";
import type { PluginInfo } from "../../types";
import {
  agentQueryWithNotes,
  getVaultNotes,
  onStreamChunk,
  pluginFetch,
  pluginNoteCreate,
  pluginStorageGet,
  pluginStorageSet,
  pluginVaultList,
  pluginVaultRead,
  pluginVaultWrite,
  readPluginSource,
  getPluginSettings,
  isDesktopRuntime,
} from "../ipc";
import { useAetherStore } from "../store";
import { getCommands, registerCommands } from "../commands/registry";
import { isMacPlatform, parseShortcut } from "../shortcuts";
import { toast } from "../../ui/Toast";
import { usePluginsStore, type PluginCommandInfo } from "../pluginsStore";
import { buildWorkerBootstrap } from "./bootstrap";
import {
  HOST_REQUEST_TIMEOUTS,
  NET_FETCH_ANY,
  PLUGIN_EVENTS,
  PLUGIN_METHODS,
  isPluginMethod,
  type CommandRegistration,
  type PluginEventMap,
  type PluginEventName,
  type PluginToastKind,
} from "./api";
import { checkFetchUrl, hasAnyFetchPermission, PluginPermissionError, requirePermission } from "./permissions";
import { CallRateLimiter, MAX_CALLS_PER_SECOND, MAX_PAYLOAD_SIZE, formatLimit, payloadSize } from "./limits";
import { RpcEndpoint, workerTransport, type RpcLog, type WorkerLike } from "./protocol";
import { joinVaultPath, noteName, sanitizeVaultPath, toVaultRelative } from "./paths";
import { sanitizeViewTree } from "./viewTree";

/** Palette group of plugin commands. */
export const PLUGIN_COMMAND_GROUP = "Plugins";
/** Commands one plugin may register. */
export const MAX_COMMANDS_PER_PLUGIN = 20;
/** Concurrent API calls one plugin may have in flight. */
export const MAX_INFLIGHT_CALLS = 64;
/** Toasts one plugin may show per {@link TOAST_WINDOW_MS}. */
export const MAX_TOASTS_PER_WINDOW = 5;
export const TOAST_WINDOW_MS = 10_000;
/** Minimum gap between two "rate limited" warnings in a plugin's log. */
export const RATE_LIMIT_LOG_GAP_MS = 5_000;

/** How the host creates workers (replaced in tests). */
export interface PluginHostDeps {
  /** Start a module worker running `bootstrap`; returns it plus a cleanup callback. */
  createWorker(bootstrap: string, name: string): { worker: WorkerLike; dispose: () => void };
  /** Rate limiter for one plugin (tests pass a smaller bucket or a fake clock). */
  createRateLimiter?: () => CallRateLimiter;
}

/** Default: a module worker from a blob URL. */
export const browserWorkerDeps: PluginHostDeps = {
  createWorker(bootstrap, name) {
    if (typeof Worker === "undefined") throw new Error("Web Workers are not available in this environment");
    const url = URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }));
    try {
      const worker = new Worker(url, { type: "module", name });
      return { worker, dispose: () => URL.revokeObjectURL(url) };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  },
};

interface RegisteredCommand extends PluginCommandInfo {
  unregister: () => void;
}

interface RunningPlugin {
  info: PluginInfo;
  key: string;
  worker: WorkerLike;
  rpc: RpcEndpoint;
  dispose: () => void;
  commands: Map<string, RegisteredCommand>;
  toastTimes: number[];
  inflight: number;
  active: boolean;
  limiter: CallRateLimiter;
  /** When the last "rate limited" warning was logged (epoch ms). */
  rateLimitLoggedAt: number;
}

/** Start key: a running plugin is restarted when its code, version or grants change. */
export function pluginRunKey(info: PluginInfo): string {
  return `${info.fingerprint}|${[...info.granted_permissions].sort().join(",")}`;
}

/** Canonical form of a shortcut on this platform (`mod` resolved). */
function normalizeShortcut(shortcut: string, mac = isMacPlatform()): string {
  const s = parseShortcut(shortcut);
  const meta = s.meta || (s.mod && mac);
  const ctrl = s.ctrl || (s.mod && !mac);
  return `${meta ? "meta+" : ""}${ctrl ? "ctrl+" : ""}${s.alt ? "alt+" : ""}${s.shift ? "shift+" : ""}${s.key}`;
}

/**
 * Why a plugin may not use `shortcut`, or `null`: it must parse, include a
 * modifier (plain keys belong to whatever has focus) and must not already
 * belong to another command.
 */
export function pluginShortcutProblem(shortcut: string, ownId: string): string | null {
  let parsed;
  try {
    parsed = parseShortcut(shortcut);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!(parsed.mod || parsed.ctrl || parsed.alt || parsed.meta)) {
    return `shortcut "${shortcut}" needs a modifier (mod, ctrl, alt)`;
  }
  const wanted = normalizeShortcut(shortcut);
  const taken = getCommands().find((c) => {
    if (c.id === ownId || !c.shortcut) return false;
    try {
      return normalizeShortcut(c.shortcut) === wanted;
    } catch {
      return false;
    }
  });
  return taken ? `shortcut "${shortcut}" is already used by "${taken.title}"` : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs plugin workers and serves their API calls. Use {@link getPluginHost}. */
export class PluginHost {
  private readonly running = new Map<string, RunningPlugin>();
  /** Run keys whose activation failed; not retried until the key changes. */
  private readonly failed = new Map<string, string>();
  private reconcileQueue: Promise<void> = Promise.resolve();
  private aiQueue: Promise<unknown> = Promise.resolve();
  private startPromise: Promise<void> | null = null;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(private readonly deps: PluginHostDeps = browserWorkerDeps) {}

  /** Ids of plugins with a live worker. */
  get runningIds(): string[] {
    return [...this.running.keys()];
  }

  /**
   * Load the plugin list, start every enabled plugin and keep workers in
   * sync with the store from then on. Safe to call repeatedly.
   */
  start(): Promise<void> {
    this.startPromise ??= (async () => {
      const store = usePluginsStore;
      await store.getState().init();
      this.unsubscribers.push(
        store.subscribe((state, prev) => {
          if (state.plugins !== prev.plugins) void this.reconcile(state.plugins);
        }),
        useAetherStore.subscribe((state, prev) => {
          if (state.selectedNotePath !== prev.selectedNotePath) {
            if (state.selectedNotePath) this.emitNoteEvent("note:opened", state.selectedNotePath);
          } else if (prev.noteDirty && !state.noteDirty && state.selectedNotePath) {
            this.emitNoteEvent("note:saved", state.selectedNotePath);
          }
        })
      );
      await this.reconcile(store.getState().plugins);
    })().catch((error) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  /** Stop every worker and all subscriptions (app teardown, tests). */
  async shutdown(): Promise<void> {
    while (this.unsubscribers.length) this.unsubscribers.pop()!();
    this.startPromise = null;
    await Promise.all(this.runningIds.map((id) => this.stop(id, "AETHER-OS stopped the plugin host")));
  }

  /** Start/stop/restart workers so exactly the enabled, valid plugins run. */
  reconcile(plugins: PluginInfo[]): Promise<void> {
    const next = this.reconcileQueue.then(() => this.doReconcile(plugins));
    this.reconcileQueue = next.catch((error) => console.error("[plugins] reconcile failed", error));
    return next;
  }

  /** Stop and start every enabled plugin again (also retries failed ones). */
  async restartAll(): Promise<void> {
    this.failed.clear();
    await Promise.all(this.runningIds.map((id) => this.stop(id, "Restarting")));
    await this.reconcile(usePluginsStore.getState().plugins);
  }

  /** Restart one plugin (retrying a failed activation). */
  async restart(id: string): Promise<void> {
    this.failed.delete(id);
    await this.stop(id, "Restarting");
    await this.reconcile(usePluginsStore.getState().plugins);
  }

  private async doReconcile(plugins: PluginInfo[]): Promise<void> {
    const wanted = new Map(plugins.filter((p) => p.enabled && !p.error).map((p) => [p.manifest.id, p]));
    for (const [id, plugin] of [...this.running]) {
      const info = wanted.get(id);
      if (!info || pluginRunKey(info) !== plugin.key) await this.stop(id, info ? "Restarting" : "Plugin disabled");
      else plugin.info = info;
    }
    for (const plugin of plugins) {
      const id = plugin.manifest.id;
      if (!wanted.has(id)) {
        this.failed.delete(id);
        const store = usePluginsStore.getState();
        if (store.runtime[id]?.status !== "stopped") store.setRuntime(id, { status: "stopped", error: null, startedAt: null });
      }
    }
    const toStart = [...wanted.values()].filter((info) => {
      const id = info.manifest.id;
      return !this.running.has(id) && this.failed.get(id) !== pluginRunKey(info);
    });
    await Promise.all(toStart.map((info) => this.launch(info)));
  }

  private async launch(info: PluginInfo): Promise<void> {
    const id = info.manifest.id;
    const store = usePluginsStore.getState();
    const key = pluginRunKey(info);
    store.setRuntime(id, { status: "starting", error: null, startedAt: null });

    let source: string;
    try {
      source = await readPluginSource(id);
    } catch (error) {
      this.markFailed(id, key, `Could not load the plugin code: ${errorMessage(error)}`);
      return;
    }

    let created: ReturnType<PluginHostDeps["createWorker"]>;
    try {
      created = this.deps.createWorker(buildWorkerBootstrap({ permissions: info.granted_permissions }), `plugin:${id}`);
    } catch (error) {
      this.markFailed(id, key, `The webview refused to start the plugin worker: ${errorMessage(error)}`);
      return;
    }

    const plugin: RunningPlugin = {
      info,
      key,
      worker: created.worker,
      dispose: created.dispose,
      rpc: null as unknown as RpcEndpoint,
      commands: new Map(),
      toastTimes: [],
      inflight: 0,
      active: false,
      limiter: this.deps.createRateLimiter?.() ?? new CallRateLimiter(),
      rateLimitLoggedAt: 0,
    };
    plugin.rpc = new RpcEndpoint(workerTransport(created.worker), {
      onRequest: (method, params) => this.handleRequest(plugin, method, params),
      onLog: (log) => this.handleLog(plugin, log),
      onInvalid: () => this.logFor(id, "warn", "Ignored a malformed message from the plugin worker"),
    });
    created.worker.addEventListener("error", (event: Event) => {
      const detail = (event as ErrorEvent).message || "the worker script could not be loaded";
      event.preventDefault?.();
      if (this.running.get(id) !== plugin) return;
      if (!plugin.active) {
        void this.stop(id, detail).then(() => this.markFailed(id, key, `Worker error: ${detail}`));
      } else {
        this.logFor(id, "error", `Uncaught error: ${detail}`);
      }
    });
    created.worker.addEventListener("messageerror", () => {
      if (this.running.get(id) !== plugin) return;
      this.logFor(id, "error", "A message from the plugin worker could not be read (it was not plain data)");
    });
    this.running.set(id, plugin);

    try {
      await plugin.rpc.request(
        "activate",
        [
          {
            source,
            plugin: {
              id,
              name: info.manifest.name,
              version: info.manifest.version,
              permissions: info.granted_permissions,
            },
          },
        ],
        HOST_REQUEST_TIMEOUTS.activate
      );
    } catch (error) {
      if (this.running.get(id) === plugin) {
        await this.stop(id, "Activation failed");
        this.markFailed(id, key, `Activation failed: ${errorMessage(error)}`);
      }
      return;
    }
    if (this.running.get(id) !== plugin) return;
    plugin.active = true;
    this.failed.delete(id);
    usePluginsStore.getState().setRuntime(id, { status: "running", error: null, startedAt: Date.now() });
  }

  private markFailed(id: string, key: string, message: string): void {
    this.failed.set(id, key);
    const store = usePluginsStore.getState();
    store.setRuntime(id, { status: "error", error: message, startedAt: null });
    store.addLog(id, "error", message);
  }

  /** Deactivate (briefly) and terminate a plugin's worker; remove its contributions. */
  async stop(id: string, reason = "Plugin stopped"): Promise<void> {
    const plugin = this.running.get(id);
    if (!plugin) return;
    this.running.delete(id);
    if (plugin.active) {
      try {
        await plugin.rpc.request("deactivate", [], HOST_REQUEST_TIMEOUTS.deactivate);
      } catch {
        // A plugin that does not deactivate in time is terminated anyway.
      }
    }
    plugin.rpc.dispose(reason);
    plugin.worker.terminate();
    plugin.dispose();
    for (const command of plugin.commands.values()) command.unregister();
    plugin.commands.clear();
    const store = usePluginsStore.getState();
    store.clearContributions(id);
    if (store.runtime[id]?.status === "running" || store.runtime[id]?.status === "starting") {
      store.setRuntime(id, { status: "stopped", startedAt: null });
    }
  }

  // ── Host → plugin ──

  /** Run a registered plugin command and wait for it to finish. */
  async runCommand(id: string, commandId: string): Promise<void> {
    const plugin = this.running.get(id);
    if (!plugin?.active) throw new Error(`${this.nameOf(id)} is not running`);
    await plugin.rpc.request("command.run", [commandId], HOST_REQUEST_TIMEOUTS["command.run"]);
  }

  /** Forward a panel button click. */
  sendPanelAction(id: string, actionId: string): void {
    this.send(id, "panel:action", { actionId });
  }

  /** Tell a plugin its settings changed. */
  notifySettingsChanged(id: string, settings: PluginEventMap["settings:changed"]["settings"]): void {
    this.send(id, "settings:changed", { settings });
  }

  private send<K extends PluginEventName>(id: string, name: K, payload: PluginEventMap[K]): void {
    const plugin = this.running.get(id);
    if (!plugin?.active) return;
    const required = PLUGIN_EVENTS[name];
    if (required && !plugin.info.granted_permissions.includes(required)) return;
    plugin.rpc.notify(name, payload);
  }

  private emitNoteEvent(name: "note:opened" | "note:saved", absolutePath: string): void {
    const rel = toVaultRelative(absolutePath, useAetherStore.getState().vaultPath);
    if (!rel) return;
    for (const id of this.running.keys()) this.send(id, name, { path: rel, name: noteName(rel) });
  }

  // ── Plugin → host ──

  /**
   * Rate-limit, permission-check, size-check, validate and execute one API
   * call from a plugin. Every check runs before any IPC call is made.
   */
  private async handleRequest(plugin: RunningPlugin, method: string, params: unknown[]): Promise<unknown> {
    const id = plugin.info.manifest.id;
    if (!plugin.limiter.tryTake()) {
      const now = Date.now();
      if (now - plugin.rateLimitLoggedAt >= RATE_LIMIT_LOG_GAP_MS) {
        plugin.rateLimitLoggedAt = now;
        this.logFor(id, "warn", `Rate limited: more than ${MAX_CALLS_PER_SECOND} API calls per second`);
      }
      throw new Error(
        `Too many API calls — at most ${MAX_CALLS_PER_SECOND} per second; retry in ${plugin.limiter.retryAfterMs()} ms`
      );
    }
    if (!isPluginMethod(method)) throw new Error(`Unknown API method "${method}"`);
    const spec = PLUGIN_METHODS[method];
    const granted = plugin.info.granted_permissions;
    if (spec.permission === NET_FETCH_ANY) {
      if (!hasAnyFetchPermission(granted)) throw new PluginPermissionError(id, "net:fetch:<host>");
    } else if (spec.permission) {
      requirePermission(id, granted, spec.permission);
    }
    const maxPayload = spec.maxPayload ?? MAX_PAYLOAD_SIZE;
    if (payloadSize(params, maxPayload) > maxPayload) {
      throw new Error(`${method}: the payload is larger than ${formatLimit(maxPayload)}`);
    }
    const args = spec.validate(params);
    if (plugin.inflight >= MAX_INFLIGHT_CALLS) throw new Error("Too many API calls in flight — wait for earlier calls to finish");
    plugin.inflight += 1;
    try {
      return await this.dispatch(plugin, method, args);
    } finally {
      plugin.inflight -= 1;
    }
  }

  private async dispatch(plugin: RunningPlugin, method: string, args: unknown[]): Promise<unknown> {
    const id = plugin.info.manifest.id;
    switch (method) {
      case "vault.list":
        return pluginVaultList(id);
      case "vault.read":
        return pluginVaultRead(id, sanitizeVaultPath(args[0] as string));
      case "vault.write": {
        const rel = sanitizeVaultPath(args[0] as string);
        await pluginVaultWrite(id, rel, args[1] as string);
        await this.afterVaultChange(rel);
        return null;
      }
      case "notes.create": {
        const path = await pluginNoteCreate(id, args[0] as string, args[1] as string);
        await this.afterVaultChange(null);
        return { path };
      }
      case "notes.current":
        return this.currentNote(id);
      case "notes.open":
        await this.openNote(sanitizeVaultPath(args[0] as string));
        return null;
      case "commands.register":
        this.registerCommand(plugin, args[0] as CommandRegistration);
        return null;
      case "commands.unregister":
        this.unregisterCommand(plugin, args[0] as string);
        return null;
      case "ui.panel.set": {
        const tree = sanitizeViewTree(args[0]);
        usePluginsStore.getState().setPanel(id, tree.length ? tree : null);
        return null;
      }
      case "ui.statusbar.set": {
        const [text, tooltip] = args as [string | null, string | null];
        usePluginsStore.getState().setStatusItem(id, text && text.trim() ? { text: text.trim(), tooltip } : null);
        return null;
      }
      case "ui.toast":
        this.showToast(plugin, args[0] as string, args[1] as PluginToastKind);
        return null;
      case "ai.query":
        return this.aiQuery(plugin, args[0] as string, args[1] as string[]);
      case "storage.get":
        return pluginStorageGet(id, args[0] as string);
      case "storage.set":
        await pluginStorageSet(id, args[0] as string, args[1]);
        return null;
      case "settings.get":
        return getPluginSettings(id);
      case "clipboard.readText": {
        const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
        if (!clipboard?.readText) throw new Error("Clipboard access is not available here");
        return clipboard.readText();
      }
      case "net.fetch": {
        const url = checkFetchUrl(plugin.info.granted_permissions, args[0] as string);
        const response = await pluginFetch(id, url.toString());
        return {
          url: response.url,
          status: response.status,
          ok: response.ok,
          contentType: response.content_type,
          body: response.body,
        };
      }
      default:
        throw new Error(`Unknown API method "${method}"`);
    }
  }

  private handleLog(plugin: RunningPlugin, log: RpcLog): void {
    this.logFor(plugin.info.manifest.id, log.level, log.message);
  }

  private logFor(id: string, level: RpcLog["level"], message: string): void {
    usePluginsStore.getState().addLog(id, level, message);
    const line = `[plugin ${id}] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  }

  private nameOf(id: string): string {
    return (
      this.running.get(id)?.info.manifest.name ??
      usePluginsStore.getState().plugins.find((p) => p.manifest.id === id)?.manifest.name ??
      id
    );
  }

  private registerCommand(plugin: RunningPlugin, registration: CommandRegistration): void {
    const pluginId = plugin.info.manifest.id;
    const existing = plugin.commands.get(registration.id);
    if (!existing && plugin.commands.size >= MAX_COMMANDS_PER_PLUGIN) {
      throw new Error(`A plugin may register at most ${MAX_COMMANDS_PER_PLUGIN} commands`);
    }
    const paletteId = `plugin:${pluginId}:${registration.id}`;
    let shortcut = registration.shortcut;
    if (shortcut) {
      const problem = pluginShortcutProblem(shortcut, paletteId);
      if (problem) {
        this.logFor(pluginId, "warn", `Command "${registration.title}" registered without a shortcut: ${problem}`);
        shortcut = null;
      }
    }
    existing?.unregister();
    const unregister = registerCommands([
      {
        id: paletteId,
        title: registration.title,
        group: PLUGIN_COMMAND_GROUP,
        icon: Blocks,
        shortcut: shortcut ?? undefined,
        keywords: [plugin.info.manifest.name, "plugin"],
        run: () => this.runCommand(pluginId, registration.id),
      },
    ]);
    plugin.commands.set(registration.id, { id: registration.id, title: registration.title, shortcut, unregister });
    this.publishCommands(plugin);
  }

  private unregisterCommand(plugin: RunningPlugin, commandId: string): void {
    const command = plugin.commands.get(commandId);
    if (!command) return;
    command.unregister();
    plugin.commands.delete(commandId);
    this.publishCommands(plugin);
  }

  private publishCommands(plugin: RunningPlugin): void {
    usePluginsStore.getState().setCommands(
      plugin.info.manifest.id,
      [...plugin.commands.values()].map(({ id, title, shortcut }) => ({ id, title, shortcut }))
    );
  }

  private showToast(plugin: RunningPlugin, message: string, kind: PluginToastKind): void {
    const now = Date.now();
    plugin.toastTimes = plugin.toastTimes.filter((t) => now - t < TOAST_WINDOW_MS);
    if (plugin.toastTimes.length >= MAX_TOASTS_PER_WINDOW) {
      throw new Error(`Too many notifications — at most ${MAX_TOASTS_PER_WINDOW} per ${TOAST_WINDOW_MS / 1000} s`);
    }
    plugin.toastTimes.push(now);
    toast[kind](message, { description: `From the ${plugin.info.manifest.name} plugin` });
  }

  private async currentNote(id: string): Promise<{ path: string; name: string; content: string } | null> {
    const { selectedNotePath, vaultPath, noteContent, noteDirty } = useAetherStore.getState();
    if (!selectedNotePath) return null;
    const rel = toVaultRelative(selectedNotePath, vaultPath);
    if (!rel || !/\.md$/i.test(rel)) return null;
    // Unsaved edits live only in the editor; otherwise the file on disk is authoritative.
    const content = noteDirty && noteContent !== null ? noteContent : await pluginVaultRead(id, rel);
    return { path: rel, name: noteName(rel), content };
  }

  private async openNote(rel: string): Promise<void> {
    const aether = useAetherStore.getState();
    if (!aether.vaultPath) throw new Error("No vault is connected");
    const absolute = joinVaultPath(aether.vaultPath, rel);
    let notes = aether.vaultNotes;
    if (!notes.some((n) => n.path === absolute)) {
      notes = await getVaultNotes();
      useAetherStore.getState().setVaultNotes(notes);
    }
    if (!notes.some((n) => n.path === absolute)) throw new Error(`note not found: ${rel}`);
    const store = useAetherStore.getState();
    store.selectNote(absolute);
    store.setView("editor");
  }

  /** Refresh the vault list and reload the open note if a plugin rewrote it. */
  private async afterVaultChange(rel: string | null): Promise<void> {
    try {
      useAetherStore.getState().setVaultNotes(await getVaultNotes());
    } catch (error) {
      console.warn("[plugins] could not refresh the note list", error);
    }
    if (!rel) return;
    const { selectedNotePath, vaultPath, noteDirty, selectNote } = useAetherStore.getState();
    if (!selectedNotePath || toVaultRelative(selectedNotePath, vaultPath) !== rel) return;
    if (noteDirty) {
      toast.info("A plugin changed the open note", {
        description: "Your unsaved edits are kept; saving will overwrite the plugin's change.",
      });
      return;
    }
    // Re-selecting makes the editor load the new content from disk.
    selectNote(null);
    setTimeout(() => {
      if (useAetherStore.getState().selectedNotePath === null) useAetherStore.getState().selectNote(selectedNotePath);
    }, 0);
  }

  /**
   * `api.ai.query`: runs through the agent's streaming channel, one query
   * at a time, and only while the agent panel is idle (both share the
   * `llm-stream-chunk` stream).
   */
  private aiQuery(plugin: RunningPlugin, prompt: string, notes: string[]): Promise<string> {
    const id = plugin.info.manifest.id;
    if (notes.length > 0) requirePermission(id, plugin.info.granted_permissions, "vault:read");
    const run = async (): Promise<string> => {
      const aether = useAetherStore.getState();
      if (aether.busy) throw new Error("The AI agent is busy with another answer — try again when it has finished");
      if (notes.length > 0 && !aether.vaultPath) throw new Error("No vault is connected");
      const notePaths = notes.map((rel) => joinVaultPath(aether.vaultPath!, sanitizeVaultPath(rel)));
      const provider = aether.provider;
      const model = aether.modelByProvider[provider];
      let answer = "";
      aether.setBusy(true);
      try {
        const unlisten = await onStreamChunk((chunk) => {
          answer += chunk;
        });
        try {
          await agentQueryWithNotes(prompt, notePaths, model, provider);
        } finally {
          unlisten();
        }
      } finally {
        useAetherStore.getState().clearAgentOutput();
        useAetherStore.getState().setBusy(false);
      }
      return answer;
    };
    const result = this.aiQueue.then(run, run);
    this.aiQueue = result.catch(() => undefined);
    return result;
  }
}

let host: PluginHost | null = null;

/** The app-wide plugin host. */
export function getPluginHost(): PluginHost {
  host ??= new PluginHost();
  return host;
}

/** Start the app-wide host when a backend is available; errors become a toast. */
export function startPluginHost(): void {
  if (!isDesktopRuntime()) return;
  getPluginHost()
    .start()
    .catch((error) => toast.error("Plugins could not be loaded", { description: errorMessage(error) }));
}
