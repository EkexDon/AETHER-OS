/**
 * Frontend error reporting. Render crashes (error boundaries), uncaught
 * errors (`window.onerror`) and unhandled promise rejections are forwarded
 * to `cmd_log_frontend_error`, which appends them to the local
 * `logs/aether.log` (fatal ones also become crash reports). Nothing leaves
 * the machine.
 *
 * Reporting is batched (250 ms), de-duplicated, rate-limited and never
 * throws — a failing reporter must not cause the next error.
 */
import { logFrontendError } from "./ipc";
import type { FrontendErrorPayload } from "../types";

/** What a caller knows about an error. */
export interface FrontendErrorInput {
  error: unknown;
  /** React component stack (error boundaries only). */
  componentStack?: string | null;
  /** View or component name. */
  view?: string | null;
  /** "boundary" | "window.onerror" | "unhandledrejection" | … */
  source: string;
  /** True when the error took down a view. */
  fatal?: boolean;
}

const FLUSH_DELAY_MS = 250;
const MAX_REPORTS_PER_MINUTE = 20;
/** Browser/library noise that is not an application error: ResizeObserver
 *  loop notices, opaque cross-origin "Script error." and Monaco's
 *  cancellation rejections (`Canceled`) when a pending hover/diff is
 *  superseded. */
const IGNORED_MESSAGES = [/ResizeObserver loop/i, /^Script error\.?$/i, /^Canceled$/];

/** Extract a readable message and stack from anything that was thrown. */
export function describeError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message || error.name || "Unknown error", stack: error.stack ?? null };
  }
  if (typeof error === "string") return { message: error || "Unknown error", stack: null };
  try {
    const json = JSON.stringify(error);
    return { message: json && json !== "{}" ? json : String(error), stack: null };
  } catch {
    return { message: String(error), stack: null };
  }
}

/** Convert an error into the IPC payload for `cmd_log_frontend_error`. */
export function toErrorPayload(input: FrontendErrorInput): FrontendErrorPayload {
  const { message, stack } = describeError(input.error);
  return {
    message,
    stack,
    component_stack: input.componentStack?.trim() || null,
    source: input.source,
    view: input.view ?? null,
    url: typeof window !== "undefined" ? window.location.href : null,
    fatal: input.fatal ?? false,
  };
}

/** Human-readable report for the "Copy report" button. */
export function buildErrorReport(input: FrontendErrorInput, now: Date = new Date()): string {
  const payload = toErrorPayload(input);
  const lines = [
    "AETHER-OS error report",
    `time: ${now.toISOString()}`,
    `view: ${payload.view ?? "unknown"}`,
    `source: ${payload.source}`,
    `url: ${payload.url ?? ""}`,
    `user agent: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
    "",
    `message: ${payload.message}`,
  ];
  if (payload.stack) lines.push("", "stack:", payload.stack);
  if (payload.component_stack) lines.push("", "component stack:", payload.component_stack);
  return lines.join("\n");
}

type Sender = (payload: FrontendErrorPayload) => Promise<void>;

let sender: Sender = logFrontendError;
let queue: FrontendErrorPayload[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let sentTimestamps: number[] = [];
let warnedUnavailable = false;

/** Replace the transport (tests). Returns the previous one. */
export function setErrorSender(next: Sender): Sender {
  const previous = sender;
  sender = next;
  return previous;
}

async function flush(): Promise<void> {
  flushTimer = null;
  const batch = queue;
  queue = [];
  for (const payload of batch) {
    const now = Date.now();
    sentTimestamps = sentTimestamps.filter((t) => now - t < 60_000);
    if (sentTimestamps.length >= MAX_REPORTS_PER_MINUTE) return;
    sentTimestamps.push(now);
    try {
      await sender(payload);
    } catch (reason) {
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        console.warn("[diagnostics] could not record frontend error:", reason);
      }
    }
  }
}

/**
 * Queue an error for the local log. Identical errors within one batch are
 * collapsed; a fatal occurrence wins over non-fatal duplicates. Never throws.
 */
export function reportFrontendError(input: FrontendErrorInput): void {
  try {
    const payload = toErrorPayload(input);
    if (IGNORED_MESSAGES.some((re) => re.test(payload.message))) return;
    const duplicate = queue.find(
      (p) => p.message === payload.message && p.source === payload.source && p.view === payload.view
    );
    if (duplicate) {
      duplicate.fatal = Boolean(duplicate.fatal || payload.fatal);
      duplicate.component_stack ??= payload.component_stack;
    } else {
      queue.push(payload);
    }
    flushTimer ??= setTimeout(() => void flush(), FLUSH_DELAY_MS);
  } catch {
    // Reporting must never become the next error.
  }
}

/** Send everything queued right now (used before reloads and in tests). */
export async function flushFrontendErrors(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  await flush();
}

/** Reset queue, rate limit and transport state (tests). */
export function resetDiagnosticsState(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  queue = [];
  sentTimestamps = [];
  warnedUnavailable = false;
}

let installed: (() => void) | null = null;

/**
 * Forward `error` and `unhandledrejection` events of `target` to the local
 * log. Idempotent; returns a function that removes the listeners.
 */
export function installGlobalErrorHandlers(target: Window = window): () => void {
  if (installed) return installed;
  const onError = (event: ErrorEvent) => {
    const location = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    reportFrontendError({
      error: event.error ?? `${event.message}${location}`,
      source: "window.onerror",
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportFrontendError({ error: event.reason, source: "unhandledrejection" });
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  installed = () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    installed = null;
  };
  return installed;
}
