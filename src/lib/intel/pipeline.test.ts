import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockState, setMockLatency } from "../mock/backend";
import { MOCK_VAULT_ROOT } from "../mock/fixtures/vault";
import { mockVault } from "../mock/vaultStore";
import { listAgentAudit } from "../ipc";
import { ALLOW_RULES_KEY, DEFAULT_INTEL_SETTINGS, useIntelStore } from "../intelStore";
import { useAetherStore } from "../store";
import { openConversation, startNewConversation } from "../agentChatBus";
import { canCompact, compactSession, persistSession, processAgentActions, sessionTokens, shouldAutoCompact } from "./pipeline";

const QUICK_CAPTURE = `${MOCK_VAULT_ROOT}/00-Inbox/Quick Capture.md`;

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function longTurn(i: number): [string, string] {
  return [`Question ${i}? ${"detail ".repeat(60)}`, `Answer ${i}. ${"word ".repeat(80)}`];
}

beforeEach(() => {
  vi.stubEnv("VITE_AETHER_MOCK", "1");
  setMockLatency(0);
  resetMockState();
  localStorage.clear();
  useIntelStore.setState({
    settings: { ...DEFAULT_INTEL_SETTINGS },
    settingsLoaded: true,
    session: { conversationId: null, messages: [], compaction: null },
    runs: [],
    approvals: [],
    allowRules: [],
    compacting: false,
    related: {},
  });
  useAetherStore.setState({ conversations: [], chatOpen: false, busy: false, selectedNotePath: null, openNoteTabs: [] });
});

afterEach(() => {
  useIntelStore.getState().denyAll();
  vi.unstubAllEnvs();
});

describe("processAgentActions", () => {
  it("runs safe actions immediately and audits them", async () => {
    const [run] = await processAgentActions([{ action: "append_daily", content: "from the test" }]);
    expect(run.status).toBe("done");
    expect(run.message).toMatch(/daily note/);
    const audit = await listAgentAudit(10);
    expect(audit[0]).toMatchObject({ action: "append_daily", status: "ok", risk: "safe" });
  });

  it("waits for approval before a dangerous action and executes it after approve", async () => {
    const done = processAgentActions([{ action: "delete_note", path: "Quick Capture" }]);
    await until(() => useIntelStore.getState().approvals.length === 1);
    expect(useIntelStore.getState().runs[0].status).toBe("awaiting");
    expect(mockVault.hasFile(QUICK_CAPTURE)).toBe(true);

    useIntelStore.getState().resolveApproval(useIntelStore.getState().approvals[0].runId, "approved");
    const [run] = await done;
    expect(run.status).toBe("done");
    expect(mockVault.hasFile(QUICK_CAPTURE)).toBe(false);
    expect(mockVault.list().some((n) => n.path.includes("/.trash/"))).toBe(false); // hidden from the vault scan
    const audit = await listAgentAudit(5);
    expect(audit[0]).toMatchObject({ action: "delete_note", status: "ok", risk: "dangerous" });
  });

  it("records denials and changes nothing", async () => {
    const done = processAgentActions([{ action: "delete_note", path: "Quick Capture" }]);
    await until(() => useIntelStore.getState().approvals.length === 1);
    useIntelStore.getState().denyAll();
    const [run] = await done;
    expect(run.status).toBe("denied");
    expect(mockVault.hasFile(QUICK_CAPTURE)).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // the denial is recorded in the background
    const audit = await listAgentAudit(5);
    expect(audit.some((e) => e.action === "delete_note" && e.status === "denied")).toBe(true);
  });

  it("queues every gated action of a reply so Approve all works, keeping order", async () => {
    const done = processAgentActions([
      { action: "append_daily", content: "first" },
      { action: "run_command", command: "pwd", cwd: null },
      { action: "toggle_vault_task", note_path: "Ideen fürs Wochenende", line: 9 },
    ]);
    // Both gated actions are queued at once; the safe one runs meanwhile.
    await until(() => useIntelStore.getState().approvals.length === 2);
    await until(() => useIntelStore.getState().runs[0].status === "done");
    expect(useIntelStore.getState().runs[1].status).toBe("awaiting");
    useIntelStore.getState().approveAll();
    const runs = await done;
    expect(runs.map((r) => r.status)).toEqual(["done", "done", "done"]);
    expect(runs[1].output?.stdout.trim()).toBe(MOCK_VAULT_ROOT);
    expect(runs[2].message).toMatch(/^Checked /);
  });

  it("reports failures without stopping later actions", async () => {
    const runs = await processAgentActions([
      { action: "create_task", title: "", priority: "high" },
      { action: "create_task", title: "Ship v0.2" },
    ]);
    expect(runs[0].status).toBe("error");
    expect(runs[0].message).toMatch(/title is required/);
    expect(runs[1].status).toBe("done");
    expect(runs[1].message).toBe('Task "Ship v0.2" added to Inbox');
  });

  it("remembers allow rules: session-only for dangerous, persisted for confirm", async () => {
    const first = processAgentActions([
      { action: "run_command", command: "ls", cwd: null },
      { action: "run_command", command: "pwd", cwd: null },
    ]);
    await until(() => useIntelStore.getState().approvals.length === 2);
    useIntelStore.getState().resolveApproval(useIntelStore.getState().approvals[0].runId, "approved", true);
    expect(useIntelStore.getState().approvals).toHaveLength(0);
    expect((await first).map((r) => r.status)).toEqual(["done", "done"]);

    // Later commands in the vault run without asking.
    const [again] = await processAgentActions([{ action: "run_command", command: "whoami", cwd: null }]);
    expect(again.status).toBe("done");
    expect(JSON.parse(localStorage.getItem(ALLOW_RULES_KEY) ?? "[]")).toEqual([]);

    const move = processAgentActions([{ action: "move_note", from: "Reading List", to: "04-Archive/" }]);
    await until(() => useIntelStore.getState().approvals.length === 1);
    useIntelStore.getState().resolveApproval(useIntelStore.getState().approvals[0].runId, "approved", true);
    expect((await move)[0].status).toBe("done");
    const persisted = JSON.parse(localStorage.getItem(ALLOW_RULES_KEY) ?? "[]");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ kind: "move_note", risk: "confirm" });
  });
});

