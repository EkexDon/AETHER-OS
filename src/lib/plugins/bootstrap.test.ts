import { describe, expect, it } from "vitest";
import { REMOVED_GLOBALS, REMOVED_NAVIGATOR_MEMBERS, WORKER_RUNTIME_SOURCE, buildHardening, buildWorkerBootstrap } from "./bootstrap";
import { InProcessWorker, evaluatePluginModule } from "./testHarness";
import { parseMessage, type RpcMessage } from "./protocol";

describe("generated bootstrap", () => {
  it("removes network, storage and worker APIs before the runtime starts", () => {
    const source = buildWorkerBootstrap({ permissions: ["vault:read"] });
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "indexedDB"]) {
      expect(source).toContain(`"${name}"`);
    }
    for (const name of REMOVED_GLOBALS) expect(source).toContain(`"${name}"`);
    for (const name of REMOVED_NAVIGATOR_MEMBERS) expect(source).toContain(`"${name}"`);
    // Hardening comes first, then the runtime, then the start call.
    const hardening = source.indexOf("aetherHarden");
    const runtime = source.indexOf("function aetherPluginRuntime");
    const start = source.lastIndexOf("aetherPluginRuntime(self");
    expect(hardening).toBeGreaterThan(-1);
    expect(hardening).toBeLessThan(runtime);
    expect(runtime).toBeLessThan(start);
    expect(source).toContain('"installFetchShim":false');
    expect(source).toContain('remove(scope, "fetch", true)');
  });

  it("replaces fetch with a host-routed shim only for net:fetch grants", () => {
    const source = buildWorkerBootstrap({ permissions: ["net:fetch:api.github.com"] });
    expect(source).toContain('"installFetchShim":true');
    expect(source).toContain('remove(scope, "fetch", false)');
    expect(buildHardening(["ui:panel"])).toContain('remove(scope, "fetch", true)');
  });

  it("really deletes the globals, including inherited ones, and locks them", () => {
    const proto = { fetch: () => "native", indexedDB: {} };
    const scope = Object.create(proto) as Record<string, unknown>;
    scope.XMLHttpRequest = class {};
    scope.WebSocket = class {};
    scope.importScripts = () => undefined;
    scope.navigator = { storage: {}, locks: {} };
    new Function("self", buildHardening([]))(scope);
    for (const name of ["fetch", "indexedDB", "XMLHttpRequest", "WebSocket", "importScripts"]) {
      expect(scope[name], name).toBeUndefined();
      expect(() => {
        "use strict";
        scope[name] = () => "restored";
      }).toThrow();
    }
    expect("fetch" in proto).toBe(false);
    expect((scope.navigator as Record<string, unknown>).storage).toBeUndefined();
  });

  it("the runtime file is self-contained plain JavaScript", () => {
    expect(WORKER_RUNTIME_SOURCE).toContain("function aetherPluginRuntime(scope, options)");
    expect(WORKER_RUNTIME_SOURCE).not.toMatch(/^\s*import\s/m);
    expect(WORKER_RUNTIME_SOURCE).not.toMatch(/^\s*export\s/m);
  });
});

