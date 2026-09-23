/**
 * DEV-only mock backend for the browser preview (`npm run dev:mock`).
 *
 * `mockInvoke` dispatches a command to its handler, mimicking Tauri's IPC:
 * arguments and results are deep-copied (as if serialised), `()` results
 * become `null`, failures reject with the error *string* (like a Rust
 * `Err(String)`), and every call takes a few milliseconds. `mockEvents`
 * replaces Tauri events for streaming (`llm-stream-chunk`,
 * `terminal-output`, …).
 *
 * This module is only reachable through a dynamic import guarded by
 * `import.meta.env.DEV` in `src/lib/ipc/core.ts`, so production bundles
 * never contain it. Feature agents add `...<feature>Handlers,` directly
 * above their anchor (SWARM-CONTRACT §3). A test asserts that every command
 * registered in `src-tauri/src/lib.rs` has a handler here.
 */
import { aetherNotesHandlers } from "./aetherNotes";
import { agentActionsHandlers } from "./agentActions";
import { aiHandlers } from "./ai";
import { browserHandlers } from "./browser";
import { calendarHandlers } from "./calendar";
import { diagnosticsHandlers } from "./diagnostics";
import { gitHandlers } from "./git";
import { ideHandlers } from "./ide";
import { lspHandlers } from "./lsp";
import { memoryHandlers } from "./memory";
import { notesHandlers } from "./notes";
import { projectsHandlers } from "./projects";
import { mockEvents, resetMockState, type MockArgs, type MockHandlerMap } from "./runtime";
import { systemHandlers } from "./system";
import { tasksHandlers } from "./tasks";
import { terminalHandlers } from "./terminal";
import { updaterHandlers } from "./updater";
import { vaultHandlers } from "./vault";

export { mockEvents, resetMockState };
export type { MockArgs, MockHandler, MockHandlerMap } from "./runtime";

/** Command name → mock implementation. */
export const mockHandlers: MockHandlerMap = {
  ...vaultHandlers,
  ...aiHandlers,
  ...aetherNotesHandlers,
  ...projectsHandlers,
  ...memoryHandlers,
  ...terminalHandlers,
  ...systemHandlers,
  ...browserHandlers,
  ...notesHandlers,
  ...ideHandlers,
  ...gitHandlers,
  ...calendarHandlers,
  ...lspHandlers,
  ...tasksHandlers,
  ...agentActionsHandlers,
  ...diagnosticsHandlers,
  ...updaterHandlers,
  // @anchor:mock:clipboard
  // @anchor:mock:search
  // @anchor:mock:history
  // @anchor:mock:home
  // @anchor:mock:vaulttasks
  // @anchor:mock:intel
  // @anchor:mock:plugins
  // @anchor:mock:export
  // @anchor:mock:sync
  // @anchor:mock:onboarding
};

let latency: [number, number] = [8, 40];
/** Dispatch time of the most recent call; keeps calls in FIFO order. */
let lastDispatchAt = 0;

/** Set the simulated IPC latency range in ms (tests use `0, 0`). */
export function setMockLatency(minMs: number, maxMs = minMs): void {
  latency = [Math.max(0, minMs), Math.max(minMs, maxMs)];
}

/**
 * Wait a random IPC latency, but never dispatch before a call that was
 * issued earlier: Tauri delivers commands in order, and e.g. keystrokes
 * sent to `cmd_terminal_write` must not overtake each other.
 */
function simulateLatency(): Promise<void> {
  const [min, max] = latency;
  if (max <= 0) return Promise.resolve();
  const now = Date.now();
  const at = Math.max(now + min + Math.random() * (max - min), lastDispatchAt);
  lastDispatchAt = at;
  return new Promise((resolve) => setTimeout(resolve, at - now));
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

/** Invoke a mock command. Rejects with a string message on failure. */
export async function mockInvoke<T>(command: string, args: MockArgs = {}): Promise<T> {
  const handler = mockHandlers[command];
  if (!handler) {
    throw `[mock] command ${command} not found — add a handler in src/lib/mock/`;
  }
  await simulateLatency();
  try {
    const result = await handler(clone(args));
    return (result === undefined ? null : clone(result)) as T;
  } catch (error) {
    throw error instanceof Error ? error.message : String(error);
  }
}

// Handy for manual QA in the browser console: window.__AETHER_MOCK__.
if (typeof window !== "undefined") {
  (window as unknown as { __AETHER_MOCK__?: unknown }).__AETHER_MOCK__ = {
    handlers: mockHandlers,
    events: mockEvents,
    invoke: mockInvoke,
    reset: resetMockState,
  };
}
