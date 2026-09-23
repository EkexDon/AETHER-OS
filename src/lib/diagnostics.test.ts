import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrontendErrorPayload } from "../types";
import {
  buildErrorReport,
  describeError,
  flushFrontendErrors,
  installGlobalErrorHandlers,
  reportFrontendError,
  resetDiagnosticsState,
  setErrorSender,
  toErrorPayload,
} from "./diagnostics";

let sent: FrontendErrorPayload[];
let restoreSender: ReturnType<typeof setErrorSender>;

beforeEach(() => {
  vi.useFakeTimers();
  resetDiagnosticsState();
  sent = [];
  restoreSender = setErrorSender(async (payload) => {
    sent.push(payload);
  });
});

afterEach(() => {
  setErrorSender(restoreSender);
  resetDiagnosticsState();
  vi.useRealTimers();
});

describe("frontend diagnostics", () => {
  it("describes errors, strings and arbitrary values", () => {
    expect(describeError(new TypeError("bad"))).toMatchObject({ message: "bad" });
    expect(describeError("plain")).toEqual({ message: "plain", stack: null });
    expect(describeError({ code: 7 })).toEqual({ message: '{"code":7}', stack: null });
  });

  it("builds the IPC payload and a copyable report", () => {
    const input = { error: new Error("boom"), componentStack: "\n    at Editor", view: "Editor", source: "boundary", fatal: true };
    expect(toErrorPayload(input)).toMatchObject({
      message: "boom",
      component_stack: "at Editor",
      view: "Editor",
      source: "boundary",
      fatal: true,
    });
    const report = buildErrorReport(input, new Date("2026-09-22T10:00:00Z"));
    expect(report).toContain("time: 2026-09-22T10:00:00.000Z");
    expect(report).toContain("message: boom");
    expect(report).toContain("component stack:");
  });

  it("batches, de-duplicates and lets a fatal duplicate win", async () => {
    reportFrontendError({ error: new Error("same"), source: "boundary", view: "Graph" });
    reportFrontendError({ error: new Error("same"), source: "boundary", view: "Graph", fatal: true });
    reportFrontendError({ error: new Error("other"), source: "window.onerror" });
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent.map((p) => p.message)).toEqual(["same", "other"]);
    expect(sent[0].fatal).toBe(true);
  });

  it("ignores browser noise and rate-limits floods", async () => {
    reportFrontendError({ error: "ResizeObserver loop completed with undelivered notifications.", source: "window.onerror" });
    const canceled = new Error("Canceled");
    canceled.name = "Canceled";
    reportFrontendError({ error: canceled, source: "unhandledrejection" });
    for (let i = 0; i < 50; i++) reportFrontendError({ error: `flood ${i}`, source: "window.onerror" });
    await flushFrontendErrors();
    expect(sent).toHaveLength(20);
    expect(sent.every((p) => p.message.startsWith("flood"))).toBe(true);
  });

  it("never throws when the transport fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setErrorSender(async () => {
      throw new Error("backend down");
    });
    expect(() => reportFrontendError({ error: "x", source: "test" })).not.toThrow();
    await expect(flushFrontendErrors()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("forwards window errors and unhandled rejections", async () => {
    const uninstall = installGlobalErrorHandlers(window);
    expect(installGlobalErrorHandlers(window)).toBe(uninstall);
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("uncaught"), message: "uncaught" }));
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("rejected");
    window.dispatchEvent(rejection);
    await flushFrontendErrors();
    expect(sent).toEqual([
      expect.objectContaining({ message: "uncaught", source: "window.onerror", fatal: false }),
      expect.objectContaining({ message: "rejected", source: "unhandledrejection" }),
    ]);
    uninstall();
    window.dispatchEvent(new ErrorEvent("error", { message: "after uninstall" }));
    await flushFrontendErrors();
    expect(sent).toHaveLength(2);
  });
});