/** Collect what the worker posts to the host. */
function collect(worker: InProcessWorker): RpcMessage[] {
  const out: RpcMessage[] = [];
  worker.addEventListener("message", ((event: MessageEvent) => {
    const message = parseMessage(event.data);
    if (message) out.push(message);
  }) as never);
  return out;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("worker runtime", () => {
  it("activates a plugin module and turns api calls into typed requests", async () => {
    const plugin = `export async function activate(api) {
      api.events.on("panel:action", (e) => api.ui.toast("clicked " + e.actionId));
      await api.vault.read("notes/a.md");
    }`;
    const worker = new InProcessWorker(buildWorkerBootstrap({ permissions: ["vault:read"] }));
    const sent = collect(worker);
    expect(worker.scope.fetch).toBeUndefined();
    expect(worker.scope.XMLHttpRequest).toBeUndefined();

    worker.postMessage({ kind: "request", id: 1, method: "activate", params: [{ source: plugin, plugin: { id: "p", name: "P", version: "1.0.0", permissions: ["vault:read"] } }] });
    await tick();
    const read = sent.find((m) => m.kind === "request" && m.method === "vault.read");
    expect(read).toMatchObject({ kind: "request", method: "vault.read", params: ["notes/a.md"] });

    // The host answers; activation then completes.
    worker.postMessage({ kind: "response", id: (read as { id: number }).id, ok: true, result: "# A" });
    await tick();
    expect(sent.find((m) => m.kind === "response" && m.id === 1)).toMatchObject({ ok: true });

    worker.postMessage({ kind: "event", name: "panel:action", payload: { actionId: "go" } });
    await tick();
    expect(sent.find((m) => m.kind === "request" && m.method === "ui.toast")).toMatchObject({ params: ["clicked go", "info"] });
  });

  it("reports a missing activate export as an activation error", async () => {
    const worker = new InProcessWorker(buildWorkerBootstrap({ permissions: [] }));
    const sent = collect(worker);
    worker.postMessage({ kind: "request", id: 7, method: "activate", params: [{ source: "export const x = 1;" }] });
    await tick();
    expect(sent.find((m) => m.kind === "response" && m.id === 7)).toMatchObject({
      ok: false,
      error: "main.js must export an activate(api) function",
    });
  });

  it("runs registered commands on command.run and reports their errors", async () => {
    const plugin = `export async function activate(api) {
      await api.commands.register({ id: "boom", title: "Boom", run: () => { throw new Error("kaput"); } });
    }`;
    const worker = new InProcessWorker(buildWorkerBootstrap({ permissions: ["ui:commands"] }));
    const sent = collect(worker);
    worker.postMessage({ kind: "request", id: 1, method: "activate", params: [{ source: plugin }] });
    await tick();
    const register = sent.find((m) => m.kind === "request" && m.method === "commands.register") as { id: number; params: unknown[] };
    expect(register.params).toEqual([{ id: "boom", title: "Boom", shortcut: null }]);
    worker.postMessage({ kind: "response", id: register.id, ok: true, result: null });
    await tick();
    worker.postMessage({ kind: "request", id: 2, method: "command.run", params: ["boom"] });
    await tick();
    expect(sent.find((m) => m.kind === "response" && m.id === 2)).toMatchObject({ ok: false, error: "kaput" });
  });

  it("gives net:fetch plugins a GET-only fetch shim routed through the host", async () => {
    const worker = new InProcessWorker(buildWorkerBootstrap({ permissions: ["net:fetch:api.github.com"] }));
    const sent = collect(worker);
    const shim = worker.scope.fetch as (url: string, init?: object) => Promise<Response>;
    expect(typeof shim).toBe("function");
    await expect(shim("https://api.github.com/", { method: "POST" })).rejects.toThrow("GET");
    const pending = shim("https://api.github.com/zen");
    await tick();
    const request = sent.find((m) => m.kind === "request" && m.method === "net.fetch") as { id: number; params: unknown[] };
    expect(request.params).toEqual(["https://api.github.com/zen"]);
    worker.postMessage({
      kind: "response",
      id: request.id,
      ok: true,
      result: { url: "https://api.github.com/zen", status: 200, ok: true, contentType: "text/plain", body: "Keep it simple." },
    });
    const response = await pending;
    expect(await response.text()).toBe("Keep it simple.");
  });
});

describe("evaluatePluginModule (test harness)", () => {
  it("exposes the exported functions of example-style modules", () => {
    const mod = evaluatePluginModule("const x = 2;\nexport function double(n) { return n * x; }\nexport async function activate() {}");
    expect((mod.double as (n: number) => number)(4)).toBe(8);
    expect(typeof mod.activate).toBe("function");
  });
});
