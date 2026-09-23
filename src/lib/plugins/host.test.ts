import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginHost, pluginShortcutProblem } from "./host";
import { inProcessWorkerDeps } from "./testHarness";
import { resetPluginsStoreForTests, usePluginsStore } from "../pluginsStore";
import { useAetherStore } from "../store";
import { getCommands } from "../commands/registry";
import { mockEvents, mockHandlers, resetMockState, setMockLatency } from "../mock/backend";
import { mockVault } from "../mock/vaultStore";
import { MOCK_VAULT_ROOT } from "../mock/fixtures/vault";
import { localDate } from "../mock/runtime";

const WORD_COUNT = "aether.word-count";
const DAILY_REVIEW = "aether.daily-review";
const RANDOM_NOTE = "aether.random-note";

let host: PluginHost | null = null;
let deps: ReturnType<typeof inProcessWorkerDeps>;
const today = () => localDate(new Date());
const dailyPath = () => `${MOCK_VAULT_ROOT}/daily/${today()}.md`;
const store = () => usePluginsStore.getState();

async function startHost(): Promise<PluginHost> {
  deps = inProcessWorkerDeps();
  host = new PluginHost(deps);
  await host.start();
  return host;
}

async function waitForCommand(id: string) {
  await vi.waitFor(() => expect(getCommands().some((c) => c.id === id)).toBe(true));
  return getCommands().find((c) => c.id === id)!;
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
    agentOutput: "",
    view: "dashboard",
  });
});

afterEach(async () => {
  await host?.shutdown();
  host = null;
  vi.unstubAllEnvs();
});

