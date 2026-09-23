import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listenMock(...args) }));

import { call, IpcUnavailableError, isDesktopRuntime, isMockRuntime, isTauriRuntime, listenSafe } from "./core";
import { mockEvents, setMockLatency } from "../mock/backend";

const win = window as unknown as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
  delete win.__TAURI_INTERNALS__;
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe("ipc core in a plain browser", () => {
  it("reports no runtime and throws IpcUnavailableError", async () => {
    expect(isTauriRuntime()).toBe(false);
    expect(isMockRuntime()).toBe(false);
    expect(isDesktopRuntime()).toBe(false);
    await expect(call("cmd_get_health")).rejects.toBeInstanceOf(IpcUnavailableError);
  });

  it("listenSafe resolves to a no-op unlisten and never throws", async () => {
    const unlisten = await listenSafe("llm-stream-chunk", () => undefined);
    expect(typeof unlisten).toBe("function");
    expect(() => unlisten()).not.toThrow();
    expect(listenMock).not.toHaveBeenCalled();
  });
});

describe("ipc core in mock mode", () => {
  it("routes calls to the mock backend and normalises errors", async () => {
    vi.stubEnv("VITE_AETHER_MOCK", "1");
    setMockLatency(0);
    expect(isMockRuntime()).toBe(true);
    expect(isDesktopRuntime()).toBe(true);
    await expect(call<string[]>("cmd_list_local_models")).resolves.toContain("qwen2.5:7b");
    const failure = call("cmd_get_note_content", { path: "/missing.md" });
    await expect(failure).rejects.toBeInstanceOf(Error);
    await expect(failure).rejects.toThrow(/failed to read \/missing\.md/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("delivers mock events through listenSafe until unlistened", async () => {
    vi.stubEnv("VITE_AETHER_MOCK", "1");
    const received: string[] = [];
    const unlisten = await listenSafe<string>("llm-stream-chunk", (p) => received.push(p));
    mockEvents.emit("llm-stream-chunk", "Hallo ");
    unlisten();
    mockEvents.emit("llm-stream-chunk", "ignored");
    expect(received).toEqual(["Hallo "]);
  });
});

describe("ipc core in the Tauri runtime", () => {
  it("prefers Tauri over the mock and rethrows string errors as Error", async () => {
    vi.stubEnv("VITE_AETHER_MOCK", "1");
    win.__TAURI_INTERNALS__ = {};
    expect(isTauriRuntime()).toBe(true);
    expect(isMockRuntime()).toBe(false);

    invokeMock.mockResolvedValueOnce(["llama3"]);
    await expect(call("cmd_list_local_models")).resolves.toEqual(["llama3"]);
    expect(invokeMock).toHaveBeenCalledWith("cmd_list_local_models", undefined);

    invokeMock.mockRejectedValueOnce("vault error: boom");
    await expect(call("cmd_get_vault_notes")).rejects.toThrow("vault error: boom");
  });

  it("unwraps event payloads for listenSafe", async () => {
    win.__TAURI_INTERNALS__ = {};
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_event: string, cb: (e: { payload: string }) => void) => {
      cb({ payload: "chunk" });
      return unlisten;
    });
    const handler = vi.fn();
    await expect(listenSafe("llm-stream-chunk", handler)).resolves.toBe(unlisten);
    expect(handler).toHaveBeenCalledWith("chunk");
  });
});
