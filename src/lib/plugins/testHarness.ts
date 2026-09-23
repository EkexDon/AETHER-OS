/**
 * Test-only helpers (imported by `*.test.ts` files, never by app code).
 *
 * jsdom has no Web Workers and vitest cannot `import()` a blob URL, so the
 * tests run the *real* generated bootstrap (hardening prologue + worker
 * runtime) inside {@link InProcessWorker}: a fake worker global whose
 * `postMessage` traffic is structured-cloned and delivered asynchronously,
 * like a real worker. Only the final module import is swapped for
 * {@link evaluatePluginModule}.
 */
import type { PluginHostDeps } from "./host";
import type { WorkerLike } from "./protocol";

type Listener = (event: { data?: unknown; reason?: unknown; message?: string; preventDefault?: () => void }) => void;

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return typeof structuredClone === "function" ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Evaluate a plugin module that uses `export function|async function|const`
 * declarations (the style of the bundled examples) and return its exports.
 */
export function evaluatePluginModule(source: string): Record<string, unknown> {
  const names: string[] = [];
  const body = source.replace(
    /^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_match, kind: string, name: string) => {
      names.push(name);
      return `${kind} ${name}`;
    }
  );
  if (/^export\s/m.test(body)) throw new Error("evaluatePluginModule: unsupported export syntax");
  return new Function(`"use strict";\n${body}\nreturn { ${names.join(", ")} };`)() as Record<string, unknown>;
}

/** The fake worker global the bootstrap runs against. */
export type FakeWorkerScope = Record<string, unknown> & { navigator: Record<string, unknown> };

/** A worker that runs a bootstrap string in-process. */
export class InProcessWorker implements WorkerLike {
  readonly scope: FakeWorkerScope;
  terminated = false;
  private readonly hostMessage = new Set<(event: MessageEvent) => void>();
  private readonly hostError = new Set<(event: Event) => void>();
  private readonly workerListeners = new Map<string, Set<Listener>>();

  constructor(
    bootstrap: string,
    loadModule: (source: string) => Promise<object> = async (source) => evaluatePluginModule(source)
  ) {
    const scope: FakeWorkerScope = {
      postMessage: (data: unknown) => {
        const copy = clone(data);
        queueMicrotask(() => {
          if (this.terminated) return;
          for (const listener of [...this.hostMessage]) listener({ data: copy } as MessageEvent);
        });
      },
      addEventListener: (type: string, listener: Listener) => {
        const set = this.workerListeners.get(type) ?? new Set<Listener>();
        set.add(listener);
        this.workerListeners.set(type, set);
      },
      removeEventListener: (type: string, listener: Listener) => {
        this.workerListeners.get(type)?.delete(listener);
      },
      navigator: { storage: { estimate: () => undefined }, locks: {}, userAgent: "test" },
      fetch: () => Promise.reject(new Error("native fetch must never be reachable")),
      XMLHttpRequest: class {},
      WebSocket: class {},
      EventSource: class {},
      importScripts: () => undefined,
      indexedDB: {},
      caches: {},
      BroadcastChannel: class {},
      Worker: class {},
      Response: globalThis.Response,
      URL: globalThis.URL,
      Blob: globalThis.Blob,
    };
    this.scope = scope;
    const code = bootstrap.replace(
      /aetherPluginRuntime\(self, (\{.*\})\);\s*$/,
      "aetherPluginRuntime(self, Object.assign($1, { loadModule: __loadModule }));"
    );
    if (code === bootstrap) throw new Error("InProcessWorker: unexpected bootstrap shape");
    new Function("self", "__loadModule", code)(scope, loadModule);
  }

  postMessage(message: unknown): void {
    const copy = clone(message);
    queueMicrotask(() => {
      if (this.terminated) return;
      for (const listener of [...(this.workerListeners.get("message") ?? [])]) listener({ data: copy });
    });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    if (type === "message") this.hostMessage.add(listener as (event: MessageEvent) => void);
    else this.hostError.add(listener as (event: Event) => void);
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    if (type === "message") this.hostMessage.delete(listener as (event: MessageEvent) => void);
    else this.hostError.delete(listener as (event: Event) => void);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Simulate an uncaught error inside the worker. */
  fail(message: string): void {
    for (const listener of [...this.hostError]) listener({ message, preventDefault: () => undefined } as unknown as Event);
  }
}

/** Host dependencies that create {@link InProcessWorker}s and remember them. */
export function inProcessWorkerDeps(
  loadModule?: (source: string) => Promise<object>
): PluginHostDeps & { workers: Map<string, InProcessWorker> } {
  const workers = new Map<string, InProcessWorker>();
  return {
    workers,
    createWorker(bootstrap, name) {
      const worker = new InProcessWorker(bootstrap, loadModule);
      workers.set(name.replace(/^plugin:/, ""), worker);
      return { worker, dispose: () => undefined };
    },
  };
}
