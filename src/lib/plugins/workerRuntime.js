/**
 * AETHER-OS plugin worker runtime.
 *
 * This file is never imported as a module: `bootstrap.ts` loads it as raw
 * text (`?raw`) and embeds it into the generated worker script, right after
 * the hardening prologue. It must stay plain, self-contained ES2020 — no
 * imports, no references to anything outside the function.
 *
 * It implements the worker side of the RPC protocol (`protocol.ts`): the
 * `api` object handed to the plugin's `activate(api)` turns every call into
 * a `request` message with an id and a timeout, and it answers the host's
 * `activate` / `deactivate` / `command.run` requests.
 *
 * @param {object} scope the worker global (`self`)
 * @param {{
 *   defaultTimeoutMs: number,
 *   methodTimeouts: Record<string, number>,
 *   installFetchShim: boolean,
 *   loadModule?: (source: string) => Promise<object>,
 * }} options
 */
function aetherPluginRuntime(scope, options) {
  "use strict";

  const post = scope.postMessage.bind(scope);
  const pending = new Map();
  const listeners = new Map();
  const commands = new Map();
  const timeouts = options.methodTimeouts || {};
  let nextId = 1;
  let pluginModule = null;
  let active = false;

  function describe(error) {
    if (error && typeof error === "object" && "message" in error) return String(error.message);
    return String(error);
  }

  function report(level, message) {
    try {
      post({ kind: "log", level, message: String(message).slice(0, 2000) });
    } catch (_) {
      // The host is gone; nothing left to tell.
    }
  }

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timeoutMs = timeouts[method] || options.defaultTimeoutMs;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`AETHER-OS did not answer "${method}" within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        post({ kind: "request", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new TypeError(`Cannot send "${method}" to AETHER-OS: ${describe(error)}`));
      }
    });
  }

  function emit(name, payload) {
    const set = listeners.get(name);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        const result = handler(payload);
        if (result && typeof result.then === "function") {
          result.then(undefined, (error) => report("error", `"${name}" handler failed: ${describe(error)}`));
        }
      } catch (error) {
        report("error", `"${name}" handler failed: ${describe(error)}`);
      }
    }
  }

  function freezeDeep(object) {
    for (const value of Object.values(object)) {
      if (value && typeof value === "object" && !Object.isFrozen(value)) freezeDeep(value);
    }
    return Object.freeze(object);
  }

  function wrapResponse(response) {
    const body = String(response.body);
    return Object.freeze({
      url: response.url,
      status: response.status,
      ok: response.ok,
      contentType: response.contentType,
      body,
      text: () => body,
      json: () => JSON.parse(body),
    });
  }

  function createApi(meta) {
    return freezeDeep({
      plugin: {
        id: String(meta.id),
        name: String(meta.name),
        version: String(meta.version),
        permissions: Array.from(meta.permissions || [], String),
      },
      vault: {
        list: () => call("vault.list", []),
        read: (path) => call("vault.read", [path]),
        write: (path, content) => call("vault.write", [path, content]),
      },
      notes: {
        create: (title, content) => call("notes.create", [title, content === undefined ? "" : content]),
        current: () => call("notes.current", []),
        open: (path) => call("notes.open", [path]),
      },
      commands: {
        register: (command) => {
          if (!command || typeof command !== "object") {
            return Promise.reject(new TypeError("commands.register expects { id, title, shortcut?, run }"));
          }
          if (typeof command.run !== "function") {
            return Promise.reject(new TypeError("command.run must be a function"));
          }
          const id = command.id;
          const run = command.run;
          commands.set(id, run);
          const payload = { id, title: command.title, shortcut: command.shortcut === undefined ? null : command.shortcut };
          return call("commands.register", [payload]).then(
            () => undefined,
            (error) => {
              if (commands.get(id) === run) commands.delete(id);
              throw error;
            }
          );
        },
        unregister: (id) => {
          commands.delete(id);
          return call("commands.unregister", [id]).then(() => undefined);
        },
      },
      ui: {
        panel: {
          set: (tree) => call("ui.panel.set", [tree === undefined ? null : tree]).then(() => undefined),
          clear: () => call("ui.panel.set", [null]).then(() => undefined),
        },
        statusbar: {
          set: (text, tooltip) =>
            call("ui.statusbar.set", [text == null ? null : text, tooltip == null ? null : tooltip]).then(() => undefined),
          clear: () => call("ui.statusbar.set", [null, null]).then(() => undefined),
        },
        toast: (message, kind) => call("ui.toast", [message, kind === undefined ? "info" : kind]).then(() => undefined),
      },
      ai: {
        query: (prompt, queryOptions) =>
          call("ai.query", [prompt, { notes: queryOptions && Array.isArray(queryOptions.notes) ? queryOptions.notes : [] }]),
      },
      storage: {
        get: (key) => call("storage.get", [key]),
        set: (key, value) => call("storage.set", [key, value === undefined ? null : value]).then(() => undefined),
      },
      settings: {
        get: () => call("settings.get", []),
      },
      clipboard: {
        readText: () => call("clipboard.readText", []),
      },
      net: {
        fetch: (url) => call("net.fetch", [String(url)]).then(wrapResponse),
      },
      events: {
        on: (name, handler) => {
          if (typeof handler !== "function") throw new TypeError("events.on expects a handler function");
          const key = String(name);
          const set = listeners.get(key) || new Set();
          set.add(handler);
          listeners.set(key, set);
          return () => {
            set.delete(handler);
          };
        },
      },
    });
  }

  /** `fetch` for plugins with a `net:fetch:<host>` grant: GET only, routed through the host. */
  function installFetchShim() {
    const shim = (input, init) => {
      if (init && ((init.method && String(init.method).toUpperCase() !== "GET") || init.body != null)) {
        return Promise.reject(new TypeError("Plugins may only send GET requests"));
      }
      const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
      return call("net.fetch", [String(url)]).then(
        (response) =>
          new scope.Response(response.body, {
            status: response.status,
            headers: response.contentType ? { "content-type": response.contentType } : {},
          })
      );
    };
    Object.defineProperty(scope, "fetch", { value: shim, writable: false, configurable: false, enumerable: false });
  }

  async function defaultLoadModule(source) {
    const url = scope.URL.createObjectURL(new scope.Blob([source], { type: "text/javascript" }));
    try {
      return await import(url);
    } finally {
      scope.URL.revokeObjectURL(url);
    }
  }

  function pick(module, name) {
    if (module && typeof module[name] === "function") return module[name];
    const fallback = module && module.default;
    if (fallback && typeof fallback[name] === "function") return fallback[name].bind(fallback);
    if (name === "activate" && typeof fallback === "function") return fallback;
    return null;
  }

  async function activate(init) {
    if (active) throw new Error("the plugin is already active");
    const load = options.loadModule || defaultLoadModule;
    const module = await load(String(init.source));
    const activateFn = pick(module, "activate");
    if (!activateFn) throw new Error("main.js must export an activate(api) function");
    pluginModule = module;
    active = true;
    await activateFn(createApi(init.plugin || {}));
    return null;
  }

  async function deactivate() {
    const fn = pickDeactivate();
    active = false;
    listeners.clear();
    commands.clear();
    if (fn) await fn();
    return null;
  }

  function pickDeactivate() {
    return pluginModule ? pick(pluginModule, "deactivate") : null;
  }

  async function runCommand(commandId) {
    const run = commands.get(commandId);
    if (!run) throw new Error(`command "${commandId}" is not registered`);
    emit("command:invoked", { id: commandId });
    await run();
    return null;
  }

  async function answer(message) {
    let response;
    try {
      let result = null;
      const params = Array.isArray(message.params) ? message.params : [];
      if (message.method === "activate") result = await activate(params[0] || {});
      else if (message.method === "deactivate") result = await deactivate();
      else if (message.method === "command.run") result = await runCommand(String(params[0]));
      else throw new Error(`unknown host request "${message.method}"`);
      response = { kind: "response", id: message.id, ok: true, result };
    } catch (error) {
      response = { kind: "response", id: message.id, ok: false, error: describe(error) };
    }
    try {
      post(response);
    } catch (error) {
      post({ kind: "response", id: message.id, ok: false, error: `result cannot be sent: ${describe(error)}` });
    }
  }

  scope.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.kind === "response") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(String(message.error)));
    } else if (message.kind === "event") {
      emit(String(message.name), message.payload);
    } else if (message.kind === "request") {
      void answer(message);
    }
  });

  scope.addEventListener("unhandledrejection", (event) => {
    report("error", `Unhandled promise rejection: ${describe(event.reason)}`);
  });

  if (options.installFetchShim) installFetchShim();
}