describe("PluginHost with the bundled examples", () => {
  it("installs the examples, starts enabled plugins and shows word counts", async () => {
    useAetherStore.setState({ selectedNotePath: dailyPath() });
    const running = await startHost();

    expect(store().plugins.map((p) => p.manifest.id)).toEqual([DAILY_REVIEW, RANDOM_NOTE, WORD_COUNT]);
    await vi.waitFor(() => expect(store().runtime[WORD_COUNT]?.status).toBe("running"));
    expect(running.runningIds).toEqual([WORD_COUNT]);
    await vi.waitFor(() => expect(store().statusItems[WORD_COUNT]?.text).toMatch(/^\d[\d,]* words · (\d+|< 1) min$/));
    expect(store().panels[WORD_COUNT]?.[0]).toEqual({ type: "heading", text: today(), level: 2 });
    expect(store().panels[WORD_COUNT]?.some((n) => n.type === "list")).toBe(true);

    // The hardened bootstrap really ran in the worker.
    const worker = deps.workers.get(WORD_COUNT)!;
    expect(worker.scope.fetch).toBeUndefined();
    expect(worker.scope.indexedDB).toBeUndefined();
  });

  it("forwards note:opened so plugins follow the open note", async () => {
    await startHost();
    await vi.waitFor(() => expect(store().runtime[WORD_COUNT]?.status).toBe("running"));
    expect(store().statusItems[WORD_COUNT]).toBeUndefined();

    const note = mockVault.list().find((n) => !n.path.includes("/daily/"))!;
    useAetherStore.getState().selectNote(note.path);
    await vi.waitFor(() => expect(store().panels[WORD_COUNT]?.[0]).toMatchObject({ type: "heading", text: note.name }));
    expect(store().statusItems[WORD_COUNT]?.tooltip).toContain(note.name);
  });

  it("stops the worker and removes its contributions when disabled", async () => {
    useAetherStore.setState({ selectedNotePath: dailyPath() });
    const running = await startHost();
    await vi.waitFor(() => expect(store().statusItems[WORD_COUNT]).toBeDefined());

    await store().setEnabled(WORD_COUNT, false);
    await vi.waitFor(() => expect(deps.workers.get(WORD_COUNT)!.terminated).toBe(true));
    expect(running.runningIds).not.toContain(WORD_COUNT);
    expect(store().statusItems[WORD_COUNT]).toBeUndefined();
    expect(store().panels[WORD_COUNT]).toBeUndefined();
    expect(store().runtime[WORD_COUNT]?.status).toBe("stopped");
  });

  it("registers plugin commands under Plugins and rejects calls without permission", async () => {
    const running = await startHost();
    await store().grantAndEnable(RANDOM_NOTE, ["ui:commands"]);
    const command = await waitForCommand(`plugin:${RANDOM_NOTE}:open`);
    expect(command.group).toBe("Plugins");
    expect(command.title).toBe("Open random note");
    expect(store().commands[RANDOM_NOTE]).toEqual([{ id: "open", title: "Open random note", shortcut: "mod+alt+shift+o" }]);

    await expect(running.runCommand(RANDOM_NOTE, "open")).rejects.toThrow(
      `permission denied: plugin "${RANDOM_NOTE}" has not been granted "vault:read"`
    );
    expect(useAetherStore.getState().view).toBe("dashboard");
  });

  it("opens a random note once vault:read is granted", async () => {
    const running = await startHost();
    await store().grantAndEnable(RANDOM_NOTE, ["vault:read", "ui:commands"]);
    await waitForCommand(`plugin:${RANDOM_NOTE}:open`);
    await running.runCommand(RANDOM_NOTE, "open");
    const selected = useAetherStore.getState().selectedNotePath!;
    expect(selected.startsWith(`${MOCK_VAULT_ROOT}/`)).toBe(true);
    expect(selected).not.toContain("/daily/");
    expect(useAetherStore.getState().view).toBe("editor");

    await store().setEnabled(RANDOM_NOTE, false);
    await vi.waitFor(() => expect(getCommands().some((c) => c.id === `plugin:${RANDOM_NOTE}:open`)).toBe(false));
  });

  it("daily review asks the AI with today's note and writes ## Review", async () => {
    const original = mockHandlers.cmd_agent_query_with_notes;
    const calls: unknown[] = [];
    mockHandlers.cmd_agent_query_with_notes = async (args) => {
      calls.push(args.notePaths);
      expect(useAetherStore.getState().busy).toBe(true);
      mockEvents.emit("llm-stream-chunk", "- Shipped the plugin host\n");
      mockEvents.emit("llm-stream-chunk", "- Tomorrow: write the docs");
    };
    try {
      const running = await startHost();
      await store().grantAndEnable(DAILY_REVIEW, ["vault:read", "vault:write", "ai:query", "ui:commands"]);
      await waitForCommand(`plugin:${DAILY_REVIEW}:run`);
      await running.runCommand(DAILY_REVIEW, "run");

      expect(calls).toEqual([[dailyPath()]]);
      const content = mockVault.read(dailyPath());
      expect(content).toContain("## Review\n\n- Shipped the plugin host\n- Tomorrow: write the docs\n");
      expect(content).toContain("## Focus");
      expect(useAetherStore.getState().busy).toBe(false);
      expect(useAetherStore.getState().agentOutput).toBe("");
      expect(useAetherStore.getState().selectedNotePath).toBe(dailyPath());

      // Running it again replaces the review instead of adding a second one.
      await running.runCommand(DAILY_REVIEW, "run");
      expect(mockVault.read(dailyPath()).match(/## Review/g)).toHaveLength(1);
    } finally {
      mockHandlers.cmd_agent_query_with_notes = original;
    }
  });

  it("refuses AI queries while the agent panel is answering", async () => {
    const running = await startHost();
    await store().grantAndEnable(DAILY_REVIEW, ["vault:read", "vault:write", "ai:query", "ui:commands"]);
    await waitForCommand(`plugin:${DAILY_REVIEW}:run`);
    useAetherStore.setState({ busy: true });
    await expect(running.runCommand(DAILY_REVIEW, "run")).rejects.toThrow("The AI agent is busy");
    expect(useAetherStore.getState().busy).toBe(true);
  });

  it("fetches through the backend for plugins with a net:fetch grant", async () => {
    await startHost();
    const info = await store().install("/Users/demo/Downloads/github-zen");
    expect(info.enabled).toBe(false);
    await store().grantAndEnable(info.manifest.id, info.manifest.permissions);
    await vi.waitFor(() =>
      expect(store().panels[info.manifest.id]?.find((n) => n.type === "markdown")).toMatchObject({
        content: "> Design for failure.",
      })
    );
  });

  it("reports activation failures and does not retry them until restarted", async () => {
    const original = mockHandlers.cmd_plugins_read_source;
    mockHandlers.cmd_plugins_read_source = () => "export const notAPlugin = true;";
    try {
      const running = await startHost();
      await vi.waitFor(() => expect(store().runtime[WORD_COUNT]?.status).toBe("error"));
      expect(store().runtime[WORD_COUNT]?.error).toBe("Activation failed: main.js must export an activate(api) function");
      expect(running.runningIds).toEqual([]);
      const failedWorker = deps.workers.get(WORD_COUNT)!;
      expect(failedWorker.terminated).toBe(true);
      await running.reconcile(store().plugins);
      expect(deps.workers.get(WORD_COUNT)).toBe(failedWorker);

      mockHandlers.cmd_plugins_read_source = original;
      await running.restart(WORD_COUNT);
      await vi.waitFor(() => expect(store().runtime[WORD_COUNT]?.status).toBe("running"));
    } finally {
      mockHandlers.cmd_plugins_read_source = original;
    }
  });
});

describe("pluginShortcutProblem", () => {
  it("refuses plain keys and shortcuts that already belong to a command", () => {
    expect(pluginShortcutProblem("k", "plugin:x:y")).toContain("needs a modifier");
    expect(pluginShortcutProblem("mod+k", "plugin:x:y")).toContain('already used by "Command palette"');
    expect(pluginShortcutProblem("mod+alt+shift+9", "plugin:x:y")).toBeNull();
    expect(pluginShortcutProblem("mod+", "plugin:x:y")).toContain("no key");
  });
});
