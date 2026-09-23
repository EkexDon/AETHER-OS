import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type { UnlistenFn };

/**
 * Thrown by {@link call} when no backend can answer: the app runs in a plain
 * browser without the DEV mock backend.
 */
export class IpcUnavailableError extends Error {
  constructor() {
    super("AETHER-OS runs as a desktop application. Start it with: npm run app");
    this.name = "IpcUnavailableError";
  }
}

/** True inside the Tauri webview (the real Rust backend is reachable). */
export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * True when the DEV-only mock backend serves IPC: `npm run dev:mock`
 * (`VITE_AETHER_MOCK=1`) opened in a normal browser. Always `false` in
 * production builds, where `import.meta.env.DEV` is statically `false`.
 */
export const isMockRuntime = (): boolean =>
  import.meta.env.DEV && import.meta.env.VITE_AETHER_MOCK === "1" && !isTauriRuntime();

/**
 * True when a backend can answer IPC calls — the Tauri desktop runtime, or
 * the DEV mock backend in browser preview. Views use this to decide whether
 * to talk to the backend at all; use {@link isTauriRuntime} for features
 * that need the real desktop shell (native webviews, file dialogs).
 */
export const isDesktopRuntime = (): boolean => isTauriRuntime() || isMockRuntime();

type MockBackendModule = typeof import("../mock/backend");
let mockBackend: Promise<MockBackendModule> | null = null;

/** Lazily load the mock backend. The dynamic import sits behind a static
 *  `import.meta.env.DEV` check so production bundles drop it entirely. */
function loadMockBackend(): Promise<MockBackendModule> {
  if (import.meta.env.DEV) {
    mockBackend ??= import("../mock/backend");
    return mockBackend;
  }
  return Promise.reject(new IpcUnavailableError());
}

/** Normalise a backend rejection into an `Error` with a readable message. */
function toError(reason: unknown): Error {
  return new Error(typeof reason === "string" ? reason : String(reason));
}

/**
 * Invoke a backend command. Routes to Tauri's `invoke` in the desktop
 * runtime and to the mock backend in `dev:mock`; throws
 * {@link IpcUnavailableError} otherwise. Backend errors (Rust
 * `Result::Err(String)`) are rethrown as `Error` with the same message.
 */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) {
    try {
      return await invoke<T>(command, args);
    } catch (reason) {
      throw toError(reason);
    }
  }
  if (isMockRuntime()) {
    const mock = await loadMockBackend();
    try {
      return await mock.mockInvoke<T>(command, args ?? {});
    } catch (reason) {
      throw toError(reason);
    }
  }
  throw new IpcUnavailableError();
}

/**
 * Subscribe to a backend event and receive its payload. Uses Tauri's
 * `listen` in the desktop runtime and the mock event bus in `dev:mock`.
 * In a plain browser it resolves to a no-op unlisten function and never
 * throws, so views can subscribe unconditionally.
 */
export async function listenSafe<T>(
  event: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    return listen<T>(event, (e) => handler(e.payload));
  }
  if (isMockRuntime()) {
    try {
      const mock = await loadMockBackend();
      return mock.mockEvents.listen<T>(event, handler);
    } catch {
      return () => undefined;
    }
  }
  return () => undefined;
}
