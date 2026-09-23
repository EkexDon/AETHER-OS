/**
 * Typed RPC between the plugin host (webview) and a plugin worker.
 *
 * Both sides exchange four message kinds over `postMessage`:
 *
 * | kind | direction | meaning |
 * | --- | --- | --- |
 * | `request` | both | call `method` with `params`; answered by a `response` with the same `id` |
 * | `response` | both | `ok: true` + `result`, or `ok: false` + `error` (a message string) |
 * | `event` | host → plugin | fire-and-forget notification (`note:opened`, …) |
 * | `log` | plugin → host | diagnostics (unhandled rejections, handler failures) |
 *
 * Plugin → host requests are the `api.*` calls (see `api.ts`); host → plugin
 * requests are `activate`, `deactivate` and `command.run`. Every request has
 * a timeout (10 s unless the method needs longer). The worker side of the
 * protocol lives in `workerRuntime.js` (plain JS, it runs inside the worker).
 */

/** Default request timeout. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** A call to a method on the other side. */
export interface RpcRequest {
  kind: "request";
  id: number;
  method: string;
  params: unknown[];
}

/** The answer to a {@link RpcRequest}. */
export type RpcResponse =
  | { kind: "response"; id: number; ok: true; result: unknown }
  | { kind: "response"; id: number; ok: false; error: string };

/** A fire-and-forget notification. */
export interface RpcEvent {
  kind: "event";
  name: string;
  payload: unknown;
}

/** Diagnostics from the plugin. */
export interface RpcLog {
  kind: "log";
  level: "info" | "warn" | "error";
  message: string;
}

/** Any protocol message. */
export type RpcMessage = RpcRequest | RpcResponse | RpcEvent | RpcLog;

/** Raised when the other side does not answer in time. */
export class RpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number
  ) {
    super(`"${method}" did not answer within ${Math.round(timeoutMs / 100) / 10} s`);
    this.name = "RpcTimeoutError";
  }
}

/** Raised for requests still pending when the endpoint is disposed. */
export class RpcClosedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RpcClosedError";
  }
}

const MAX_DEPTH = 32;

/**
 * Throw unless `value` is plain data that survives `postMessage` unchanged:
 * `null`, booleans, finite numbers, strings, arrays and plain objects
 * (functions, class instances, cycles, `undefined` inside arrays and
 * non-finite numbers are rejected with the offending path).
 */
export function assertPlainData(value: unknown, path = "value", depth = 0, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${path} cannot be sent (${typeof value} is not plain data)`);
  if (depth > MAX_DEPTH) throw new TypeError(`${path} is nested too deeply`);
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPlainData(item, `${path}[${i}]`, depth + 1, seen));
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path} must be a plain object`);
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      assertPlainData(item, `${path}.${key}`, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate an incoming message. Returns `null` for anything that is not a
 * well-formed protocol message (it is then ignored).
 */
export function parseMessage(data: unknown): RpcMessage | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const m = data as Record<string, unknown>;
  switch (m.kind) {
    case "request":
      if (!isInt(m.id) || typeof m.method !== "string" || !m.method || m.method.length > 64) return null;
      if (!Array.isArray(m.params) || m.params.length > 16) return null;
      return { kind: "request", id: m.id, method: m.method, params: m.params };
    case "response":
      if (!isInt(m.id) || typeof m.ok !== "boolean") return null;
      if (m.ok) return { kind: "response", id: m.id, ok: true, result: m.result ?? null };
      return { kind: "response", id: m.id, ok: false, error: typeof m.error === "string" ? m.error : "Unknown error" };
    case "event":
      if (typeof m.name !== "string" || !m.name || m.name.length > 64) return null;
      return { kind: "event", name: m.name, payload: m.payload ?? null };
    case "log":
      if (m.level !== "info" && m.level !== "warn" && m.level !== "error") return null;
      return { kind: "log", level: m.level, message: String(m.message ?? "").slice(0, 2000) };
    default:
      return null;
  }
}

/** A message channel: send a message, receive raw message data. */
export interface RpcTransport {
  post(message: RpcMessage): void;
  /** Deliver every incoming `event.data`; returns an unsubscribe function. */
  subscribe(handler: (data: unknown) => void): () => void;
}

/** Callbacks for incoming traffic. */
export interface RpcHandlers {
  /** Answer a request; throw (or reject) to send an error response. */
  onRequest?: (method: string, params: unknown[]) => unknown | Promise<unknown>;
  onEvent?: (name: string, payload: unknown) => void;
  onLog?: (log: RpcLog) => void;
  /** Called with data that failed {@link parseMessage}. */
  onInvalid?: (data: unknown) => void;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One side of the RPC: correlates requests with responses and dispatches incoming calls. */
export class RpcEndpoint {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly unsubscribe: () => void;
  private closed: string | null = null;

  constructor(
    private readonly transport: RpcTransport,
    private readonly handlers: RpcHandlers = {},
    private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    this.unsubscribe = transport.subscribe((data) => this.receive(data));
  }

  /** Number of requests waiting for a response. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Whether {@link dispose} has been called. */
  get isClosed(): boolean {
    return this.closed !== null;
  }

  /** Call `method` on the other side. Rejects with {@link RpcTimeoutError} after `timeoutMs`. */
  request(method: string, params: unknown[] = [], timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    if (this.closed !== null) return Promise.reject(new RpcClosedError(this.closed));
    try {
      assertPlainData(params, "params");
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.transport.post({ kind: "request", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Send a fire-and-forget event. Silently dropped after {@link dispose}. */
  notify(name: string, payload: unknown = null): void {
    if (this.closed !== null) return;
    assertPlainData(payload, "payload");
    this.transport.post({ kind: "event", name, payload });
  }

  /** Stop listening and reject every pending request with `reason`. */
  dispose(reason = "The connection was closed"): void {
    if (this.closed !== null) return;
    this.closed = reason;
    this.unsubscribe();
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new RpcClosedError(reason));
      this.pending.delete(id);
    }
  }

  private receive(data: unknown): void {
    if (this.closed !== null) return;
    const message = parseMessage(data);
    if (!message) {
      this.handlers.onInvalid?.(data);
      return;
    }
    switch (message.kind) {
      case "response": {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(message.error));
        return;
      }
      case "request":
        void this.answer(message);
        return;
      case "event":
        this.handlers.onEvent?.(message.name, message.payload);
        return;
      case "log":
        this.handlers.onLog?.(message);
        return;
    }
  }

  private async answer(request: RpcRequest): Promise<void> {
    let response: RpcResponse;
    try {
      if (!this.handlers.onRequest) throw new Error(`Unknown method "${request.method}"`);
      const result = await this.handlers.onRequest(request.method, request.params);
      const value = result === undefined ? null : result;
      assertPlainData(value, "result");
      response = { kind: "response", id: request.id, ok: true, result: value };
    } catch (error) {
      response = {
        kind: "response",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (this.closed === null) this.transport.post(response);
  }
}

/** Minimal `Worker` surface the host needs (real workers and test doubles). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

/** Adapt a worker into an {@link RpcTransport}. */
export function workerTransport(worker: WorkerLike): RpcTransport {
  return {
    post: (message) => worker.postMessage(message),
    subscribe: (handler) => {
      const listener = (event: MessageEvent) => handler(event.data);
      worker.addEventListener("message", listener);
      return () => worker.removeEventListener("message", listener);
    },
  };
}
