/**
 * Host-side hardening of the plugin RPC: every call is rate-limited,
 * permission-checked and size-checked before anything reaches IPC, worker
 * failures land in the plugin's own log, and `api.notes.open` only opens
 * notes that exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginHost } from "./host";
import { CallRateLimiter } from "./limits";
import { inProcessWorkerDeps } from "./testHarness";
import { resetPluginsStoreForTests, usePluginsStore } from "../pluginsStore";
import { useAetherStore } from "../store";
import { mockHandlers, resetMockState, setMockLatency } from "../mock/backend";
import { mockVault } from "../mock/vaultStore";
import { MOCK_VAULT_ROOT } from "../mock/fixtures/vault";

/** Word Count is enabled in the mock with vault:read, ui:statusbar and ui:panel granted. */
const PLUGIN = "aether.word-count";

let host: PluginHost | null = null;
let deps: ReturnType<typeof inProcessWorkerDeps>;
const store = () => usePluginsStore.getState();
const originals = { ...mockHandlers };

/** Run `body` as the plugin's `activate(api)`; it reports lines through its panel. */
function pluginSource(body: string): string {
  return `export async function activate(api) {
  const results = [];
  const attempt = async (label, fn) => {
    try { await fn(); results.push(label + ": ok"); }
    catch (e) { results.push(label + ": " + e.message); }
  };
  ${body}
  await api.ui.panel.set(results.map((text) => ({ type: "text", text: text.slice(0, 2000) })));
}`;
}

async function runPlugin(body: string, rateLimiter?: () => CallRateLimiter): Promise<string[]> {
  mockHandlers.cmd_plugins_read_source = () => pluginSource(body);
  deps = inProcessWorkerDeps(undefined, rateLimiter ? { createRateLimiter: rateLimiter } : {});
  host = new PluginHost(deps);
  await host.start();
  await vi.waitFor(() => expect(store().runtime[PLUGIN]?.status).toBe("running"));
  const panel = store().panels[PLUGIN] ?? [];
  return panel.map((node) => (node.type === "text" ? node.text : ""));
}

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  resetPluginsStoreForTests();
  useAetherStore.setState({
    vaultPath: MOCK_VAULT_ROOT,
    vaultNotes: mockVault.list(),
    selectedNotePath: null,
    noteContent: null,
    noteDirty: false,
    busy: false,
    view: "dashboard",
  });
});

afterEach(async () => {
  await host?.shutdown();
  host = null;
  Object.assign(mockHandlers, originals);
  vi.unstubAllEnvs();
});

