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
import { appHandlers } from "./app";
import { browserHandlers } from "./browser";
import { calendarHandlers } from "./calendar";
import { clipboardHandlers } from "./clipboard";
import { diagnosticsHandlers } from "./diagnostics";
import { exportHandlers } from "./export";
import { gitHandlers } from "./git";
import { historyHandlers } from "./history";
import { homeHandlers } from "./home";
import { ideHandlers } from "./ide";
import { intelHandlers } from "./intel";
import { lspHandlers } from "./lsp";
import { memoryHandlers } from "./memory";
import { notesHandlers } from "./notes";
import { onboardingHandlers } from "./onboarding";
import { pluginsHandlers } from "./plugins";
import { projectsHandlers } from "./projects";
import { mockEvents, resetMockState, type MockArgs, type MockHandlerMap } from "./runtime";
import { searchHandlers } from "./search";
import { systemHandlers } from "./system";
import { syncHandlers } from "./sync";
import { tasksHandlers } from "./tasks";
import { terminalHandlers } from "./terminal";
import { updaterHandlers } from "./updater";
import { vaultHandlers } from "./vault";
import { vaulttasksHandlers } from "./vaulttasks";

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
  ...appHandlers,
  ...clipboardHandlers,
  // @anchor:mock:clipboard
  ...searchHandlers,
  // @anchor:mock:search
  ...historyHandlers,
  // @anchor:mock:history
  ...homeHandlers,
  // @anchor:mock:home
  ...vaulttasksHandlers,
  // @anchor:mock:vaulttasks
  ...intelHandlers,
  // @anchor:mock:intel
  ...pluginsHandlers,
  // @anchor:mock:plugins
  ...exportHandlers,
  // @anchor:mock:export
  ...syncHandlers,
  // @anchor:mock:sync
  ...onboardingHandlers,
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

/**
 * Simulate the desktop quit flow (⌘Q with running terminals): emits
 * `quit-requested` with the number of live mock terminal sessions (at
 * least `min`, so the dialog can be tried without opening a terminal).
 */
export async function requestMockQuit(min = 1): Promise<number> {
  const sessions = (await mockInvoke<{ alive: boolean }[]>("cmd_terminal_list")) ?? [];
  const terminals = Math.max(min, sessions.filter((s) => s.alive).length);
  mockEvents.emit("quit-requested", { terminals });
  return terminals;
}

// Handy for manual QA in the browser console: window.__AETHER_MOCK__.
if (typeof window !== "undefined") {
  (window as unknown as { __AETHER_MOCK__?: unknown }).__AETHER_MOCK__ = {
    handlers: mockHandlers,
    events: mockEvents,
    invoke: mockInvoke,
    reset: resetMockState,
    requestQuit: requestMockQuit,
  };
}
