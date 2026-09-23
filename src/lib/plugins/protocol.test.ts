import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RpcClosedError,
  RpcEndpoint,
  RpcTimeoutError,
  assertPlainData,
  parseMessage,
  type RpcMessage,
  type RpcTransport,
} from "./protocol";

/** Two connected transports; messages are cloned and delivered asynchronously. */
function channel(): [RpcTransport & { sent: RpcMessage[] }, RpcTransport & { sent: RpcMessage[] }] {
  const listeners: [Set<(d: unknown) => void>, Set<(d: unknown) => void>] = [new Set(), new Set()];
  const make = (self: 0 | 1) => {
    const sent: RpcMessage[] = [];
    return {
      sent,
      post(message: RpcMessage) {
        sent.push(message);
        const copy = structuredClone(message);
        queueMicrotask(() => listeners[self === 0 ? 1 : 0].forEach((l) => l(copy)));
      },
      subscribe(handler: (d: unknown) => void) {
        listeners[self].add(handler);
        return () => listeners[self].delete(handler);
      },
    };
  };
  return [make(0), make(1)];
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RpcEndpoint", () => {
  it("correlates requests and responses by id", async () => {
    const [a, b] = channel();
    const client = new RpcEndpoint(a);
    new RpcEndpoint(b, {
      onRequest: async (method, params) => (method === "sum" ? (params as number[]).reduce((x, y) => x + y, 0) : null),
    });
    const [six, fifteen] = await Promise.all([client.request("sum", [1, 2, 3]), client.request("sum", [4, 5, 6])]);
    expect(six).toBe(6);
    expect(fifteen).toBe(15);
    expect(a.sent.map((m) => (m.kind === "request" ? m.id : -1))).toEqual([1, 2]);
    expect(client.pendingCount).toBe(0);
  });

  it("turns handler errors into rejected requests with the message", async () => {
    const [a, b] = channel();
    const client = new RpcEndpoint(a);
    new RpcEndpoint(b, {
      onRequest: () => {
        throw new Error("permission denied: nope");
      },
    });
    await expect(client.request("vault.read", ["x.md"])).rejects.toThrow("permission denied: nope");
  });

  it("answers unknown methods with an error when there is no handler", async () => {
    const [a, b] = channel();
    const client = new RpcEndpoint(a);
    new RpcEndpoint(b);
    await expect(client.request("anything")).rejects.toThrow('Unknown method "anything"');
  });

  it("times out after the given duration and ignores the late answer", async () => {
    vi.useFakeTimers();
    const [a] = channel();
    const client = new RpcEndpoint(a, {}, 10_000);
    const pending = client.request("slow");
    const assertion = expect(pending).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(client.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    await expect(pending).rejects.toThrow('"slow" did not answer within 10 s');
    expect(client.pendingCount).toBe(0);
  });

  it("uses a per-request timeout when given", async () => {
    vi.useFakeTimers();
    const [a] = channel();
    const client = new RpcEndpoint(a);
    const pending = client.request("ai.query", ["hi"], 180_000);
    const assertion = expect(pending).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(170_000);
    await assertion;
  });

  it("rejects pending requests on dispose and refuses new ones", async () => {
    const [a] = channel();
    const client = new RpcEndpoint(a);
    const pending = client.request("never");
    client.dispose("Plugin disabled");
    await expect(pending).rejects.toBeInstanceOf(RpcClosedError);
    await expect(pending).rejects.toThrow("Plugin disabled");
    await expect(client.request("again")).rejects.toThrow("Plugin disabled");
    expect(client.isClosed).toBe(true);
  });

  it("delivers events and logs to their handlers", async () => {
    const [a, b] = channel();
    const host = new RpcEndpoint(a);
    const onEvent = vi.fn();
    new RpcEndpoint(b, { onEvent });
    host.notify("note:opened", { path: "a.md", name: "a" });
    await Promise.resolve();
    await Promise.resolve();
    expect(onEvent).toHaveBeenCalledWith("note:opened", { path: "a.md", name: "a" });

    const onLog = vi.fn();
    new RpcEndpoint(a, { onLog });
    b.post({ kind: "log", level: "error", message: "boom" });
    await Promise.resolve();
    expect(onLog).toHaveBeenCalledWith({ kind: "log", level: "error", message: "boom" });
  });

  it("refuses to send values that do not survive postMessage", async () => {
    const [a] = channel();
    const client = new RpcEndpoint(a);
    await expect(client.request("x", [() => 1])).rejects.toThrow("params[0] cannot be sent");
    expect(a.sent).toHaveLength(0);
  });

  it("reports malformed incoming data instead of acting on it", async () => {
    const [a, b] = channel();
    const onInvalid = vi.fn();
    const onRequest = vi.fn();
    new RpcEndpoint(b, { onInvalid, onRequest });
    a.post({ kind: "request", id: -1, method: "x", params: [] } as unknown as RpcMessage);
    a.post({ kind: "bogus" } as unknown as RpcMessage);
    await Promise.resolve();
    expect(onInvalid).toHaveBeenCalledTimes(2);
    expect(onRequest).not.toHaveBeenCalled();
  });
});

describe("parseMessage", () => {
  it("accepts every well-formed kind", () => {
    expect(parseMessage({ kind: "request", id: 1, method: "vault.list", params: [] })).toEqual({
      kind: "request",
      id: 1,
      method: "vault.list",
      params: [],
    });
    expect(parseMessage({ kind: "response", id: 2, ok: true, result: [1] })).toMatchObject({ ok: true, result: [1] });
    expect(parseMessage({ kind: "response", id: 3, ok: false, error: "x" })).toMatchObject({ ok: false, error: "x" });
    expect(parseMessage({ kind: "event", name: "panel:action", payload: { actionId: "a" } })).toMatchObject({
      name: "panel:action",
    });
    expect(parseMessage({ kind: "log", level: "warn", message: "m" })).toMatchObject({ level: "warn" });
  });

  it("rejects malformed messages", () => {
    for (const bad of [
      null,
      "string",
      [],
      { kind: "request", id: "1", method: "x", params: [] },
      { kind: "request", id: 1, method: "", params: [] },
      { kind: "request", id: 1, method: "x", params: "nope" },
      { kind: "request", id: 1, method: "x", params: new Array(17).fill(0) },
      { kind: "response", id: 1 },
      { kind: "event", name: "" },
      { kind: "log", level: "debug", message: "m" },
    ]) {
      expect(parseMessage(bad)).toBeNull();
    }
  });

  it("truncates huge log lines", () => {
    const parsed = parseMessage({ kind: "log", level: "info", message: "x".repeat(10_000) });
    expect(parsed && parsed.kind === "log" && parsed.message.length).toBe(2000);
  });
});

describe("assertPlainData", () => {
  it("allows JSON-like data", () => {
    expect(() => assertPlainData({ a: [1, "b", true, null, { c: 2 }], skip: undefined })).not.toThrow();
  });

  it("rejects functions, class instances, cycles and non-finite numbers", () => {
    expect(() => assertPlainData({ f: () => 1 })).toThrow("value.f cannot be sent");
    expect(() => assertPlainData(new Date())).toThrow("plain object");
    expect(() => assertPlainData([Number.NaN])).toThrow("finite");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => assertPlainData(cycle)).toThrow("cycle");
  });
});
