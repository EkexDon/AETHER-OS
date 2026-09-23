import { beforeEach, describe, expect, it } from "vitest";
import type { ActionPreview, AuditEntry, CommandOutput, IntelSettings, RelatedSuggestion } from "../../types";
import { mockInvoke, resetMockState, setMockLatency } from "./backend";
import { intelIntent } from "./agentActions";
import { MOCK_VAULT_ROOT } from "./fixtures/vault";
import { MOCK_PROJECTS_ROOT } from "./fixtures/workspace";
import { cannedSummary, fakeShell } from "./intel";
import { mockVault } from "./vaultStore";

const invoke = <T,>(command: string, args: Record<string, unknown> = {}) => mockInvoke<T>(command, args);
const RUST_NOTE = `${MOCK_VAULT_ROOT}/03-Resources/Rust Ownership.md`;
const REPO = `${MOCK_PROJECTS_ROOT}/aether-demo-app`;

beforeEach(() => {
  setMockLatency(0);
  resetMockState();
});

describe("intel mock handlers", () => {
  it("clamps settings like the Rust engine", async () => {
    const stored = await invoke<IntelSettings>("cmd_intel_set_settings", {
      settings: { auto_compact: false, compact_threshold_tokens: 5, keep_recent_messages: 99, related_suggestions: true, llm_tag_suggestions: false, command_timeout_secs: 9999 },
    });
    expect(stored).toMatchObject({ auto_compact: false, compact_threshold_tokens: 1_000, keep_recent_messages: 20, command_timeout_secs: 300 });
    expect(await invoke<IntelSettings>("cmd_intel_get_settings")).toEqual(stored);
  });

  it("suggests related notes over the mock vault with the keyword fallback", async () => {
    const text = mockVault.read(RUST_NOTE);
    const related = await invoke<RelatedSuggestion[]>("cmd_intel_suggest_related", { text, excludePath: RUST_NOTE, limit: 5 });
    expect(related.length).toBeGreaterThan(0);
    expect(related.every((s) => s.path !== RUST_NOTE)).toBe(true);
    expect(related.every((s) => s.score > 0 && s.score <= 1)).toBe(true);
    const tags = await invoke<string[]>("cmd_intel_suggest_tags", { text: "Planning the move to Berlin and the new apartment" });
    expect(Array.isArray(tags)).toBe(true);
  });

  it("adds tags to the note in the mock vault", async () => {
    const result = await invoke<{ changed: boolean; tag: string }>("cmd_intel_add_tag", {
      path: "Rust Ownership",
      tag: "#memory-safety",
    });
    expect(result).toMatchObject({ changed: true, tag: "memory-safety" });
    expect(mockVault.read(RUST_NOTE)).toContain("tags: [rust, learning, memory-safety]");
    const again = await invoke<{ changed: boolean }>("cmd_intel_add_tag", { path: RUST_NOTE, tag: "Learning" });
    expect(again.changed).toBe(false);
    await expect(invoke("cmd_intel_add_tag", { path: RUST_NOTE, tag: "two words" })).rejects.toMatch(/invalid tag/);
  });

  it("runs fake commands only inside the sandbox roots", async () => {
    const out = await invoke<CommandOutput>("cmd_intel_run_command", { command: "git status", cwd: REPO });
    expect(out.exit_code).toBe(0);
    expect(out.stdout).toMatch(/^On branch /);
    expect(out.cwd).toBe(REPO);
    await expect(invoke("cmd_intel_run_command", { command: "ls", cwd: "/etc" })).rejects.toMatch(/does not exist|outside/);
    await expect(invoke("cmd_intel_run_command", { command: "  ", cwd: null })).rejects.toMatch(/must not be empty/);
    expect(fakeShell("nope", REPO).exit).toBe(127);
  });

  it("commits all changes of a repo and refuses a clean tree", async () => {
    const commit = await invoke<{ commit_id: string; files: string[]; staged_all: boolean }>("cmd_intel_git_commit", {
      projectPath: REPO,
      message: "chore: test",
    });
    expect(commit.commit_id).toHaveLength(40);
    expect(commit.files.length).toBeGreaterThan(0);
    // Keep committing (staged first, then everything) until the tree is clean.
    let error: unknown = null;
    for (let i = 0; i < 4 && error === null; i++) {
      await invoke("cmd_intel_git_commit", { projectPath: REPO, message: `again ${i}` }).catch((e) => {
        error = e;
      });
    }
    expect(String(error)).toMatch(/nothing to commit/);
  });

  it("previews targets and warnings before approval", async () => {
    const preview = await invoke<ActionPreview>("cmd_intel_preview_action", {
      action: { action: "run_command", command: "rm -rf build", cwd: REPO },
    });
    expect(preview.target).toBe(REPO);
    expect(preview.warnings[0]).toMatch(/Deletes files/);
    const missing = await invoke<ActionPreview>("cmd_intel_preview_action", { action: { action: "delete_note", path: "Nope" } });
    expect(missing.error).toMatch(/note not found/);
    const task = await invoke<ActionPreview>("cmd_intel_preview_action", {
      action: { action: "toggle_vault_task", note_path: "Reading List", line: 5 },
    });
    expect(task.details[0]).toMatch(/^Line 5: \[x\] Deep Work/);
  });

  it("audits executed actions and only accepts denials for Rust-audited kinds", async () => {
    await invoke("cmd_intel_audit_clear");
    await invoke("cmd_intel_move_note", { from: "Reading List", to: "04-Archive/" });
    await invoke("cmd_intel_audit_record", { action: { action: "open_url", url: "https://x.dev" }, status: "ok", detail: "Opened" });
    await expect(
      invoke("cmd_intel_audit_record", { action: { action: "move_note", from: "a", to: "b" }, status: "ok", detail: null })
    ).rejects.toMatch(/audited by its own command/);
    await invoke("cmd_intel_audit_record", { action: { action: "delete_note", path: "x" }, status: "denied", detail: null });
    const entries = await invoke<AuditEntry[]>("cmd_intel_audit_list", { limit: 10 });
    expect(entries.map((e) => `${e.action}:${e.status}`)).toEqual(["delete_note:denied", "open_url:ok", "move_note:ok"]);
    expect(entries[2].risk).toBe("confirm");
  });

  it("returns a canned summary after compaction and keeps the recent window", async () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}?` }));
    const result = await invoke<{ summary: string; dropped_count: number; kept_messages: unknown[]; source: string }>(
      "cmd_intel_compact",
      { messages, model: "gemma2:2b", provider: "ollama", keepRecent: 4 }
    );
    expect(result.dropped_count).toBe(4);
    expect(result.kept_messages).toHaveLength(4);
    expect(result.source).toBe("model");
    expect(result.summary).toMatch(/^Topic: /);
    await expect(
      invoke("cmd_intel_compact", { messages: messages.slice(0, 2), model: "m", provider: "ollama", keepRecent: 4 })
    ).rejects.toMatch(/nothing to compact/);
    expect(cannedSummary(null, [])).toMatch(/^Topic: Conversation/);
  });
});

describe("fake LLM intents for gated actions", () => {
  it("maps prompts to the new actions", () => {
    expect(intelIntent("run `git status` in the demo app")?.action).toMatchObject({ action: "run_command", command: "git status", cwd: REPO });
    expect(intelIntent("please run ls")?.action).toMatchObject({ action: "run_command", command: "ls", cwd: null });
    expect(intelIntent("delete the note Quick Capture")?.action).toMatchObject({ action: "delete_note" });
    expect(intelIntent("move Reading List to the archive")?.action).toMatchObject({
      action: "move_note",
      to: "04-Archive/Reading List.md",
    });
    expect(intelIntent('commit my changes with "feat: demo"')?.action).toMatchObject({ action: "git_commit", message: "feat: demo" });
    expect(intelIntent("add a task to call the landlord")?.action).toMatchObject({ action: "create_task", title: "call the landlord" });
    expect(intelIntent("tick off the first task in Reading List")?.action).toMatchObject({ action: "toggle_vault_task" });
    expect(intelIntent("What should I focus on today?")).toBeNull();
    expect(intelIntent("How do I run tests in Rust?")).toBeNull();
  });
});