describe("compaction", () => {
  it("summarises everything but the kept window and persists the summary", async () => {
    const store = useIntelStore.getState();
    for (let i = 0; i < 5; i++) store.appendTurn(...longTurn(i));
    expect(canCompact()).toBe(true);
    const before = sessionTokens();

    const result = await compactSession("gemma2:2b", "ollama");
    expect(result?.dropped_count).toBe(6);
    const { session } = useIntelStore.getState();
    expect(session.compaction?.compactedCount).toBe(6);
    expect(session.messages).toHaveLength(10);
    expect(sessionTokens()).toBeLessThan(before);

    const saved = await persistSession([]);
    expect(saved?.summary.startsWith("Topic: ")).toBe(true);
    expect(useAetherStore.getState().conversations[0].id).toBe(saved?.id);
    // A later save replaces the same record.
    useIntelStore.getState().appendTurn("One more?", "Sure.");
    const again = await persistSession([]);
    expect(again?.id).toBe(saved?.id);
    expect(useAetherStore.getState().conversations.filter((c) => c.id === saved?.id)).toHaveLength(1);
  });

  it("auto-compacts only past the threshold", () => {
    const store = useIntelStore.getState();
    store.appendTurn("short?", "short.");
    expect(shouldAutoCompact()).toBe(false);
    useIntelStore.setState({ settings: { ...DEFAULT_INTEL_SETTINGS, compact_threshold_tokens: 1_000 } });
    for (let i = 0; i < 6; i++) store.appendTurn(...longTurn(i));
    expect(shouldAutoCompact()).toBe(true);
    useIntelStore.setState({ settings: { ...DEFAULT_INTEL_SETTINGS, compact_threshold_tokens: 1_000, auto_compact: false } });
    expect(shouldAutoCompact()).toBe(false);
  });
});

describe("agentChatBus", () => {
  it("opens a saved conversation, compaction summary included", async () => {
    const store = useIntelStore.getState();
    for (let i = 0; i < 4; i++) store.appendTurn(...longTurn(i));
    await compactSession("gemma2:2b", "ollama");
    const saved = await persistSession(["/v/a.md"]);
    startNewConversation();
    expect(useIntelStore.getState().session.messages).toHaveLength(0);
    useAetherStore.setState({ conversations: [], chatOpen: false });

    const opened = await openConversation(saved!.id);
    expect(opened.id).toBe(saved!.id);
    const { session } = useIntelStore.getState();
    expect(session.conversationId).toBe(saved!.id);
    expect(session.messages).toHaveLength(8);
    expect(session.compaction?.summary).toBe(saved!.summary);
    expect(session.compaction?.compactedCount).toBe(8 - DEFAULT_INTEL_SETTINGS.keep_recent_messages);
    expect(useAetherStore.getState().chatOpen).toBe(true);
  });

  it("opens plain conversations and rejects unknown ids or a busy agent", async () => {
    const recent = useAetherStore.getState().conversations;
    expect(recent).toHaveLength(0);
    const { getRecentConversations } = await import("../ipc");
    const [first] = await getRecentConversations(5);
    await openConversation(first.id);
    expect(useIntelStore.getState().session.compaction).toBeNull();
    expect(useIntelStore.getState().session.messages.length).toBeGreaterThan(0);
    await expect(openConversation("missing-id")).rejects.toThrow(/no longer exists/);
    useAetherStore.setState({ busy: true });
    await expect(openConversation(first.id)).rejects.toThrow(/still answering/);
  });
});
