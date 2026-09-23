/**
 * Shared plumbing for the DEV-only mock backend: handler types, the event
 * bus that stands in for Tauri events, argument validation that mirrors
 * Tauri's "missing required key" errors, and a reset registry so tests can
 * start from pristine seed data.
 */

/** Arguments exactly as the IPC wrappers pass them (camelCase top level). */
export type MockArgs = Record<string, unknown>;
/** A mock command implementation. Throw an `Error` to reject like Rust `Err`. */
export type MockHandler = (args: MockArgs) => unknown | Promise<unknown>;
/** Command name → implementation. Every feature exports one of these. */
export type MockHandlerMap = Record<string, MockHandler>;

type Listener = (payload: unknown) => void;

/** In-memory replacement for Tauri's event system. */
export class MockEventBus {
  private listeners = new Map<string, Set<Listener>>();

  /**
   * Subscribe to `event`; returns the unlisten function. Like Tauri, every
   * call is its own registration — subscribing the same handler twice
   * (e.g. React StrictMode's double effect) needs two unlistens.
   */
  listen<T>(event: string, handler: (payload: T) => void): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    const registration: Listener = (payload) => handler(payload as T);
    set.add(registration);
    this.listeners.set(event, set);
    return () => {
      set.delete(registration);
    };
  }

  /** Deliver `payload` to every current listener of `event`. A throwing
   *  listener never stops delivery to the others. */
  emit<T>(event: string, payload: T): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[mock] listener for "${event}" threw`, error);
      }
    }
  }

  /** Number of active listeners (used by tests). */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

/** The single mock event bus shared by all mock handlers. */
export const mockEvents = new MockEventBus();

/** Promise-based delay. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let idCounter = 0;

/** A UUID v4 (falls back to a counter-based id where `crypto` is missing). */
export function mockUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  idCounter += 1;
  const hex = (idCounter.toString(16) + Date.now().toString(16)).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}

/** Deterministic 40-char hex id derived from `seed` (fake git hashes). */
export function fakeSha(seed: string): string {
  let out = "";
  let h = 2166136261;
  for (let round = 0; out.length < 40; round++) {
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i) + round;
      h = Math.imul(h, 16777619) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

const resetters: Array<() => void> = [];

/** Register a function that restores a module's seed state. */
export function registerReset(reset: () => void): void {
  resetters.push(reset);
}

/** Restore every mock store to its seed data (tests call this in `beforeEach`). */
export function resetMockState(): void {
  for (const reset of resetters) reset();
}

function missing(key: string): Error {
  return new Error(`invalid args \`${key}\` for command: command missing required key ${key}`);
}

/** Required string argument. */
export function argString(args: MockArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw missing(key);
  return value;
}

/** Optional string argument (`undefined`/`null` → `null`). */
export function argOptString(args: MockArgs, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw missing(key);
  return value;
}

/** Required boolean argument. */
export function argBool(args: MockArgs, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") throw missing(key);
  return value;
}

/** Required numeric argument. */
export function argNumber(args: MockArgs, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || Number.isNaN(value)) throw missing(key);
  return value;
}

/** Optional numeric argument. */
export function argOptNumber(args: MockArgs, key: string): number | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || Number.isNaN(value)) throw missing(key);
  return value;
}

/** Required string array argument. */
export function argStringArray(args: MockArgs, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw missing(key);
  return value as string[];
}

/** Required object argument (nested structs such as patches). */
export function argObject<T extends object>(args: MockArgs, key: string): Partial<T> {
  const value = args[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw missing(key);
  return value as Partial<T>;
}

/** Current time in whole seconds since the Unix epoch. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Local calendar date `YYYY-MM-DD`. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local time `HH:MM`. */
export function localTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** RFC 3339 timestamp with the local UTC offset (like chrono's `Local`). */
export function localRfc3339(d: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/** Add whole days to a date (local time). */
export function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** Normalise an absolute POSIX-style path: collapse `.`/`..`/duplicate slashes. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return (absolute ? "/" : "") + parts.join("/");
}

/** True when `path` equals `root` or lies below it. */
export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Parent directory of an absolute path. */
export function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

/** Last path component. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