describe("plugin RPC hardening", () => {
  it("checks permissions before any IPC call", async () => {
    const write = vi.fn(originals.cmd_plugins_vault_write);
    const fetch = vi.fn(originals.cmd_plugins_fetch);
    mockHandlers.cmd_plugins_vault_write = write;
    mockHandlers.cmd_plugins_fetch = fetch;
    const lines = await runPlugin(`
      await attempt("write", () => api.vault.write("Inbox.md", "hi"));
      await attempt("big-write", () => api.vault.write("Inbox.md", "x".repeat(7000000)));
      await attempt("fetch", () => api.net.fetch("https://example.com"));
      await attempt("clipboard", () => api.clipboard.readText());
    `);
    expect(lines).toEqual([
      `write: permission denied: plugin "${PLUGIN}" has not been granted "vault:write"`,
      `big-write: permission denied: plugin "${PLUGIN}" has not been granted "vault:write"`,
      `fetch: permission denied: plugin "${PLUGIN}" has not been granted "net:fetch:<host>"`,
      `clipboard: permission denied: plugin "${PLUGIN}" has not been granted "clipboard:read"`,
    ]);
    expect(write).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses payloads above the size cap without reaching IPC", async () => {
    const set = vi.fn(originals.cmd_plugins_storage_set);
    mockHandlers.cmd_plugins_storage_set = set;
    const lines = await runPlugin(`
      await attempt("big", () => api.storage.set("k", "x".repeat(1100000)));
      await attempt("nested", () => api.storage.set("k", Array.from({ length: 2000 }, () => "y".repeat(600))));
      await attempt("small", () => api.storage.set("k", { ok: true }));
    `);
    expect(lines).toEqual([
      "big: storage.set: the payload is larger than 1 MB",
      "nested: storage.set: the payload is larger than 1 MB",
      "small: ok",
    ]);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("rate-limits each plugin before touching IPC and says so in its log", async () => {
    const get = vi.fn(originals.cmd_plugins_storage_get);
    mockHandlers.cmd_plugins_storage_get = get;
    mockHandlers.cmd_plugins_read_source = () =>
      "export async function activate(api) { for (let i = 0; i < 6; i++) await api.storage.get('k'); }";
    deps = inProcessWorkerDeps(undefined, { createRateLimiter: () => new CallRateLimiter(3, 0.001) });
    host = new PluginHost(deps);
    await host.start();
    await vi.waitFor(() => expect(store().runtime[PLUGIN]?.status).toBe("error"));
    expect(get).toHaveBeenCalledTimes(3);
    expect(store().runtime[PLUGIN]?.error).toMatch(/^Activation failed: Too many API calls — at most 100 per second/);
    expect(store().logs[PLUGIN]?.some((l) => l.level === "warn" && l.message.startsWith("Rate limited"))).toBe(true);
  });

  it("gives every plugin its own budget", async () => {
    const lines = await runPlugin(
      `for (let i = 0; i < 4; i++) await attempt("get" + i, () => api.storage.get("k"));`,
      () => new CallRateLimiter(5, 0.001)
    );
    // Four gets + the panel.set that reports them fit a budget of five.
    expect(lines).toEqual(["get0: ok", "get1: ok", "get2: ok", "get3: ok"]);
  });

  it("only opens notes that exist in the vault", async () => {
    const note = mockVault.list().find((n) => n.path.endsWith(".md"))!;
    const rel = note.path.slice(MOCK_VAULT_ROOT.length + 1);
    const lines = await runPlugin(`
      await attempt("missing", () => api.notes.open("nope/missing.md"));
      await attempt("escape", () => api.notes.open("../outside.md"));
      await attempt("absolute", () => api.notes.open("/etc/passwd.md"));
      await attempt("not-a-note", () => api.notes.open("assets/diagram.png"));
      await attempt("real", () => api.notes.open(${JSON.stringify(rel)}));
    `);
    expect(lines[0]).toBe("missing: note not found: nope/missing.md");
    expect(lines[1]).toContain('escape: invalid vault path "../outside.md"');
    expect(lines[2]).toContain('absolute: invalid vault path "/etc/passwd.md"');
    expect(lines[3]).toContain("not-a-note: invalid vault path");
    expect(lines[4]).toBe("real: ok");
    expect(useAetherStore.getState().selectedNotePath).toBe(note.path);
    expect(useAetherStore.getState().view).toBe("editor");
  });

  it("records worker failures in the plugin's own log", async () => {
    await runPlugin("");
    const worker = deps.workers.get(PLUGIN)!;
    worker.fail("boom");
    worker.failMessage();
    worker.emitRaw({ kind: "nonsense" });
    await vi.waitFor(() => expect(store().logs[PLUGIN]?.length ?? 0).toBeGreaterThanOrEqual(3));
    const messages = store().logs[PLUGIN]!.map((l) => `${l.level}:${l.message}`);
    expect(messages).toContain("error:Uncaught error: boom");
    expect(messages.some((m) => m.startsWith("error:A message from the plugin worker could not be read"))).toBe(true);
    expect(messages).toContain("warn:Ignored a malformed message from the plugin worker");
    // Still running: one bad message does not take the plugin down.
    expect(store().runtime[PLUGIN]?.status).toBe("running");
  });
});
